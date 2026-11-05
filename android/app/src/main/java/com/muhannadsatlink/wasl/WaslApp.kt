package com.muhannadsatlink.wasl

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

class WaslApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_SERVICE, getString(R.string.ch_service), NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(NotificationChannel(CH_FILES, getString(R.string.ch_files), NotificationManager.IMPORTANCE_DEFAULT))
        nm.createNotificationChannel(
            NotificationChannel(CH_RING, getString(R.string.ch_ring), NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(null, null)
            },
        )
        Link.init(this)
    }

    companion object {
        const val CH_SERVICE = "service"
        const val CH_FILES = "files"
        const val CH_RING = "ring"

        /** Starts the background connection if a PC is paired and the user wants it. */
        fun startService(ctx: Context) {
            val prefs = Prefs(ctx)
            if (prefs.pairing == null || !prefs.enabled) return
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, LinkService::class.java))
            } catch (e: Exception) {
                // Starting from the background can be refused; the app starts it next time it opens.
            }
        }
    }
}
