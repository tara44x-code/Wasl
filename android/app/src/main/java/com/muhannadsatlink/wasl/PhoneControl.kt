package com.muhannadsatlink.wasl

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.service.notification.NotificationListenerService
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Quick controls the PC can use: Do not disturb, torch, ringer, volume, lock. */
object PhoneControl {
    private val main = Handler(Looper.getMainLooper())
    private var torchOn = false
    private var torchId: String? = null
    private var receiver: BroadcastReceiver? = null
    private var torchCallback: CameraManager.TorchCallback? = null
    private var pending: Runnable? = null

    fun attach(ctx: Context) = main.post {
        val app = ctx.applicationContext
        val cam = app.getSystemService(CameraManager::class.java)
        try {
            torchId = cam.cameraIdList.firstOrNull {
                cam.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            }
            val cb = object : CameraManager.TorchCallback() {
                override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                    if (cameraId == torchId) {
                        torchOn = enabled
                        sendSoon(app)
                    }
                }
            }
            cam.registerTorchCallback(cb, main)
            torchCallback = cb
        } catch (_: Exception) {
        }
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) = sendSoon(app)
        }
        val f = IntentFilter().apply {
            addAction(AudioManager.RINGER_MODE_CHANGED_ACTION)
            addAction("android.media.VOLUME_CHANGED_ACTION")
            addAction(NotificationManager.ACTION_INTERRUPTION_FILTER_CHANGED)
        }
        ContextCompat.registerReceiver(app, r, f, ContextCompat.RECEIVER_EXPORTED)
        receiver = r
        sendSoon(app)
    }

    fun detach(ctx: Context) = main.post {
        val app = ctx.applicationContext
        receiver?.let { try { app.unregisterReceiver(it) } catch (_: Exception) {} }
        receiver = null
        torchCallback?.let { try { app.getSystemService(CameraManager::class.java).unregisterTorchCallback(it) } catch (_: Exception) {} }
        torchCallback = null
    }

    /** Coalesces bursts of change broadcasts into one status message. */
    fun sendSoon(ctx: Context) {
        pending?.let { main.removeCallbacks(it) }
        val r = Runnable { Link.post(status(ctx)) }
        pending = r
        main.postDelayed(r, 250)
    }

    fun status(ctx: Context): JSONObject {
        val am = ctx.getSystemService(AudioManager::class.java)
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val ringer = when (am.ringerMode) {
            AudioManager.RINGER_MODE_SILENT -> "silent"
            AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            else -> "normal"
        }
        return JSONObject()
            .put("t", "status")
            .put("dnd", nm.currentInterruptionFilter > NotificationManager.INTERRUPTION_FILTER_ALL)
            .put("dndAllowed", NotifListener.isConnected() || nm.isNotificationPolicyAccessGranted)
            .put("torch", torchOn)
            .put("hasTorch", torchId != null)
            .put("ringer", ringer)
            .put("volMusic", am.getStreamVolume(AudioManager.STREAM_MUSIC))
            .put("volMusicMax", am.getStreamMaxVolume(AudioManager.STREAM_MUSIC))
            .put("volRing", am.getStreamVolume(AudioManager.STREAM_RING))
            .put("volRingMax", am.getStreamMaxVolume(AudioManager.STREAM_RING))
            .put("canLock", Build.VERSION.SDK_INT >= 28 && WaslAccessibility.running)
            .put("perms", Perms.summary(ctx))
    }

    fun handle(ctx: Context, msg: JSONObject) = main.post {
        val app = ctx.applicationContext
        try {
            when (msg.optString("t")) {
                "toggle" -> toggle(app, msg.optString("what"), msg.opt("value"))
                "volume.set" -> {
                    val am = app.getSystemService(AudioManager::class.java)
                    val stream = if (msg.optString("stream") == "ring") AudioManager.STREAM_RING else AudioManager.STREAM_MUSIC
                    val v = msg.optInt("value").coerceIn(0, am.getStreamMaxVolume(stream))
                    am.setStreamVolume(stream, v, 0)
                }
            }
        } catch (_: Exception) {
        }
        sendSoon(app)
    }

    private fun toggle(ctx: Context, what: String, value: Any?) {
        when (what) {
            "torch" -> {
                val id = torchId ?: return
                ctx.getSystemService(CameraManager::class.java).setTorchMode(id, value as? Boolean ?: !torchOn)
            }
            "dnd" -> {
                val on = value as? Boolean ?: true
                val filter = if (on) NotificationListenerService.INTERRUPTION_FILTER_PRIORITY else NotificationListenerService.INTERRUPTION_FILTER_ALL
                if (!NotifListener.setInterruptionFilter(filter)) {
                    val nm = ctx.getSystemService(NotificationManager::class.java)
                    if (nm.isNotificationPolicyAccessGranted) {
                        nm.setInterruptionFilter(if (on) NotificationManager.INTERRUPTION_FILTER_PRIORITY else NotificationManager.INTERRUPTION_FILTER_ALL)
                    }
                }
            }
            "ringer" -> {
                val am = ctx.getSystemService(AudioManager::class.java)
                val mode = when (value as? String) {
                    "silent" -> AudioManager.RINGER_MODE_SILENT
                    "vibrate" -> AudioManager.RINGER_MODE_VIBRATE
                    else -> AudioManager.RINGER_MODE_NORMAL
                }
                try {
                    am.ringerMode = mode
                } catch (e: SecurityException) {
                    if (mode == AudioManager.RINGER_MODE_SILENT) am.ringerMode = AudioManager.RINGER_MODE_VIBRATE
                }
            }
            "lock" -> WaslAccessibility.lock()
        }
    }
}
