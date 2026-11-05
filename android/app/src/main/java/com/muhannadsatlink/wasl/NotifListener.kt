package com.muhannadsatlink.wasl

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

/** Mirrors the phone's notifications to the PC, and acts on them for the PC. */
class NotifListener : NotificationListenerService() {

    override fun onListenerConnected() {
        instance = this
        if (Link.connected) Media.attach(this)
        if (Link.connected && Link.prefs.sendNotifications) sendSnapshot()
    }

    override fun onListenerDisconnected() {
        if (instance === this) instance = null
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (!Link.connected || !Link.prefs.sendNotifications || !wanted(sbn)) return
        val json = toJson(sbn) ?: return
        val sig = "${json.optString("title")}\u0000${json.optString("text")}\u0000${json.optJSONArray("actions")?.length()}"
        if (lastSent[sbn.key] == sig) return
        lastSent[sbn.key] = sig
        Link.post(json.put("t", "notif.posted"))
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification) {
        lastSent.remove(sbn.key)
        if (!Link.connected || !Link.prefs.sendNotifications) return
        Link.post(JSONObject().put("t", "notif.removed").put("key", sbn.key))
    }

    private fun wanted(sbn: StatusBarNotification): Boolean {
        val n = sbn.notification
        if (sbn.packageName == packageName) return false
        if (sbn.packageName in Link.prefs.mutedApps) return false
        if (sbn.isOngoing) return false
        if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return false
        if (n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0) return false
        val e = n.extras
        val title = e.getCharSequence(Notification.EXTRA_TITLE)
        val text = e.getCharSequence(Notification.EXTRA_TEXT)
        return !(title.isNullOrBlank() && text.isNullOrBlank())
    }

    private fun toJson(sbn: StatusBarNotification): JSONObject? = try {
        val n = sbn.notification
        val e = n.extras
        val title = e.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        val text = (e.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: e.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        val actions = JSONArray()
        n.actions?.forEachIndexed { i, a ->
            val title2 = a.title?.toString() ?: return@forEachIndexed
            val reply = a.remoteInputs?.any { it.allowFreeFormInput } == true
            actions.put(JSONObject().put("i", i).put("title", title2).put("reply", reply))
        }
        JSONObject()
            .put("key", sbn.key)
            .put("pkg", sbn.packageName)
            .put("app", appLabel(sbn.packageName))
            .put("title", title.take(300))
            .put("text", text.take(4000))
            .put("time", sbn.postTime)
            .put("icon", appIcon(sbn.packageName))
            .put("actions", actions)
    } catch (e: Exception) {
        null
    }

    private fun appLabel(pkg: String): String = labels.getOrPut(pkg) {
        try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (e: Exception) {
            pkg
        }
    }

    private fun appIcon(pkg: String): String = icons.getOrPut(pkg) {
        try {
            val d = packageManager.getApplicationIcon(pkg)
            val bmp = Bitmap.createBitmap(72, 72, Bitmap.Config.ARGB_8888)
            val c = Canvas(bmp)
            d.setBounds(0, 0, 72, 72)
            d.draw(c)
            val out = ByteArrayOutputStream()
            bmp.compress(Bitmap.CompressFormat.PNG, 100, out)
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (e: Exception) {
            ""
        }
    }

    private fun snapshot() {
        val items = JSONArray()
        val active = try { activeNotifications } catch (e: Exception) { null } ?: return
        lastSent.clear()
        for (sbn in active.sortedByDescending { it.postTime }.take(60)) {
            if (!wanted(sbn)) continue
            val j = toJson(sbn) ?: continue
            lastSent[sbn.key] = "${j.optString("title")}\u0000${j.optString("text")}\u0000${j.optJSONArray("actions")?.length()}"
            items.put(j)
        }
        Link.post(JSONObject().put("t", "notif.snapshot").put("items", items))
    }

    private fun doAction(key: String, index: Int, reply: String?) {
        val sbn = try { activeNotifications?.firstOrNull { it.key == key } } catch (e: Exception) { null } ?: return
        val action = sbn.notification.actions?.getOrNull(index) ?: return
        try {
            val inputs = action.remoteInputs
            if (reply != null && inputs != null && inputs.isNotEmpty()) {
                val intent = Intent()
                val results = Bundle()
                for (ri in inputs) results.putCharSequence(ri.resultKey, reply)
                RemoteInput.addResultsToIntent(inputs, intent, results)
                action.actionIntent.send(this, 0, intent)
            } else {
                action.actionIntent.send()
            }
        } catch (_: Exception) {
        }
    }

    companion object {
        @Volatile private var instance: NotifListener? = null
        private val main = Handler(Looper.getMainLooper())
        private val labels = ConcurrentHashMap<String, String>()
        private val icons = ConcurrentHashMap<String, String>()
        private val lastSent = ConcurrentHashMap<String, String>()

        fun sendSnapshot() = main.post { instance?.snapshot() }

        fun isConnected() = instance != null

        /** Do not disturb through the listener, which needs no extra permission. */
        fun setInterruptionFilter(filter: Int): Boolean {
            val s = instance ?: return false
            return try {
                s.requestInterruptionFilter(filter)
                true
            } catch (e: Exception) {
                false
            }
        }

        fun dismiss(key: String) = main.post {
            try { instance?.cancelNotification(key) } catch (_: Exception) {}
        }

        fun act(key: String, index: Int, reply: String?) = main.post { instance?.doAction(key, index, reply) }

        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            val me = ComponentName(ctx, NotifListener::class.java).flattenToString()
            return flat.split(':').any { it == me }
        }
    }
}
