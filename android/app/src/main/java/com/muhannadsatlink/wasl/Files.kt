package com.muhannadsatlink.wasl

import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap

/** Files in both directions; received files go to Downloads/Wasl. */
class Files(private val ctx: Context) {

    class Outgoing(val name: String, val size: Long, val stream: InputStream)

    private class Incoming(
        val id: String,
        val name: String,
        val size: Long,
        val uri: Uri?,
        val file: File?,
        val out: OutputStream,
        val digest: MessageDigest = MessageDigest.getInstance("SHA-256"),
        var got: Long = 0,
        var lastUpdate: Long = 0,
    )

    private val incoming = ConcurrentHashMap<String, Incoming>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()

    // ---- state shown in the app --------------------------------------------

    private fun publish(v: TransferView) {
        Link.update { s ->
            val rest = s.transfers.filter { it.id != v.id }
            s.copy(transfers = (listOf(v) + rest).take(30))
        }
    }

    fun cancel(id: String) {
        cancelled.add(id)
        incoming[id]?.let {
            fail(it, "cancelled")
            Link.post(JSONObject().put("t", "file.cancel").put("id", id))
        }
    }

    // ---- receiving -----------------------------------------------------------

    fun handle(msg: JSONObject, bin: ByteArray?) {
        val id = msg.optString("id")
        when (msg.optString("t")) {
            "file.offer" -> offer(id, msg.optString("name", "file"), msg.optLong("size", -1))
            "file.chunk" -> chunk(id, bin)
            "file.end" -> end(id, msg.optString("sha256"))
            "file.cancel" -> {
                cancelled.add(id)
                incoming[id]?.let { fail(it, "cancelled") }
            }
        }
    }

    private fun safeName(name: String): String {
        var n = name.substringAfterLast('/').substringAfterLast('\\')
        n = n.replace(Regex("[\\u0000-\\u001f<>:\"|?*]"), "_").trimEnd('.', ' ')
        if (n.isEmpty() || n == "." || n == "..") n = "file"
        return if (n.length > 150) n.take(120) + "." + n.substringAfterLast('.', "bin").take(10) else n
    }

    private fun offer(id: String, rawName: String, size: Long) {
        if (id.isEmpty() || size < 0 || incoming.containsKey(id)) return
        val name = safeName(rawName)
        try {
            val inc = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val ext = name.substringAfterLast('.', "").lowercase()
                val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mime)
                    put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Wasl")
                    put(MediaStore.MediaColumns.IS_PENDING, 1)
                }
                val uri = ctx.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw IllegalStateException("insert failed")
                val out = ctx.contentResolver.openOutputStream(uri) ?: throw IllegalStateException("open failed")
                Incoming(id, name, size, uri, null, out.buffered(256 * 1024))
            } else {
                @Suppress("DEPRECATION")
                val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), "Wasl")
                dir.mkdirs()
                var f = File(dir, name)
                var i = 2
                while (f.exists()) {
                    val base = name.substringBeforeLast('.')
                    val ext = name.substringAfterLast('.', "")
                    f = File(dir, if (ext.isEmpty()) "$base ($i)" else "$base ($i).$ext")
                    i++
                }
                Incoming(id, f.name, size, null, f, FileOutputStream(f).buffered(256 * 1024))
            }
            incoming[id] = inc
            publish(TransferView(id, inc.name, size, 0, true, "active"))
        } catch (e: Exception) {
            Link.post(JSONObject().put("t", "file.cancel").put("id", id))
            publish(TransferView(id, name, size, 0, true, "failed"))
        }
    }

    private fun chunk(id: String, bin: ByteArray?) {
        val inc = incoming[id] ?: return
        if (bin == null) return
        if (inc.got + bin.size > inc.size) {
            fail(inc, "failed")
            Link.post(JSONObject().put("t", "file.cancel").put("id", id))
            return
        }
        try {
            inc.out.write(bin)
            inc.digest.update(bin)
            inc.got += bin.size
        } catch (e: Exception) {
            fail(inc, "failed")
            Link.post(JSONObject().put("t", "file.cancel").put("id", id))
            return
        }
        val now = System.currentTimeMillis()
        if (now - inc.lastUpdate > 200) {
            inc.lastUpdate = now
            publish(TransferView(id, inc.name, inc.size, inc.got, true, "active"))
        }
    }

    private fun end(id: String, sha: String) {
        val inc = incoming.remove(id) ?: return
        try { inc.out.close() } catch (_: Exception) {}
        val hex = inc.digest.digest().joinToString("") { "%02x".format(it) }
        if (inc.got != inc.size || (sha.isNotEmpty() && sha != hex)) {
            discard(inc)
            publish(TransferView(id, inc.name, inc.size, inc.got, true, "failed"))
            return
        }
        var openUri: Uri? = null
        if (inc.uri != null) {
            val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            ctx.contentResolver.update(inc.uri, values, null, null)
            openUri = inc.uri
        }
        publish(TransferView(id, inc.name, inc.size, inc.size, true, "done"))
        notifyReceived(inc.name, openUri)
    }

    private fun fail(inc: Incoming, state: String) {
        incoming.remove(inc.id)
        try { inc.out.close() } catch (_: Exception) {}
        discard(inc)
        publish(TransferView(inc.id, inc.name, inc.size, inc.got, true, state))
    }

    private fun discard(inc: Incoming) {
        try {
            inc.uri?.let { ctx.contentResolver.delete(it, null, null) }
            inc.file?.delete()
        } catch (_: Exception) {
        }
    }

    fun abortAll() {
        for (inc in incoming.values.toList()) fail(inc, "failed")
    }

    private fun notifyReceived(name: String, uri: Uri?) {
        val b = NotificationCompat.Builder(ctx, WaslApp.CH_FILES)
            .setSmallIcon(R.drawable.ic_stat_wasl)
            .setContentTitle(ctx.getString(R.string.file_received))
            .setContentText(name)
            .setAutoCancel(true)
        if (uri != null) {
            val view = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, ctx.contentResolver.getType(uri))
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            b.setContentIntent(PendingIntent.getActivity(ctx, name.hashCode(), view, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
        }
        try {
            ctx.getSystemService(NotificationManager::class.java).notify(name.hashCode(), b.build())
        } catch (_: SecurityException) {
        }
    }

    // ---- sending -------------------------------------------------------------

    /** Sends one file; blocks the calling (background) thread until done. */
    fun send(item: Outgoing) {
        val id = ByteArray(8).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
        var sent = 0L
        publish(TransferView(id, item.name, item.size, 0, false, "active"))
        val digest = MessageDigest.getInstance("SHA-256")
        val ok = try {
            item.stream.use { input ->
                if (!Link.sendNow(JSONObject().put("t", "file.offer").put("id", id).put("name", item.name).put("size", item.size))) {
                    throw IllegalStateException("not connected")
                }
                val buf = ByteArray(CHUNK)
                var last = 0L
                while (true) {
                    if (cancelled.contains(id)) throw IllegalStateException("cancelled")
                    val n = readFully(input, buf)
                    if (n <= 0) break
                    digest.update(buf, 0, n)
                    if (!Link.sendNow(JSONObject().put("t", "file.chunk").put("id", id), buf, 0, n)) {
                        throw IllegalStateException("disconnected")
                    }
                    sent += n
                    val now = System.currentTimeMillis()
                    if (now - last > 200) {
                        last = now
                        publish(TransferView(id, item.name, item.size, sent, false, "active"))
                    }
                }
                val hex = digest.digest().joinToString("") { "%02x".format(it) }
                Link.sendNow(JSONObject().put("t", "file.end").put("id", id).put("sha256", hex))
            }
        } catch (e: Exception) {
            Link.sendNow(JSONObject().put("t", "file.cancel").put("id", id))
            false
        }
        val state = when {
            ok -> "done"
            cancelled.remove(id) -> "cancelled"
            else -> "failed"
        }
        publish(TransferView(id, item.name, item.size, if (ok) item.size else sent, false, state))
    }

    private fun readFully(input: InputStream, buf: ByteArray): Int {
        var total = 0
        while (total < buf.size) {
            val n = input.read(buf, total, buf.size - total)
            if (n < 0) break
            total += n
        }
        return total
    }

    companion object {
        const val CHUNK = 256 * 1024
    }
}
