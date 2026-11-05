package com.muhannadsatlink.wasl

import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/** What is playing on the phone, and remote control of it. Needs notification access. */
object Media {
    private val main = Handler(Looper.getMainLooper())
    private var msm: MediaSessionManager? = null
    private var controller: MediaController? = null
    private var appCtx: Context? = null
    private var lastArtKey = ""
    private var lastArt = ""
    private var pending: Runnable? = null

    private val sessionsListener = MediaSessionManager.OnActiveSessionsChangedListener { list ->
        pick(list ?: emptyList())
    }

    private val callback = object : MediaController.Callback() {
        override fun onPlaybackStateChanged(state: PlaybackState?) = sendSoon()
        override fun onMetadataChanged(metadata: MediaMetadata?) = sendSoon()
        override fun onSessionDestroyed() {
            val c = msm ?: return
            try { pick(c.getActiveSessions(component())) } catch (_: Exception) {}
        }
    }

    private fun component() = ComponentName(appCtx!!, NotifListener::class.java)

    /** Called when the link connects and notification access is on. */
    fun attach(ctx: Context) = main.post {
        appCtx = ctx.applicationContext
        if (!NotifListener.isEnabled(ctx)) return@post
        try {
            val m = ctx.getSystemService(MediaSessionManager::class.java)
            msm = m
            m.removeOnActiveSessionsChangedListener(sessionsListener)
            m.addOnActiveSessionsChangedListener(sessionsListener, component(), main)
            pick(m.getActiveSessions(component()))
        } catch (_: SecurityException) {
        }
    }

    fun detach() = main.post {
        try { msm?.removeOnActiveSessionsChangedListener(sessionsListener) } catch (_: Exception) {}
        controller?.unregisterCallback(callback)
        controller = null
    }

    private fun pick(list: List<MediaController>) {
        // Prefer the session that is playing; otherwise the most recent one.
        val best = list.firstOrNull { it.playbackState?.state == PlaybackState.STATE_PLAYING } ?: list.firstOrNull()
        if (best?.sessionToken != controller?.sessionToken) {
            controller?.unregisterCallback(callback)
            controller = best
            best?.registerCallback(callback, main)
        }
        sendSoon()
    }

    private fun sendSoon() {
        pending?.let { main.removeCallbacks(it) }
        val r = Runnable { Link.post(snapshot()) }
        pending = r
        main.postDelayed(r, 150)
    }

    fun snapshot(): JSONObject {
        val c = controller ?: return JSONObject().put("t", "media").put("active", false)
        val md = c.metadata
        val st = c.playbackState
        val title = md?.getString(MediaMetadata.METADATA_KEY_TITLE) ?: md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE) ?: ""
        val artist = md?.getString(MediaMetadata.METADATA_KEY_ARTIST) ?: md?.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE) ?: ""
        val album = md?.getString(MediaMetadata.METADATA_KEY_ALBUM) ?: ""
        val duration = md?.getLong(MediaMetadata.METADATA_KEY_DURATION) ?: 0L
        var position = st?.position ?: 0L
        if (st != null && st.state == PlaybackState.STATE_PLAYING && st.lastPositionUpdateTime > 0) {
            position += ((SystemClock.elapsedRealtime() - st.lastPositionUpdateTime) * st.playbackSpeed).toLong()
        }
        val actions = st?.actions ?: 0L
        val artKey = "${c.packageName}|$title|$album"
        if (artKey != lastArtKey) {
            lastArtKey = artKey
            val bmp = md?.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART) ?: md?.getBitmap(MediaMetadata.METADATA_KEY_ART)
            lastArt = bmp?.let { encodeArt(it) } ?: ""
        }
        val appName = try {
            val pm = appCtx!!.packageManager
            pm.getApplicationLabel(pm.getApplicationInfo(c.packageName, 0)).toString()
        } catch (e: Exception) {
            c.packageName
        }
        return JSONObject()
            .put("t", "media")
            .put("active", title.isNotEmpty())
            .put("pkg", c.packageName)
            .put("app", appName)
            .put("title", title)
            .put("artist", artist)
            .put("album", album)
            .put("duration", duration)
            .put("position", position.coerceAtLeast(0))
            .put("at", System.currentTimeMillis())
            .put("playing", st?.state == PlaybackState.STATE_PLAYING)
            .put("canSeek", actions and PlaybackState.ACTION_SEEK_TO != 0L)
            .put("canNext", actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
            .put("canPrev", actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
            .put("art", lastArt)
    }

    private fun encodeArt(src: Bitmap): String = try {
        val side = 320
        val scale = side.toFloat() / maxOf(src.width, src.height)
        val bmp = if (scale < 1f) Bitmap.createScaledBitmap(src, (src.width * scale).toInt().coerceAtLeast(1), (src.height * scale).toInt().coerceAtLeast(1), true) else src
        val out = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 82, out)
        Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    } catch (e: Exception) {
        ""
    }

    fun command(msg: JSONObject) = main.post {
        val tc = controller?.transportControls ?: return@post
        when (msg.optString("cmd")) {
            "play" -> tc.play()
            "pause" -> tc.pause()
            "toggle" -> if (controller?.playbackState?.state == PlaybackState.STATE_PLAYING) tc.pause() else tc.play()
            "next" -> tc.skipToNext()
            "prev" -> tc.skipToPrevious()
            "seek" -> tc.seekTo(msg.optLong("pos"))
        }
    }
}
