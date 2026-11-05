package com.muhannadsatlink.wasl

import android.Manifest
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Send
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.muhannadsatlink.wasl.ui.BrandGradient
import com.muhannadsatlink.wasl.ui.Ok
import com.muhannadsatlink.wasl.ui.Warn
import com.muhannadsatlink.wasl.ui.WaslTheme
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    private var pendingPair by mutableStateOf<Pairing?>(null)
    private var resumeTick by mutableIntStateOf(0)

    private val scan = registerForActivityResult(ScanContract()) { r ->
        r.contents?.let { offerPairing(it) }
    }
    private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        resumeTick++
    }
    private val pickFiles = registerForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) {
            val items = Link.openOutgoing(this, uris)
            Link.sendFiles(items)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        handleIntent(intent)
        WaslApp.startService(this)
        setContent { WaslTheme { Screen() } }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        resumeTick++
    }

    private fun handleIntent(i: Intent?) {
        val data = i?.data ?: return
        if (data.scheme == "wasl") offerPairing(data.toString())
    }

    private fun offerPairing(text: String) {
        val p = Pairing.parse(text)
        if (p == null) {
            Toast.makeText(this, R.string.pair_invalid, Toast.LENGTH_LONG).show()
        } else {
            pendingPair = p
        }
    }

    private fun confirmPairing(p: Pairing) {
        pendingPair = null
        Link.pair(p)
        Link.prefs.enabled = true
        WaslApp.startService(this)
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) {
            askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    private fun startScan() {
        scan.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    private fun sendClipboard() {
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
    }

    // ---- UI ------------------------------------------------------------------

    @Composable
    private fun Screen() {
        val state by Link.state.collectAsState()
        @Suppress("UNUSED_VARIABLE") val tick = resumeTick // recompose permission rows on resume
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            LazyColumn(
                contentPadding = WindowInsets.systemBars.asPaddingValues(),
                verticalArrangement = Arrangement.spacedBy(14.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item { Header() }
                if (state.status == Status.UNPAIRED) {
                    item { PairCard(state) }
                } else {
                    item { StatusCard(state) }
                    item { SetupCard(tick) }
                    if (state.transfers.isNotEmpty()) item { TransfersCard(state.transfers) }
                    item { SettingsCard() }
                }
                item {
                    Text(
                        stringResource(R.string.developer),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 24.dp, top = 4.dp),
                    )
                }
            }
        }
        pendingPair?.let { p ->
            AlertDialog(
                onDismissRequest = { pendingPair = null },
                title = { Text(stringResource(R.string.pair_confirm_title, p.pcName)) },
                text = { Text(stringResource(R.string.pair_confirm_body)) },
                confirmButton = { Button(onClick = { confirmPairing(p) }) { Text(stringResource(R.string.pair_confirm_ok)) } },
                dismissButton = { TextButton(onClick = { pendingPair = null }) { Text(stringResource(R.string.cancel)) } },
            )
        }
    }

    @Composable
    private fun Header() {
        Box(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 8.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(BrandGradient)
                .padding(22.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    Modifier.size(64.dp).clip(RoundedCornerShape(20.dp)).background(Color.White.copy(alpha = 0.18f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Image(painterResource(R.drawable.logo), null, Modifier.size(52.dp))
                }
                Spacer(Modifier.width(16.dp))
                Column {
                    Text(stringResource(R.string.app_name), color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
                    Text(stringResource(R.string.tagline), color = Color.White.copy(alpha = 0.85f), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }

    @Composable
    private fun SectionCard(title: String? = null, content: @Composable () -> Unit) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .clip(RoundedCornerShape(22.dp))
                .background(MaterialTheme.colorScheme.surface)
                .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(22.dp))
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (title != null) Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }

    @Composable
    private fun PairCard(state: LinkState) {
        var link by remember { mutableStateOf("") }
        SectionCard(stringResource(R.string.pair_title)) {
            Text(stringResource(R.string.pair_lead), color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.error == "refused") {
                Text(stringResource(R.string.pair_refused), color = MaterialTheme.colorScheme.error)
            }
            GradientButton(stringResource(R.string.pair_scan), Modifier.fillMaxWidth()) { startScan() }
            Text(stringResource(R.string.pair_paste), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(
                    value = link,
                    onValueChange = { link = it },
                    singleLine = true,
                    placeholder = { Text("wasl://pair?…") },
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                OutlinedButton(onClick = { offerPairing(link) }) { Text(stringResource(R.string.pair_paste_btn)) }
            }
        }
    }

    @Composable
    private fun StatusCard(state: LinkState) {
        val connected = state.status == Status.CONNECTED
        SectionCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(12.dp).clip(CircleShape).background(if (connected) Ok else Warn))
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(state.pcName.ifEmpty { "PC" }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        stringResource(
                            when (state.status) {
                                Status.CONNECTED -> R.string.status_connected
                                Status.SEARCHING -> R.string.status_searching
                                Status.OFF -> R.string.status_off
                                Status.UNPAIRED -> R.string.status_unpaired
                            },
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                ActionTile(stringResource(R.string.act_clip), Icons.Filled.Share, connected, Modifier.weight(1f)) { sendClipboard() }
                ActionTile(stringResource(R.string.act_files), Icons.Filled.Send, connected, Modifier.weight(1f)) { pickFiles.launch("*/*") }
            }
        }
    }

    @Composable
    private fun ActionTile(label: String, icon: androidx.compose.ui.graphics.vector.ImageVector, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
        Button(
            onClick = onClick,
            enabled = enabled,
            shape = RoundedCornerShape(18.dp),
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.surfaceVariant, contentColor = MaterialTheme.colorScheme.onSurface),
            modifier = modifier.height(84.dp),
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(Modifier.size(34.dp).clip(RoundedCornerShape(11.dp)).background(BrandGradient), contentAlignment = Alignment.Center) {
                    Icon(icon, null, tint = Color.White, modifier = Modifier.size(18.dp))
                }
                Spacer(Modifier.height(6.dp))
                Text(label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            }
        }
    }

    @Composable
    private fun GradientButton(text: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
        Button(
            onClick = onClick,
            colors = ButtonDefaults.buttonColors(containerColor = Color.Transparent),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(),
            shape = RoundedCornerShape(16.dp),
            modifier = modifier.height(54.dp),
        ) {
            Box(Modifier.fillMaxSize().background(BrandGradient), contentAlignment = Alignment.Center) {
                Text(text, color = Color.White, fontWeight = FontWeight.Bold, fontSize = 16.sp)
            }
        }
    }

    @Composable
    private fun SetupCard(tick: Int) {
        val ctx = this
        val listenerOn = remember(tick) { NotifListener.isEnabled(ctx) }
        val postOn = remember(tick) { Build.VERSION.SDK_INT < 33 || granted(Manifest.permission.POST_NOTIFICATIONS) }
        val batteryOn = remember(tick) { getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) }
        val storageOn = remember(tick) { Build.VERSION.SDK_INT >= 29 || granted(Manifest.permission.WRITE_EXTERNAL_STORAGE) }
        if (listenerOn && postOn && batteryOn && storageOn) return
        SectionCard(stringResource(R.string.section_setup)) {
            PermRow(stringResource(R.string.perm_listener), stringResource(R.string.perm_listener_sub), listenerOn) {
                startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
            }
            PermRow(stringResource(R.string.perm_post), stringResource(R.string.perm_post_sub), postOn) {
                if (Build.VERSION.SDK_INT >= 33) askPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            PermRow(stringResource(R.string.perm_battery), stringResource(R.string.perm_battery_sub), batteryOn) {
                try {
                    @Suppress("BatteryLife")
                    startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                } catch (e: Exception) {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
            if (!storageOn) {
                PermRow(stringResource(R.string.perm_storage), stringResource(R.string.perm_storage_sub), false) {
                    askPermission.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                }
            }
        }
    }

    @Composable
    private fun PermRow(title: String, sub: String, done: Boolean, onAllow: () -> Unit) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold)
                Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Spacer(Modifier.width(10.dp))
            if (done) {
                Icon(Icons.Filled.CheckCircle, stringResource(R.string.done), tint = Ok)
            } else {
                Button(onClick = onAllow, shape = RoundedCornerShape(12.dp)) { Text(stringResource(R.string.allow)) }
            }
        }
    }

    @Composable
    private fun TransfersCard(list: List<TransferView>) {
        SectionCard(stringResource(R.string.section_transfers)) {
            for (t in list.take(8)) {
                Column {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(if (t.incoming) "↓" else "↑", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.secondary)
                        Spacer(Modifier.width(8.dp))
                        Text(t.name, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                        val label = when (t.state) {
                            "done" -> stringResource(R.string.tr_done)
                            "failed" -> stringResource(R.string.tr_failed)
                            "cancelled" -> stringResource(R.string.tr_cancelled)
                            else -> if (t.size > 0) "${t.done * 100 / t.size}%" else ""
                        }
                        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (t.state == "active") {
                        Spacer(Modifier.height(6.dp))
                        LinearProgressIndicator(
                            progress = { if (t.size > 0) t.done.toFloat() / t.size else 1f },
                            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(4.dp)),
                        )
                    }
                }
            }
        }
    }

    @Composable
    private fun SettingsCard() {
        val prefs = Link.prefs
        var notifs by remember { mutableStateOf(prefs.sendNotifications) }
        var clip by remember { mutableStateOf(prefs.clipboardFromPc) }
        var enabled by remember { mutableStateOf(prefs.enabled) }
        SectionCard(stringResource(R.string.section_settings)) {
            SwitchRow(stringResource(R.string.set_enabled), enabled) {
                enabled = it
                prefs.enabled = it
                if (it) WaslApp.startService(this@MainActivity) else stopService(Intent(this@MainActivity, LinkService::class.java))
            }
            SwitchRow(stringResource(R.string.set_notifs), notifs) {
                notifs = it
                prefs.sendNotifications = it
                if (it) NotifListener.sendSnapshot()
                else Link.post(JSONObject().put("t", "notif.snapshot").put("items", org.json.JSONArray()))
            }
            SwitchRow(stringResource(R.string.set_clip), clip) {
                clip = it
                prefs.clipboardFromPc = it
            }
            TextButton(onClick = { Link.unpair() }) {
                Text(stringResource(R.string.unpair), color = MaterialTheme.colorScheme.error)
            }
        }
    }

    @Composable
    private fun SwitchRow(title: String, value: Boolean, onChange: (Boolean) -> Unit) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(title, Modifier.weight(1f))
            Switch(checked = value, onCheckedChange = onChange)
        }
    }
}

@Suppress("unused")
private fun Context.toast(res: Int) = Toast.makeText(this, res, Toast.LENGTH_SHORT).show()
