package com.muhannadsatlink.wasl

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/** "Find my phone": rings loudly, even on silent, until stopped or for a minute. */
object Ringer {
    private const val NOTIF_ID = 7
    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var savedVolume = -1
    private val autoStop = Runnable { stopNow(appCtx ?: return@Runnable, true) }
    private var appCtx: Context? = null

    fun start(ctx: Context) = main.post { startNow(ctx.applicationContext) }

    fun stop(ctx: Context, report: Boolean = true) = main.post { stopNow(ctx.applicationContext, report) }

    private fun startNow(ctx: Context) {
        appCtx = ctx
        if (player != null) return
        val am = ctx.getSystemService(AudioManager::class.java)
        savedVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
        am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
        val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(ctx, uri)
                isLooping = true
                prepare()
                start()
            }
        } catch (e: Exception) {
            player = null
        }
        val vib = ctx.getSystemService(Vibrator::class.java)
        vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 600, 400), 0))

        val stopIntent = PendingIntent.getBroadcast(
            ctx, 1, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.STOP_RING),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(ctx, WaslApp.CH_RING)
            .setSmallIcon(R.drawable.ic_stat_wasl)
            .setContentTitle(ctx.getString(R.string.ch_ring))
            .setContentText(ctx.getString(R.string.ringing))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setOngoing(true)
            .setContentIntent(stopIntent)
            .addAction(0, ctx.getString(R.string.stop), stopIntent)
            .build()
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(NOTIF_ID, n)
        } catch (_: SecurityException) {
        }
        main.postDelayed(autoStop, 60_000)
        Link.post(JSONObject().put("t", "ring.state").put("on", true))
    }

    private fun stopNow(ctx: Context, report: Boolean) {
        main.removeCallbacks(autoStop)
        val wasRinging = player != null || savedVolume >= 0
        player?.let {
            try { it.stop() } catch (_: Exception) {}
            it.release()
        }
        player = null
        ctx.getSystemService(Vibrator::class.java)?.cancel()
        if (savedVolume >= 0) {
            ctx.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, savedVolume, 0)
            savedVolume = -1
        }
        ctx.getSystemService(NotificationManager::class.java).cancel(NOTIF_ID)
        if (report && wasRinging) Link.post(JSONObject().put("t", "ring.state").put("on", false))
    }
}

class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            STOP_RING -> Ringer.stop(context)
            INSTALL_STATUS -> Updater.onStatus(context, intent)
        }
    }

    companion object {
        const val STOP_RING = "com.muhannadsatlink.wasl.STOP_RING"
        const val INSTALL_STATUS = "com.muhannadsatlink.wasl.INSTALL_STATUS"
    }
}
