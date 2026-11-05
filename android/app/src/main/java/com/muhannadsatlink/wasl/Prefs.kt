package com.muhannadsatlink.wasl

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class Pairing(
    val pcId: String,
    val pcName: String,
    val hosts: List<String>,
    val port: Int,
    val key: ByteArray,
) {
    companion object {
        /** Parses wasl://pair?v=1&id=..&n=..&h=ip1,ip2&p=47800&k=<base64url key> */
        fun parse(text: String): Pairing? = try {
            val u = Uri.parse(text.trim())
            if (u.scheme != "wasl" || u.host != "pair") null
            else if ((u.getQueryParameter("v") ?: "1") != Protocol.VERSION.toString()) null
            else {
                val key = Base64.decode(u.getQueryParameter("k"), Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
                val hosts = (u.getQueryParameter("h") ?: "").split(',').map { it.trim() }.filter { it.isNotEmpty() }
                val id = u.getQueryParameter("id") ?: ""
                if (key.size != 32 || hosts.isEmpty() || id.isEmpty()) null
                else Pairing(
                    pcId = id,
                    pcName = u.getQueryParameter("n") ?: "PC",
                    hosts = hosts,
                    port = u.getQueryParameter("p")?.toIntOrNull() ?: 47800,
                    key = key,
                )
            }
        } catch (e: Exception) {
            null
        }
    }
}

/** Pairing and settings. The pairing key is sealed with an Android Keystore key. */
class Prefs(context: Context) {
    private val sp: SharedPreferences = context.getSharedPreferences("wasl", Context.MODE_PRIVATE)

    val deviceId: String
        get() {
            sp.getString("deviceId", null)?.let { return it }
            val b = ByteArray(16).also { SecureRandom().nextBytes(it) }
            val id = b.joinToString("") { "%02x".format(it) }
            sp.edit().putString("deviceId", id).apply()
            return id
        }

    var pairing: Pairing?
        get() {
            val sealed = sp.getString("key", null) ?: return null
            val key = try { unseal(Base64.decode(sealed, Base64.NO_WRAP)) } catch (e: Exception) { return null }
            return Pairing(
                pcId = sp.getString("pcId", "") ?: "",
                pcName = sp.getString("pcName", "PC") ?: "PC",
                hosts = (sp.getString("hosts", "") ?: "").split(',').filter { it.isNotEmpty() },
                port = sp.getInt("port", 47800),
                key = key,
            )
        }
        set(p) {
            if (p == null) {
                sp.edit().remove("key").remove("pcId").remove("pcName").remove("hosts").remove("port").remove("lastHost").apply()
            } else {
                sp.edit()
                    .putString("key", Base64.encodeToString(seal(p.key), Base64.NO_WRAP))
                    .putString("pcId", p.pcId)
                    .putString("pcName", p.pcName)
                    .putString("hosts", p.hosts.joinToString(","))
                    .putInt("port", p.port)
                    .remove("lastHost")
                    .apply()
            }
        }

    var lastHost: String?
        get() = sp.getString("lastHost", null)
        set(v) = sp.edit().putString("lastHost", v).apply()

    var lastPort: Int
        get() = sp.getInt("lastPort", 0)
        set(v) = sp.edit().putInt("lastPort", v).apply()

    var sendNotifications: Boolean
        get() = sp.getBoolean("sendNotifications", true)
        set(v) = sp.edit().putBoolean("sendNotifications", v).apply()

    var clipboardFromPc: Boolean
        get() = sp.getBoolean("clipboardFromPc", true)
        set(v) = sp.edit().putBoolean("clipboardFromPc", v).apply()

    var mutedApps: Set<String>
        get() = sp.getStringSet("mutedApps", emptySet()) ?: emptySet()
        set(v) = sp.edit().putStringSet("mutedApps", HashSet(v)).apply()

    var lastUpdateCheck: Long
        get() = sp.getLong("lastUpdateCheck", 0)
        set(v) = sp.edit().putLong("lastUpdateCheck", v).apply()

    var enabled: Boolean
        get() = sp.getBoolean("enabled", true)
        set(v) = sp.edit().putBoolean("enabled", v).apply()

    // ---- Keystore ---------------------------------------------------------

    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun seal(plain: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, keystoreKey())
        return c.iv + c.doFinal(plain)
    }

    private fun unseal(data: ByteArray): ByteArray {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, data, 0, 12))
        return c.doFinal(data, 12, data.size - 12)
    }

    companion object {
        private const val ALIAS = "wasl_pairing"
    }
}
