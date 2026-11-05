package com.muhannadsatlink.wasl

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.CallLog
import android.provider.ContactsContract
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Incoming call alerts, answering and declining, dialling, call log and contacts. */
object Calls {
    private var lastState = ""
    private var lastNumber = ""

    private fun has(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED

    fun contactName(ctx: Context, number: String): String {
        if (number.isEmpty() || !has(ctx, Manifest.permission.READ_CONTACTS)) return ""
        return try {
            val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
            ctx.contentResolver.query(uri, arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst()) c.getString(0) ?: "" else ""
            } ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    /** From the PHONE_STATE broadcast. */
    fun onPhoneState(ctx: Context, intent: Intent) {
        val state = when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> "ringing"
            TelephonyManager.EXTRA_STATE_OFFHOOK -> "offhook"
            else -> "idle"
        }
        @Suppress("DEPRECATION")
        val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: ""
        if (number.isNotEmpty()) lastNumber = number
        // Android sends the broadcast twice (with and without the number); skip the duplicate.
        val key = "$state|$lastNumber"
        if (key == lastState) return
        lastState = key
        val n = if (state == "idle") lastNumber.also { lastNumber = "" } else lastNumber
        Link.post(
            JSONObject()
                .put("t", "call")
                .put("state", state)
                .put("number", n)
                .put("name", contactName(ctx, n)),
        )
    }

    @SuppressLint("MissingPermission")
    @Suppress("DEPRECATION")
    fun handle(ctx: Context, msg: JSONObject) {
        val tm = ctx.getSystemService(TelecomManager::class.java)
        try {
            when (msg.optString("t")) {
                "call.cmd" -> when (msg.optString("cmd")) {
                    "answer" -> if (has(ctx, Manifest.permission.ANSWER_PHONE_CALLS)) tm.acceptRingingCall()
                    "decline", "end" -> if (Build.VERSION.SDK_INT >= 28 && has(ctx, Manifest.permission.ANSWER_PHONE_CALLS)) tm.endCall()
                }
                "call.dial" -> {
                    val number = msg.optString("number").filter { it.isDigit() || it in "+*#" }
                    if (number.isNotEmpty() && has(ctx, Manifest.permission.CALL_PHONE)) {
                        tm.placeCall(Uri.fromParts("tel", number, null), Bundle())
                    }
                }
                "calllog.request" -> Link.post(callLog(ctx))
                "contacts.request" -> Link.post(contacts(ctx))
            }
        } catch (_: Exception) {
        }
    }

    private fun callLog(ctx: Context): JSONObject {
        val items = JSONArray()
        if (has(ctx, Manifest.permission.READ_CALL_LOG)) {
            ctx.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION),
                null, null, CallLog.Calls.DATE + " DESC",
            )?.use { c ->
                while (c.moveToNext() && items.length() < 100) {
                    val type = when (c.getInt(2)) {
                        CallLog.Calls.INCOMING_TYPE -> "in"
                        CallLog.Calls.OUTGOING_TYPE -> "out"
                        CallLog.Calls.MISSED_TYPE -> "missed"
                        CallLog.Calls.REJECTED_TYPE -> "rejected"
                        else -> "other"
                    }
                    items.put(
                        JSONObject()
                            .put("number", c.getString(0) ?: "")
                            .put("name", c.getString(1) ?: "")
                            .put("type", type)
                            .put("date", c.getLong(3))
                            .put("duration", c.getLong(4)),
                    )
                }
            }
        }
        return JSONObject().put("t", "calllog").put("items", items).put("allowed", has(ctx, Manifest.permission.READ_CALL_LOG))
    }

    private fun contacts(ctx: Context): JSONObject {
        val byName = LinkedHashMap<String, JSONArray>()
        if (has(ctx, Manifest.permission.READ_CONTACTS)) {
            ctx.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
                null, null, ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " COLLATE LOCALIZED ASC",
            )?.use { c ->
                while (c.moveToNext() && byName.size < 3000) {
                    val name = c.getString(0) ?: continue
                    val num = c.getString(1) ?: continue
                    val arr = byName.getOrPut(name) { JSONArray() }
                    if (arr.length() < 5) arr.put(num)
                }
            }
        }
        val items = JSONArray()
        for ((name, nums) in byName) items.put(JSONObject().put("name", name).put("numbers", nums))
        return JSONObject().put("t", "contacts").put("items", items)
    }
}

class CallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == TelephonyManager.ACTION_PHONE_STATE_CHANGED && Link.connected) {
            Calls.onPhoneState(context, intent)
        }
    }
}
