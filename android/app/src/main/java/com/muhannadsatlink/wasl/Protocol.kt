package com.muhannadsatlink.wasl

import org.json.JSONObject
import java.io.DataInputStream
import java.io.IOException
import java.io.OutputStream
import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Wasl wire protocol v1. Mirrors desktop/src/protocol.js; see docs/PROTOCOL.md. */
object Protocol {
    const val VERSION = 1
    const val MAX_FRAME = 4 * 1024 * 1024
    const val PLAIN: Int = 0x00
    const val SEALED: Int = 0x01

    fun derive(key: ByteArray, label: String, nonceC: ByteArray, nonceS: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        mac.update(label.toByteArray(Charsets.UTF_8))
        mac.update(nonceC)
        mac.update(nonceS)
        return mac.doFinal()
    }

    fun encodePayload(msg: JSONObject, bin: ByteArray? = null, binOff: Int = 0, binLen: Int = bin?.size ?: 0): ByteArray {
        val json = msg.toString().toByteArray(Charsets.UTF_8)
        val buf = ByteBuffer.allocate(4 + json.size + binLen)
        buf.putInt(json.size)
        buf.put(json)
        if (bin != null && binLen > 0) buf.put(bin, binOff, binLen)
        return buf.array()
    }

    class Payload(val msg: JSONObject, val bin: ByteArray?)

    fun decodePayload(buf: ByteArray): Payload {
        if (buf.size < 4) throw IOException("bad payload")
        val len = ByteBuffer.wrap(buf, 0, 4).int
        if (len < 0 || 4 + len > buf.size) throw IOException("bad payload length")
        val msg = JSONObject(String(buf, 4, len, Charsets.UTF_8))
        val bin = if (buf.size > 4 + len) buf.copyOfRange(4 + len, buf.size) else null
        return Payload(msg, bin)
    }

    class Frame(val type: Int, val body: ByteArray)

    fun readFrame(input: DataInputStream): Frame {
        val len = input.readInt()
        if (len < 1 || len > MAX_FRAME) throw IOException("bad frame length")
        val type = input.readUnsignedByte()
        val body = ByteArray(len - 1)
        input.readFully(body)
        return Frame(type, body)
    }

    fun writeFrame(out: OutputStream, type: Int, body: ByteArray) {
        val head = ByteBuffer.allocate(5).putInt(body.size + 1).put(type.toByte()).array()
        out.write(head)
        out.write(body)
    }

    /** One direction of the encrypted channel; the nonce is a frame counter. */
    class Channel(key: ByteArray) {
        private val spec = SecretKeySpec(key, "AES")
        private var counter = 0L

        private fun nonce(): ByteArray = ByteBuffer.allocate(12).putInt(0).putLong(counter++).array()

        fun seal(plain: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, spec, GCMParameterSpec(128, nonce()))
            return c.doFinal(plain)
        }

        fun open(sealed: ByteArray): ByteArray {
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, spec, GCMParameterSpec(128, nonce()))
            return c.doFinal(sealed)
        }
    }
}
