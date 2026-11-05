package com.muhannadsatlink.wasl

import android.Manifest
import android.content.Context
import android.os.Build
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Lets the PC browse the phone's storage and download files. Needs All files access. */
object PhoneFiles {
    private val root: File get() = Environment.getExternalStorageDirectory()

    fun allowed(ctx: Context): Boolean =
        if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else Perms.has(ctx, Manifest.permission.READ_EXTERNAL_STORAGE)

    /** Resolves a path from the PC and keeps it inside shared storage. */
    private fun resolve(rel: String): File? {
        val base = root.canonicalFile
        val f = File(base, rel.trimStart('/')).canonicalFile
        return if (f.path == base.path || f.path.startsWith(base.path + File.separator)) f else null
    }

    fun handle(ctx: Context, msg: JSONObject) {
        when (msg.optString("t")) {
            "fs.list" -> Link.post(list(ctx, msg.optString("path")))
            "fs.get" -> {
                if (!allowed(ctx)) return
                val arr = msg.optJSONArray("paths") ?: return
                val items = ArrayList<Files.Outgoing>()
                for (i in 0 until arr.length()) {
                    val f = resolve(arr.optString(i)) ?: continue
                    if (f.isFile && f.canRead()) items.add(Files.Outgoing(f.name, f.length(), f.inputStream()))
                }
                Link.sendFiles(items)
            }
        }
    }

    private fun list(ctx: Context, rel: String): JSONObject {
        val out = JSONObject().put("t", "fs.list").put("path", rel).put("allowed", allowed(ctx))
        val dir = resolve(rel)
        val items = JSONArray()
        if (allowed(ctx) && dir != null && dir.isDirectory) {
            val files = dir.listFiles()?.filter { !it.name.startsWith(".") }
                ?.sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
                ?: emptyList()
            for (f in files.take(2000)) {
                items.put(
                    JSONObject()
                        .put("name", f.name)
                        .put("dir", f.isDirectory)
                        .put("size", if (f.isFile) f.length() else 0)
                        .put("mtime", f.lastModified()),
                )
            }
        }
        return out.put("items", items)
    }
}
