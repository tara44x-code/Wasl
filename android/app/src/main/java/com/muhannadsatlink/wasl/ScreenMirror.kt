package com.muhannadsatlink.wasl

import android.app.Activity
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.view.Display
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject
import kotlin.concurrent.thread

/**
 * Screen mirroring without USB debugging: Android's screen capture (the user
 * agrees each time) encoded to H.264 and sent over the encrypted Wasl link.
 * Touch input comes back through WaslAccessibility.
 */
object ScreenMirror {
    @Volatile var running = false
        private set
    var maxSize = 1600
    var bitRate = 6_000_000
    private val main = Handler(Looper.getMainLooper())

    fun handle(ctx: Context, msg: JSONObject) {
        val app = ctx.applicationContext
        when (msg.optString("t")) {
            "scr.start" -> {
                maxSize = msg.optInt("maxSize", 1600).let { if (it <= 0) 4096 else it.coerceIn(480, 4096) }
                bitRate = msg.optInt("bitRate", 6_000_000).coerceIn(1_000_000, 20_000_000)
                if (running) {
                    MirrorService.requestKeyFrame()
                    MirrorService.sendState()
                } else {
                    askConsent(app)
                }
            }
            "scr.stop" -> app.stopService(Intent(app, MirrorService::class.java))
            "scr.key" -> MirrorService.requestKeyFrame()
            "scr.gesture" -> {
                val pts = msg.optJSONArray("points") ?: return
                val w = msg.optDouble("w", 1.0)
                val h = msg.optDouble("h", 1.0)
                val sx = MirrorService.screenW / w
                val sy = MirrorService.screenH / h
                val list = ArrayList<Pair<Float, Float>>()
                for (i in 0 until pts.length()) {
                    val p = pts.optJSONArray(i) ?: continue
                    list.add((p.optDouble(0) * sx).toFloat() to (p.optDouble(1) * sy).toFloat())
                }
                val duration = msg.optLong("duration", 50)
                main.post { WaslAccessibility.gesture(list, duration) }
            }
        }
    }

    private fun askConsent(ctx: Context) {
        Link.post(JSONObject().put("t", "scr.state").put("state", "consent").put("a11y", WaslAccessibility.running))
        val intent = Intent(ctx, MirrorConsentActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Works while the app is in front; otherwise the notification below opens it.
        try { ctx.startActivity(intent) } catch (_: Exception) {}
        val pi = PendingIntent.getActivity(ctx, 11, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(ctx, WaslApp.CH_RING)
            .setSmallIcon(R.drawable.ic_stat_wasl)
            .setContentTitle(ctx.getString(R.string.mirror_ask_title))
            .setContentText(ctx.getString(R.string.mirror_ask_body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi)
            .build()
        try { ctx.getSystemService(NotificationManager::class.java).notify(CONSENT_NOTIF, n) } catch (_: SecurityException) {}
    }

    const val CONSENT_NOTIF = 12

    internal fun setRunning(v: Boolean) {
        running = v
    }
}

/** Asks Android for permission to capture the screen. */
class MirrorConsentActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getSystemService(NotificationManager::class.java).cancel(ScreenMirror.CONSENT_NOTIF)
        val mpm = getSystemService(MediaProjectionManager::class.java)
        @Suppress("DEPRECATION")
        startActivityForResult(mpm.createScreenCaptureIntent(), 1)
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode == RESULT_OK && data != null) {
            val i = Intent(this, MirrorService::class.java)
                .putExtra("code", resultCode)
                .putExtra("data", data)
            startForegroundService(i)
        } else {
            Link.post(JSONObject().put("t", "scr.state").put("state", "denied"))
        }
        finish()
    }
}

class MirrorService : Service() {
    private var projection: MediaProjection? = null
    private var display: VirtualDisplay? = null
    private var codec: MediaCodec? = null
    private var worker: Thread? = null
    @Volatile private var stopped = false
    private val main = Handler(Looper.getMainLooper())
    private var rotation = -1

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = NotificationCompat.Builder(this, WaslApp.CH_SERVICE)
            .setSmallIcon(R.drawable.ic_stat_wasl)
            .setContentTitle(getString(R.string.mirror_running))
            .setOngoing(true)
            .setSilent(true)
            .addAction(
                0, getString(R.string.stop),
                PendingIntent.getService(this, 13, Intent(this, MirrorService::class.java).setAction("stop"), PendingIntent.FLAG_IMMUTABLE),
            )
            .build()
        val type = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0
        ServiceCompat.startForeground(this, NOTIF_ID, n, type)
        if (intent?.action == "stop") {
            stopSelf()
            return START_NOT_STICKY
        }
        if (projection != null) return START_NOT_STICKY
        val code = intent?.getIntExtra("code", 0) ?: 0
        @Suppress("DEPRECATION")
        val data: Intent? = if (Build.VERSION.SDK_INT >= 33) intent?.getParcelableExtra("data", Intent::class.java) else intent?.getParcelableExtra("data")
        if (data == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val p = mpm.getMediaProjection(code, data)
        if (p == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        projection = p
        p.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                main.post { stopSelf() }
            }
        }, main)
        instance = this
        ScreenMirror.setRunning(true)
        startCapture()
        watchRotation()
        return START_NOT_STICKY
    }

    private fun screenSize(): Pair<Int, Int> {
        val dm = getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        dm.getRealMetrics(metrics)
        return metrics.widthPixels to metrics.heightPixels
    }

    private fun startCapture() {
        val (sw, sh) = screenSize()
        screenW = sw
        screenH = sh
        val scale = minOf(1.0, ScreenMirror.maxSize.toDouble() / maxOf(sw, sh))
        val w = ((sw * scale).toInt() / 8) * 8
        val h = ((sh * scale).toInt() / 8) * 8
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, w, h).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, ScreenMirror.bitRate)
            setInteger(MediaFormat.KEY_FRAME_RATE, 60)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 10)
            setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
        }
        val c = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surface = c.createInputSurface()
        c.start()
        codec = c
        val dpi = resources.displayMetrics.densityDpi
        val d = display
        if (d == null) {
            // Android 14+ allows only one virtual display per capture session, so it is reused on rotation.
            display = projection?.createVirtualDisplay("Wasl", w, h, dpi, DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, surface, null, null)
        } else {
            d.resize(w, h, dpi)
            d.surface = surface
        }
        Link.post(JSONObject().put("t", "scr.state").put("state", "running").put("w", w).put("h", h).put("a11y", WaslAccessibility.running))
        stopped = false
        worker = thread(name = "wasl-encoder") { drain(c) }
    }

    private fun drain(c: MediaCodec) {
        val info = MediaCodec.BufferInfo()
        try {
            while (!stopped) {
                val idx = c.dequeueOutputBuffer(info, 100_000)
                if (idx < 0) continue
                val buf = c.getOutputBuffer(idx)
                if (buf != null && info.size > 0) {
                    val bytes = ByteArray(info.size)
                    buf.position(info.offset)
                    buf.get(bytes, 0, info.size)
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    val key = info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME != 0
                    Link.sendNow(
                        JSONObject().put("t", "scr.video").put("config", config).put("key", key).put("pts", info.presentationTimeUs),
                        bytes,
                    )
                }
                c.releaseOutputBuffer(idx, false)
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) break
            }
        } catch (_: Exception) {
        }
    }

    private fun stopEncoder() {
        stopped = true
        display?.surface = null
        worker?.join(500)
        worker = null
        try { codec?.stop() } catch (_: Exception) {}
        try { codec?.release() } catch (_: Exception) {}
        codec = null
    }

    private fun stopCapture() {
        stopEncoder()
        display?.release()
        display = null
    }

    private fun watchRotation() {
        val dm = getSystemService(DisplayManager::class.java)
        rotation = dm.getDisplay(Display.DEFAULT_DISPLAY).rotation
        main.postDelayed(object : Runnable {
            override fun run() {
                if (projection == null) return
                val r = dm.getDisplay(Display.DEFAULT_DISPLAY).rotation
                if (r != rotation) {
                    rotation = r
                    stopEncoder()
                    startCapture()
                }
                main.postDelayed(this, 500)
            }
        }, 500)
    }

    override fun onDestroy() {
        stopCapture()
        projection?.stop()
        projection = null
        main.removeCallbacksAndMessages(null)
        if (instance === this) instance = null
        ScreenMirror.setRunning(false)
        Link.post(JSONObject().put("t", "scr.state").put("state", "stopped"))
        super.onDestroy()
    }

    companion object {
        const val NOTIF_ID = 14
        @Volatile private var instance: MirrorService? = null
        @Volatile var screenW = 1080
        @Volatile var screenH = 2400

        fun requestKeyFrame() {
            val c = instance?.codec ?: return
            try {
                c.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
            } catch (_: Exception) {
            }
        }

        fun sendState() {
            val s = instance ?: return
            s.main.post {
                val (w, h) = s.screenSize()
                val scale = minOf(1.0, ScreenMirror.maxSize.toDouble() / maxOf(w, h))
                Link.post(
                    JSONObject().put("t", "scr.state").put("state", "running")
                        .put("w", ((w * scale).toInt() / 8) * 8).put("h", ((h * scale).toInt() / 8) * 8)
                        .put("a11y", WaslAccessibility.running),
                )
            }
        }
    }
}
