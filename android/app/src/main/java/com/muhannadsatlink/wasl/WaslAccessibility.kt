package com.muhannadsatlink.wasl

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.os.Build
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent

/**
 * Lets the PC lock the screen and, when mirroring without USB debugging,
 * tap, swipe and press Back/Home on the phone. It reads nothing on screen.
 */
class WaslAccessibility : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
        PhoneControl.sendSoon(this)
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        if (instance === this) instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    companion object {
        @Volatile private var instance: WaslAccessibility? = null
        val running: Boolean get() = instance != null

        fun lock(): Boolean {
            val s = instance ?: return false
            return Build.VERSION.SDK_INT >= 28 && s.performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
        }

        fun global(name: String): Boolean {
            val s = instance ?: return false
            val action = when (name) {
                "back" -> GLOBAL_ACTION_BACK
                "home" -> GLOBAL_ACTION_HOME
                "recents" -> GLOBAL_ACTION_RECENTS
                "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
                "quick" -> GLOBAL_ACTION_QUICK_SETTINGS
                "power" -> GLOBAL_ACTION_POWER_DIALOG
                else -> return false
            }
            return s.performGlobalAction(action)
        }

        /** A tap, long press or swipe in screen pixels. */
        fun gesture(points: List<Pair<Float, Float>>, durationMs: Long): Boolean {
            val s = instance ?: return false
            if (points.isEmpty()) return false
            val path = Path().apply {
                moveTo(points[0].first.coerceAtLeast(0f), points[0].second.coerceAtLeast(0f))
                for (p in points.drop(1)) lineTo(p.first.coerceAtLeast(0f), p.second.coerceAtLeast(0f))
            }
            val stroke = GestureDescription.StrokeDescription(path, 0, durationMs.coerceIn(1, 10_000))
            return s.dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
        }

        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            val me = ComponentName(ctx, WaslAccessibility::class.java).flattenToString()
            return flat.split(':').any { it.equals(me, ignoreCase = true) }
        }
    }
}
