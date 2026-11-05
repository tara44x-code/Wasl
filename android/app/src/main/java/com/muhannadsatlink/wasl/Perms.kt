package com.muhannadsatlink.wasl

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import androidx.core.content.ContextCompat
import org.json.JSONObject

/** Which optional permissions are on, so the app and the PC can show what is missing. */
object Perms {
    val CALLS = arrayOf(
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.READ_CALL_LOG,
        Manifest.permission.CALL_PHONE,
        Manifest.permission.ANSWER_PHONE_CALLS,
        Manifest.permission.READ_CONTACTS,
    )
    val SMS = arrayOf(
        Manifest.permission.READ_SMS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.READ_CONTACTS,
    )

    fun has(ctx: Context, p: String) = ContextCompat.checkSelfPermission(ctx, p) == PackageManager.PERMISSION_GRANTED
    fun all(ctx: Context, ps: Array<String>) = ps.all { has(ctx, it) }

    fun summary(ctx: Context): JSONObject = JSONObject()
        .put("notifications", NotifListener.isEnabled(ctx))
        .put("calls", all(ctx, CALLS))
        .put("sms", all(ctx, SMS))
        .put("accessibility", WaslAccessibility.isEnabled(ctx))
        .put("dnd", ctx.getSystemService(NotificationManager::class.java).isNotificationPolicyAccessGranted)
        .put("battery", ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName))
        .put("files", PhoneFiles.allowed(ctx))
        .put("post", Build.VERSION.SDK_INT < 33 || has(ctx, Manifest.permission.POST_NOTIFICATIONS))
}
