package com.muhannadsatlink.wasl

import android.app.Activity
import android.app.PendingIntent
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.service.quicksettings.TileService
import android.widget.Toast
import org.json.JSONObject

/** "Share → Wasl": sends text, links and files to the PC. */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (!Link.connected) {
            Toast.makeText(this, R.string.not_connected, Toast.LENGTH_SHORT).show()
            WaslApp.startService(this)
            finish()
            return
        }
        val uris = ArrayList<Uri>()
        when (intent.action) {
            Intent.ACTION_SEND -> streamExtra(intent)?.let { uris.add(it) }
            Intent.ACTION_SEND_MULTIPLE -> uris.addAll(streamListExtra(intent))
        }
        if (uris.isNotEmpty()) {
            val items = Link.openOutgoing(this, uris)
            Link.sendFiles(items)
            Toast.makeText(this, getString(R.string.sending_files, items.size), Toast.LENGTH_SHORT).show()
        } else {
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
            if (!text.isNullOrEmpty()) {
                Link.post(JSONObject().put("t", "share.text").put("text", text))
                Toast.makeText(this, R.string.sent, Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }

    @Suppress("DEPRECATION")
    private fun streamExtra(i: Intent): Uri? =
        if (Build.VERSION.SDK_INT >= 33) i.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else i.getParcelableExtra(Intent.EXTRA_STREAM)

    @Suppress("DEPRECATION")
    private fun streamListExtra(i: Intent): List<Uri> =
        (if (Build.VERSION.SDK_INT >= 33) i.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else i.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)) ?: emptyList()
}

/**
 * Sends the clipboard to the PC. Android only lets the focused app read the
 * clipboard, so this invisible activity takes focus for a moment.
 */
class ClipActivity : Activity() {
    private var done = false

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus || done) return
        done = true
        val cm = getSystemService(ClipboardManager::class.java)
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
        when {
            !Link.connected -> Toast.makeText(this, R.string.not_connected, Toast.LENGTH_SHORT).show()
            text.isNullOrEmpty() -> Toast.makeText(this, R.string.clip_empty, Toast.LENGTH_SHORT).show()
            else -> {
                Link.post(JSONObject().put("t", "clip").put("text", text).put("manual", true))
                Toast.makeText(this, R.string.sent, Toast.LENGTH_SHORT).show()
            }
        }
        finish()
    }
}

/** Quick Settings tile: one tap sends the clipboard to the PC. */
class ClipTile : TileService() {
    override fun onStartListening() {
        qsTile?.let {
            it.icon = Icon.createWithResource(this, R.drawable.ic_stat_wasl)
            it.state = if (Link.connected) android.service.quicksettings.Tile.STATE_ACTIVE else android.service.quicksettings.Tile.STATE_INACTIVE
            it.updateTile()
        }
    }

    @Suppress("DEPRECATION")
    override fun onClick() {
        val intent = Intent(this, ClipActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 3, intent, PendingIntent.FLAG_IMMUTABLE))
        } else {
            startActivityAndCollapse(intent)
        }
    }
}
