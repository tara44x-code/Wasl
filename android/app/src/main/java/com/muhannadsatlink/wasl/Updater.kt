package com.muhannadsatlink.wasl

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** Checks GitHub Releases for a newer APK, verifies it and hands it to the installer. */
object Updater {
    private const val API = "https://api.github.com/repos/tara44x-code/Wasl/releases/latest"

    data class Info(val version: String, val apkUrl: String, val sumsUrl: String?, val notes: String)

    sealed class State {
        object Idle : State()
        object Checking : State()
        object UpToDate : State()
        data class Available(val info: Info) : State()
        data class Downloading(val percent: Int) : State()
        data class Failed(val why: String) : State()
    }

    private val _state = MutableStateFlow<State>(State.Idle)
    val state: StateFlow<State> = _state

    /** "1.2.10" > "1.2.9" */
    fun newer(a: String, b: String): Boolean {
        val pa = a.trimStart('v').split('.', '-').map { it.toIntOrNull() ?: 0 }
        val pb = b.trimStart('v').split('.', '-').map { it.toIntOrNull() ?: 0 }
        for (i in 0 until maxOf(pa.size, pb.size)) {
            val x = pa.getOrElse(i) { 0 }
            val y = pb.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    private fun get(url: String): HttpURLConnection {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 10_000
        c.readTimeout = 30_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "Wasl-Android")
        c.instanceFollowRedirects = true
        return c
    }

    /** Blocking; call from a background thread. */
    fun check(): State {
        _state.value = State.Checking
        val s = try {
            val c = get(API)
            val body = c.inputStream.bufferedReader().use { it.readText() }
            val j = JSONObject(body)
            val tag = j.getString("tag_name")
            val assets = j.getJSONArray("assets")
            var apk: String? = null
            var sums: String? = null
            for (i in 0 until assets.length()) {
                val a = assets.getJSONObject(i)
                val name = a.getString("name")
                if (name.endsWith(".apk")) apk = a.getString("browser_download_url")
                if (name == "SHA256SUMS.txt") sums = a.getString("browser_download_url")
            }
            if (apk != null && newer(tag, BuildConfig.VERSION_NAME)) {
                State.Available(Info(tag.trimStart('v'), apk, sums, j.optString("body")))
            } else {
                State.UpToDate
            }
        } catch (e: Exception) {
            State.Failed(e.message ?: "network")
        }
        _state.value = s
        return s
    }

    /** Downloads, checks the SHA-256 against the release's sums and opens the installer. Blocking. */
    fun install(ctx: Context, info: Info) {
        try {
            _state.value = State.Downloading(0)
            val file = File(ctx.cacheDir, "update.apk")
            val md = MessageDigest.getInstance("SHA-256")
            val c = get(info.apkUrl)
            val total = c.contentLengthLong
            c.inputStream.use { input ->
                file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        done += n
                        if (total > 0) _state.value = State.Downloading((done * 100 / total).toInt())
                    }
                }
            }
            val hex = md.digest().joinToString("") { "%02x".format(it) }
            info.sumsUrl?.let { url ->
                val sums = get(url).inputStream.bufferedReader().use { it.readText() }
                val name = info.apkUrl.substringAfterLast('/')
                val expected = sums.lines().firstOrNull { it.trim().endsWith(name) }?.trim()?.substringBefore(' ')
                if (expected != null && !expected.equals(hex, ignoreCase = true)) throw SecurityException("checksum mismatch")
            }

            val pi = ctx.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
            if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            val id = pi.createSession(params)
            pi.openSession(id).use { session ->
                file.inputStream().use { input ->
                    session.openWrite("wasl.apk", 0, file.length()).use { out ->
                        input.copyTo(out)
                        session.fsync(out)
                    }
                }
                val intent = Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.INSTALL_STATUS)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                session.commit(PendingIntent.getBroadcast(ctx, 9, intent, flags).intentSender)
            }
            _state.value = State.Idle
        } catch (e: Exception) {
            _state.value = State.Failed(e.message ?: "install")
        }
    }

    /** The installer needs the user to confirm. */
    fun onStatus(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.let { ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            PackageInstaller.STATUS_SUCCESS -> _state.value = State.UpToDate
            else -> _state.value = State.Failed(intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "install")
        }
    }
}
