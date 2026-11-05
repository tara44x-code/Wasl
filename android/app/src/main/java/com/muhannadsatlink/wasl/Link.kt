package com.muhannadsatlink.wasl

import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.concurrent.Executors

enum class Status { UNPAIRED, OFF, SEARCHING, CONNECTED }

data class TransferView(
    val id: String,
    val name: String,
    val size: Long,
    val done: Long,
    val incoming: Boolean,
    val state: String, // active, done, failed, cancelled
)

data class LinkState(
    val status: Status = Status.UNPAIRED,
    val pcName: String = "",
    val error: String? = null,
    val transfers: List<TransferView> = emptyList(),
)

class PairingRefused : IOException("unpaired")

/** One authenticated, encrypted connection to the PC. */
class Conn(
    private val socket: Socket,
    private val input: DataInputStream,
    private val out: BufferedOutputStream,
    private val tx: Protocol.Channel,
    private val rx: Protocol.Channel,
    val host: String,
    val port: Int,
) {
    private val lock = Any()

    fun send(msg: JSONObject, bin: ByteArray? = null, off: Int = 0, len: Int = bin?.size ?: 0) {
        val plain = Protocol.encodePayload(msg, bin, off, len)
        synchronized(lock) {
            Protocol.writeFrame(out, Protocol.SEALED, tx.seal(plain))
            out.flush()
        }
    }

    fun readLoop(handler: (JSONObject, ByteArray?) -> Unit) {
        while (true) {
            val f = Protocol.readFrame(input)
            if (f.type != Protocol.SEALED) throw IOException("unexpected plaintext")
            val p = Protocol.decodePayload(rx.open(f.body))
            handler(p.msg, p.bin)
        }
    }

    fun close() {
        try { socket.close() } catch (_: Exception) {}
    }
}

object Link {
    private val _state = MutableStateFlow(LinkState())
    val state: StateFlow<LinkState> = _state

    private lateinit var app: Context
    lateinit var prefs: Prefs
        private set
    lateinit var files: Files
        private set

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sender = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var loopJob: Job? = null

    @Volatile private var conn: Conn? = null
    private var batteryReceiver: BroadcastReceiver? = null
    private var lastBattery = ""

    val connected: Boolean get() = conn != null

    fun init(ctx: Context) {
        app = ctx.applicationContext
        prefs = Prefs(app)
        files = Files(app)
        val p = prefs.pairing
        _state.value = LinkState(status = if (p == null) Status.UNPAIRED else Status.OFF, pcName = p?.pcName ?: "")
    }

    fun start() {
        if (loopJob?.isActive == true) {
            poke()
            return
        }
        loopJob = scope.launch { runLoop() }
    }

    fun stop() {
        loopJob?.cancel()
        loopJob = null
        conn?.close()
        val p = prefs.pairing
        update { it.copy(status = if (p == null) Status.UNPAIRED else Status.OFF) }
    }

    /** Try to connect now (network changed, new pairing...). */
    fun poke() {
        wake.trySend(Unit)
    }

    fun pair(p: Pairing) {
        prefs.pairing = p
        conn?.close()
        update { it.copy(status = Status.SEARCHING, pcName = p.pcName, error = null) }
        poke()
    }

    fun unpair() {
        post(JSONObject().put("t", "unpaired"))
        sender.execute {
            prefs.pairing = null
            conn?.close()
            update { LinkState(status = Status.UNPAIRED) }
        }
    }

    internal fun update(f: (LinkState) -> LinkState) {
        synchronized(_state) { _state.value = f(_state.value) }
    }

    // ---- sending -----------------------------------------------------------

    /** Sends on the calling thread (must not be the main thread). */
    fun sendNow(msg: JSONObject, bin: ByteArray? = null, off: Int = 0, len: Int = bin?.size ?: 0): Boolean {
        val c = conn ?: return false
        return try {
            c.send(msg, bin, off, len)
            true
        } catch (e: Exception) {
            c.close()
            false
        }
    }

    /** Queues a message; safe from any thread. */
    fun post(msg: JSONObject) {
        if (conn == null) return
        sender.execute { sendNow(msg) }
    }

    fun sendFiles(items: List<Files.Outgoing>) {
        scope.launch {
            for (item in items) files.send(item)
        }
    }

    // ---- connection loop ---------------------------------------------------

    private suspend fun runLoop() {
        var backoff = 1000L
        while (currentCoroutineContext().isActive) {
            val p = prefs.pairing
            if (p == null) {
                update { it.copy(status = Status.UNPAIRED) }
                wake.receive()
                continue
            }
            update { it.copy(status = Status.SEARCHING, pcName = p.pcName) }
            val c = try {
                connect(p)
            } catch (e: PairingRefused) {
                prefs.pairing = null
                update { LinkState(status = Status.UNPAIRED, error = "refused") }
                continue
            }
            if (c == null) {
                withTimeoutOrNull(backoff) { wake.receive() }
                backoff = (backoff * 2).coerceAtMost(15_000L)
                continue
            }
            backoff = 1000L
            conn = c
            prefs.lastHost = c.host
            prefs.lastPort = c.port
            onConnected(p)
            try {
                c.readLoop { msg, bin -> handle(msg, bin) }
            } catch (_: Exception) {
            }
            conn = null
            c.close()
            onDisconnected()
        }
    }

    private fun connect(p: Pairing): Conn? {
        val candidates = LinkedHashSet<Pair<String, Int>>()
        prefs.lastHost?.let { candidates.add(it to (prefs.lastPort.takeIf { port -> port > 0 } ?: p.port)) }
        p.hosts.forEach { candidates.add(it to p.port) }
        for ((host, port) in candidates) {
            tryConnect(p, host, port)?.let { return it }
        }
        val found = discover(p.pcId) ?: return null
        return tryConnect(p, found.first, found.second)
    }

    private fun tryConnect(p: Pairing, host: String, port: Int): Conn? {
        val socket = Socket()
        try {
            socket.connect(InetSocketAddress(host, port), 2500)
            socket.tcpNoDelay = true
            socket.keepAlive = true
            socket.soTimeout = 10_000
            val input = DataInputStream(socket.getInputStream().buffered(64 * 1024))
            val out = BufferedOutputStream(socket.getOutputStream(), 64 * 1024)

            val nonceC = ByteArray(16).also { SecureRandom().nextBytes(it) }
            val hello = JSONObject()
                .put("t", "hello")
                .put("v", Protocol.VERSION)
                .put("dev", prefs.deviceId)
                .put("nonce", Base64.encodeToString(nonceC, Base64.NO_WRAP))
            Protocol.writeFrame(out, Protocol.PLAIN, hello.toString().toByteArray(Charsets.UTF_8))
            out.flush()

            val f = Protocol.readFrame(input)
            if (f.type != Protocol.PLAIN) throw IOException("bad hello")
            val reply = JSONObject(String(f.body, Charsets.UTF_8))
            if (reply.optString("t") == "error") {
                if (reply.optString("code") == "unpaired") throw PairingRefused()
                throw IOException(reply.optString("code"))
            }
            if (reply.optString("t") != "hello" || reply.optString("pc") != p.pcId) throw IOException("wrong pc")
            val nonceS = Base64.decode(reply.getString("nonce"), Base64.DEFAULT)
            val tx = Protocol.Channel(Protocol.derive(p.key, "wasl/v1/c2s", nonceC, nonceS))
            val rx = Protocol.Channel(Protocol.derive(p.key, "wasl/v1/s2c", nonceC, nonceS))
            val c = Conn(socket, input, out, tx, rx, host, port)

            c.send(
                JSONObject()
                    .put("t", "auth")
                    .put("name", deviceName())
                    .put("model", "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}")
                    .put("os", "Android ${Build.VERSION.RELEASE}"),
            )
            val w = Protocol.readFrame(input)
            if (w.type != Protocol.SEALED) throw IOException("bad welcome")
            val welcome = Protocol.decodePayload(rx.open(w.body)).msg
            if (welcome.optString("t") != "welcome") throw IOException("bad welcome")
            socket.soTimeout = 45_000 // the PC pings every 15 s
            val name = welcome.optString("name")
            if (name.isNotEmpty() && name != p.pcName) {
                prefs.pairing = p.copy(pcName = name)
                update { it.copy(pcName = name) }
            }
            return c
        } catch (e: PairingRefused) {
            try { socket.close() } catch (_: Exception) {}
            throw e
        } catch (e: Exception) {
            try { socket.close() } catch (_: Exception) {}
            return null
        }
    }

    /** Asks the network where the PC is now. */
    private fun discover(pcId: String): Pair<String, Int>? {
        return try {
            DatagramSocket().use { s ->
                s.broadcast = true
                s.soTimeout = 1500
                val q = "WASL?$pcId".toByteArray()
                s.send(DatagramPacket(q, q.size, InetAddress.getByName("255.255.255.255"), 47801))
                val buf = ByteArray(256)
                val deadline = System.currentTimeMillis() + 1500
                while (System.currentTimeMillis() < deadline) {
                    val pkt = DatagramPacket(buf, buf.size)
                    try {
                        s.receive(pkt)
                    } catch (e: SocketTimeoutException) {
                        break
                    }
                    val text = String(pkt.data, 0, pkt.length)
                    val prefix = "WASL!$pcId:"
                    if (text.startsWith(prefix)) {
                        val port = text.substring(prefix.length).toIntOrNull() ?: continue
                        return pkt.address.hostAddress?.let { it to port }
                    }
                }
                null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun deviceName(): String {
        val n = try { Settings.Global.getString(app.contentResolver, Settings.Global.DEVICE_NAME) } catch (e: Exception) { null }
        return if (n.isNullOrBlank()) Build.MODEL else n
    }

    private fun onConnected(p: Pairing) {
        update { it.copy(status = Status.CONNECTED, pcName = p.pcName, error = null) }
        lastBattery = ""
        main.post {
            val r = object : BroadcastReceiver() {
                override fun onReceive(context: Context, intent: Intent) = sendBattery(intent)
            }
            batteryReceiver = r
            ContextCompat.registerReceiver(app, r, IntentFilter(Intent.ACTION_BATTERY_CHANGED), ContextCompat.RECEIVER_NOT_EXPORTED)
                ?.let { sendBattery(it) }
        }
        if (prefs.sendNotifications) NotifListener.sendSnapshot()
        PhoneControl.attach(app)
        Media.attach(app)
        post(JSONObject().put("t", "hello.phone").put("version", BuildConfig.VERSION_NAME).put("sdk", Build.VERSION.SDK_INT))
    }

    private fun onDisconnected() {
        main.post {
            batteryReceiver?.let { try { app.unregisterReceiver(it) } catch (_: Exception) {} }
            batteryReceiver = null
        }
        files.abortAll()
        Ringer.stop(app, report = false)
        if (ScreenMirror.running) app.stopService(Intent(app, MirrorService::class.java))
        PhoneControl.detach(app)
        Media.detach()
        if (prefs.pairing != null) update { it.copy(status = Status.SEARCHING) }
    }

    private fun sendBattery(intent: Intent) {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
        if (level < 0 || scale <= 0) return
        val pct = level * 100 / scale
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        val key = "$pct/$charging"
        if (key == lastBattery) return
        lastBattery = key
        post(JSONObject().put("t", "battery").put("level", pct).put("charging", charging))
    }

    // ---- receiving ---------------------------------------------------------

    private fun handle(msg: JSONObject, bin: ByteArray?) {
        when (msg.optString("t")) {
            "ping" -> sendNow(JSONObject().put("t", "pong"))
            "clip" -> if (prefs.clipboardFromPc) {
                val text = msg.optString("text")
                main.post {
                    val cm = app.getSystemService(ClipboardManager::class.java)
                    cm.setPrimaryClip(ClipData.newPlainText("Wasl", text))
                }
            }
            "notif.request" -> if (prefs.sendNotifications) NotifListener.sendSnapshot()
            "notif.dismiss" -> NotifListener.dismiss(msg.optString("key"))
            "notif.action" -> NotifListener.act(
                msg.optString("key"),
                msg.optInt("i", -1),
                if (msg.has("reply")) msg.optString("reply") else null,
            )
            "ring" -> if (msg.optBoolean("on")) Ringer.start(app) else Ringer.stop(app)
            "unpaired" -> {
                prefs.pairing = null
                conn?.close()
                update { LinkState(status = Status.UNPAIRED) }
            }
            "file.offer", "file.chunk", "file.end", "file.cancel" -> files.handle(msg, bin)
            "media.cmd" -> Media.command(msg)
            "media.request" -> post(Media.snapshot())
            "toggle", "volume.set" -> PhoneControl.handle(app, msg)
            "status.request" -> PhoneControl.sendSoon(app)
            "nav" -> main.post { WaslAccessibility.global(msg.optString("action")) }
            "call.cmd", "call.dial", "calllog.request", "contacts.request" -> Calls.handle(app, msg)
            "sms.threads.request", "sms.thread.request", "sms.send" -> Sms.handle(app, msg)
            "scr.start", "scr.stop", "scr.key", "scr.gesture" -> ScreenMirror.handle(app, msg)
            "fs.list", "fs.get" -> PhoneFiles.handle(app, msg)
            "notif.filter" -> {
                val arr = msg.optJSONArray("muted")
                val set = HashSet<String>()
                if (arr != null) for (i in 0 until arr.length()) set.add(arr.optString(i))
                prefs.mutedApps = set
                if (prefs.sendNotifications) NotifListener.sendSnapshot()
            }
        }
    }

    /** Reads everything a share or picker gave us before its permission ends. */
    fun openOutgoing(ctx: Context, uris: List<android.net.Uri>): List<Files.Outgoing> {
        val out = ArrayList<Files.Outgoing>()
        for (uri in uris) {
            try {
                var name = uri.lastPathSegment ?: "file"
                var size = -1L
                ctx.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(android.provider.OpenableColumns.SIZE)
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    }
                }
                val pfd = ctx.contentResolver.openFileDescriptor(uri, "r") ?: continue
                if (size < 0) size = pfd.statSize
                val stream: InputStream = android.os.ParcelFileDescriptor.AutoCloseInputStream(pfd)
                if (size < 0) {
                    stream.close()
                    continue
                }
                out.add(Files.Outgoing(name, size, stream))
            } catch (_: Exception) {
            }
        }
        return out
    }
}
