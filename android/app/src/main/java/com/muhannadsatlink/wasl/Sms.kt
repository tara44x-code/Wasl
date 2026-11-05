package com.muhannadsatlink.wasl

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Text messages: conversations, a thread, sending and new-message alerts. */
object Sms {
    private fun has(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    fun handle(ctx: Context, msg: JSONObject) {
        try {
            when (msg.optString("t")) {
                "sms.threads.request" -> Link.post(threads(ctx))
                "sms.thread.request" -> Link.post(thread(ctx, msg.optLong("thread")))
                "sms.send" -> send(ctx, msg.optString("address"), msg.optString("body"), msg.optString("ref"))
            }
        } catch (_: Exception) {
        }
    }

    private val names = HashMap<String, String>()
    private fun name(ctx: Context, address: String) = names.getOrPut(address) { Calls.contactName(ctx, address) }

    private fun threads(ctx: Context): JSONObject {
        val out = JSONObject().put("t", "sms.threads").put("allowed", has(ctx, Manifest.permission.READ_SMS))
        val items = JSONArray()
        if (has(ctx, Manifest.permission.READ_SMS)) {
            val seen = LinkedHashMap<Long, JSONObject>()
            val unread = HashMap<Long, Int>()
            ctx.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms.THREAD_ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.READ, Telephony.Sms.TYPE),
                null, null, Telephony.Sms.DATE + " DESC",
            )?.use { c ->
                var rows = 0
                while (c.moveToNext() && rows++ < 3000) {
                    val tid = c.getLong(0)
                    if (c.getInt(4) == 0 && c.getInt(5) == Telephony.Sms.MESSAGE_TYPE_INBOX) unread[tid] = (unread[tid] ?: 0) + 1
                    if (seen.containsKey(tid) || seen.size >= 150) continue
                    val address = c.getString(1) ?: ""
                    seen[tid] = JSONObject()
                        .put("thread", tid)
                        .put("address", address)
                        .put("name", name(ctx, address))
                        .put("snippet", (c.getString(2) ?: "").take(200))
                        .put("date", c.getLong(3))
                        .put("out", c.getInt(5) != Telephony.Sms.MESSAGE_TYPE_INBOX)
                }
            }
            for ((tid, j) in seen) items.put(j.put("unread", unread[tid] ?: 0))
        }
        return out.put("items", items)
    }

    private fun thread(ctx: Context, tid: Long): JSONObject {
        val items = JSONArray()
        var address = ""
        if (has(ctx, Manifest.permission.READ_SMS)) {
            ctx.contentResolver.query(
                Telephony.Sms.CONTENT_URI,
                arrayOf(Telephony.Sms._ID, Telephony.Sms.ADDRESS, Telephony.Sms.BODY, Telephony.Sms.DATE, Telephony.Sms.TYPE),
                Telephony.Sms.THREAD_ID + "=?", arrayOf(tid.toString()), Telephony.Sms.DATE + " DESC",
            )?.use { c ->
                while (c.moveToNext() && items.length() < 300) {
                    if (address.isEmpty()) address = c.getString(1) ?: ""
                    items.put(
                        JSONObject()
                            .put("id", c.getLong(0))
                            .put("body", c.getString(2) ?: "")
                            .put("date", c.getLong(3))
                            .put("out", c.getInt(4) != Telephony.Sms.MESSAGE_TYPE_INBOX),
                    )
                }
            }
        }
        return JSONObject().put("t", "sms.thread").put("thread", tid).put("address", address)
            .put("name", name(ctx, address)).put("items", items)
    }

    private fun send(ctx: Context, address: String, body: String, ref: String) {
        var ok = false
        if (address.isNotBlank() && body.isNotEmpty() && has(ctx, Manifest.permission.SEND_SMS)) {
            try {
                val sm = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
                val parts = sm.divideMessage(body)
                if (parts.size > 1) sm.sendMultipartTextMessage(address, null, parts, null, null)
                else sm.sendTextMessage(address, null, body, null, null)
                ok = true
            } catch (_: Exception) {
            }
        }
        Link.post(JSONObject().put("t", "sms.sent").put("address", address).put("ok", ok).put("ref", ref))
    }

    /** From the SMS_RECEIVED broadcast. */
    fun onReceived(ctx: Context, intent: Intent) {
        val parts = try { Telephony.Sms.Intents.getMessagesFromIntent(intent) } catch (e: Exception) { null } ?: return
        if (parts.isEmpty()) return
        val address = parts[0].originatingAddress ?: ""
        val body = parts.joinToString("") { it.messageBody ?: "" }
        Link.post(
            JSONObject()
                .put("t", "sms.new")
                .put("address", address)
                .put("name", name(ctx, address))
                .put("body", body)
                .put("date", System.currentTimeMillis()),
        )
    }
}

class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.SMS_RECEIVED_ACTION && Link.connected) Sms.onReceived(context, intent)
    }
}
