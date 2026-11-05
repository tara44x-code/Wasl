'use strict';
// Wasl for the PC: the Electron main process.

const {
  app, BrowserWindow, Tray, Menu, ipcMain, clipboard, Notification,
  nativeImage, shell, dialog, safeStorage, nativeTheme,
} = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const QRCode = require('qrcode');
const { LinkServer } = require('./server');
const { Transfers } = require('./files');
const { Store } = require('./store');
const P = require('./protocol');

const APP_ID = 'com.muhannadsatlink.wasl';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const MAX_NOTIFS = 300;

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

let win = null;
let tray = null;
let store = null;
let server = null;
let transfers = null;
let quitting = false;

const state = {
  connected: false,
  remote: '',
  battery: null,
  ringing: false,
  notifications: [], // newest first
  transfers: [],
  pairing: null, // { uri, qr, until, hosts }
};

// ---- helpers -------------------------------------------------------------

function lanAddresses() {
  const virtual = /(vethernet|virtualbox|vmware|hyper-v|docker|wsl|loopback|tailscale|zerotier|vbox|br-|virbr)/i;
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      out.push({ address: a.address, score: (priv ? 2 : 0) + (virtual.test(name) ? -3 : 0) });
    }
  }
  return out.sort((x, y) => y.score - x.score).map((a) => a.address).slice(0, 4);
}

function downloadDir() {
  return store.settings.downloadDir || path.join(app.getPath('downloads'), 'Wasl');
}

function publicState() {
  return {
    ...state,
    paired: !!store.device,
    device: store.device,
    settings: store.settings,
    pcName: store.data.pcName,
    version: app.getVersion(),
    platform: process.platform,
    downloadDir: downloadDir(),
  };
}

let pushTimer = null;
function push() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state', publicState());
  }, 30);
}

function showWindow() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function toast(title, body, icon, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon || ICON, silent: false });
  n.on('click', () => {
    showWindow();
    if (onClick) onClick();
  });
  n.show();
}

const t = (ar, en) => (store.settings.language === 'ar' ? ar : en);

// ---- link ----------------------------------------------------------------

async function startServer() {
  server = new LinkServer({
    pcId: store.data.pcId,
    pcName: store.data.pcName,
    keyFor: (id) => store.keyFor(id),
  });
  server.on('log', (m) => console.log('[link]', m));
  server.on('paired', (dev) => {
    store.setDevice(dev);
    state.pairing = null;
    state.notifications = [];
    push();
  });
  server.on('connected', (dev, remote) => {
    store.updateDevice(dev);
    state.connected = true;
    state.remote = remote;
    server.send({ t: 'notif.request' }).catch(() => {});
    updateTray();
    push();
  });
  server.on('disconnected', () => {
    state.connected = false;
    state.ringing = false;
    transfers.abortAll();
    updateTray();
    push();
  });
  server.on('message', onMessage);

  transfers = new Transfers(downloadDir, (m, b) => server.send(m, b));
  transfers.on('update', (tr) => {
    const i = state.transfers.findIndex((x) => x.id === tr.id);
    if (i >= 0) state.transfers[i] = tr;
    else state.transfers.unshift(tr);
    state.transfers = state.transfers.slice(0, 50);
    push();
  });
  transfers.on('received', (file) => {
    if (store.settings.desktopNotifications) {
      toast(t('وصل ملف', 'File received'), path.basename(file), null, () => shell.showItemInFolder(file));
    }
  });

  try {
    await server.start();
  } catch (e) {
    dialog.showErrorBox('Wasl', t(
      `تعذّر فتح المنفذ ${server.port}. ربما هناك نسخة أخرى تعمل.\n${e.message}`,
      `Could not open port ${server.port}. Another copy may be running.\n${e.message}`,
    ));
  }
}

function iconFrom(b64) {
  if (!b64) return null;
  try {
    const img = nativeImage.createFromDataURL(`data:image/png;base64,${b64}`);
    return img.isEmpty() ? null : img;
  } catch {
    return null;
  }
}

function sanitizeNotif(m) {
  return {
    key: String(m.key),
    pkg: String(m.pkg || ''),
    app: String(m.app || '').slice(0, 80),
    title: String(m.title || '').slice(0, 300),
    text: String(m.text || '').slice(0, 4000),
    time: Number(m.time) || Date.now(),
    icon: typeof m.icon === 'string' && m.icon.length < 200_000 ? m.icon : '',
    actions: Array.isArray(m.actions)
      ? m.actions.slice(0, 5).map((a) => ({ i: Number(a.i), title: String(a.title || '').slice(0, 40), reply: !!a.reply }))
      : [],
  };
}

let lastClipFromPhone = null;

function onMessage(msg, bin) {
  if (transfers.handle(msg, bin)) return;
  switch (msg.t) {
    case 'battery':
      state.battery = { level: Number(msg.level), charging: !!msg.charging };
      push();
      break;
    case 'notif.snapshot':
      state.notifications = (Array.isArray(msg.items) ? msg.items : []).map(sanitizeNotif)
        .sort((a, b) => b.time - a.time).slice(0, MAX_NOTIFS);
      push();
      break;
    case 'notif.posted': {
      const n = sanitizeNotif(msg);
      const existed = state.notifications.some((x) => x.key === n.key);
      state.notifications = [n, ...state.notifications.filter((x) => x.key !== n.key)].slice(0, MAX_NOTIFS);
      if (!existed && !msg.silent && store.settings.desktopNotifications) {
        const head = n.title ? `${n.app} · ${n.title}` : n.app;
        toast(head, n.text, iconFrom(n.icon));
      }
      push();
      break;
    }
    case 'notif.removed':
      state.notifications = state.notifications.filter((x) => x.key !== String(msg.key));
      push();
      break;
    case 'clip':
      if (store.settings.clipboardFromPhone && typeof msg.text === 'string') {
        lastClipFromPhone = msg.text;
        lastClip = msg.text;
        clipboard.writeText(msg.text);
        if (msg.manual && store.settings.desktopNotifications) {
          toast(t('تم النسخ من الهاتف', 'Copied from phone'), msg.text.slice(0, 120));
        }
      }
      break;
    case 'share.text': {
      const text = String(msg.text || '');
      const url = /^https?:\/\/\S+$/i.test(text.trim()) ? text.trim() : null;
      if (url && store.settings.openLinks) {
        shell.openExternal(url);
      } else {
        lastClip = text;
        clipboard.writeText(text);
        toast(t('نص من الهاتف — تم نسخه', 'Text from phone — copied'), text.slice(0, 160));
      }
      break;
    }
    case 'unpaired':
      // The phone unpaired itself.
      store.forgetDevice();
      Object.assign(state, { connected: false, battery: null, notifications: [] });
      setTimeout(() => server.kick(), 100);
      push();
      break;
    case 'ring.state':
      state.ringing = !!msg.on;
      push();
      break;
    default:
      break;
  }
}

// ---- clipboard -----------------------------------------------------------

let lastClip = null;
function watchClipboard() {
  lastClip = clipboard.readText();
  setInterval(() => {
    let text;
    try {
      text = clipboard.readText();
    } catch {
      return;
    }
    if (text === lastClip) return;
    lastClip = text;
    if (!text || text === lastClipFromPhone) return;
    if (store.settings.clipboardAuto && server && server.connected && text.length < 1_000_000) {
      server.send({ t: 'clip', text }).catch(() => {});
    }
  }, 700);
}

// ---- window & tray -------------------------------------------------------

function overlayColors() {
  const dark = store.settings.theme === 'dark' || (store.settings.theme === 'system' && nativeTheme.shouldUseDarkColors);
  return dark ? { color: '#0b0e1a', symbolColor: '#c9cdf0', height: 44 } : { color: '#f4f5fb', symbolColor: '#2a2f4a', height: 44 };
}

function createWindow() {
  const isWin = process.platform === 'win32';
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 580,
    show: false,
    icon: ICON,
    backgroundColor: overlayColors().color,
    title: 'Wasl',
    autoHideMenuBar: true,
    ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: overlayColors() } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  win.on('close', (e) => {
    if (!quitting && store.settings.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function updateTray() {
  if (!tray) return;
  const dev = store.device;
  const status = state.connected
    ? t(`متصل بـ ${dev ? dev.name : ''}`, `Connected to ${dev ? dev.name : ''}`)
    : t('غير متصل', 'Not connected');
  tray.setToolTip(`Wasl — ${status}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: status, enabled: false },
    { type: 'separator' },
    { label: t('فتح وصل', 'Open Wasl'), click: showWindow },
    { label: t('إرسال ملفات…', 'Send files…'), enabled: state.connected, click: pickAndSend },
    { label: t('إرسال الحافظة', 'Send clipboard'), enabled: state.connected, click: sendClipboard },
    { label: t('رنّ الهاتف', 'Ring phone'), enabled: state.connected, click: () => ring(true) },
    { type: 'separator' },
    { label: t('خروج', 'Quit'), click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
}

// ---- actions -------------------------------------------------------------

async function pickAndSend() {
  const r = await dialog.showOpenDialog(win || undefined, { properties: ['openFile', 'multiSelections'] });
  if (!r.canceled) sendFiles(r.filePaths);
}

async function sendFiles(paths) {
  for (const p of paths) {
    try {
      if (fs.statSync(p).isFile()) await transfers.sendFile(p);
    } catch (e) {
      console.log('send failed', e.message);
    }
  }
}

function sendClipboard() {
  const text = clipboard.readText();
  if (text) server.send({ t: 'clip', text, manual: true }).catch(() => {});
}

function ring(on) {
  state.ringing = on;
  server.send({ t: 'ring', on }).catch(() => {});
  push();
}

async function startPairing() {
  const key = server.beginPairing();
  const hosts = lanAddresses();
  const uri = P.pairingUri({ pcId: store.data.pcId, pcName: store.data.pcName, hosts: hosts.length ? hosts : ['127.0.0.1'], port: server.port, key });
  const qr = await QRCode.toDataURL(uri, { margin: 1, width: 320, errorCorrectionLevel: 'M', color: { dark: '#0b0e1a', light: '#ffffff' } });
  state.pairing = { uri, qr, until: server.pending.until, hosts, port: server.port };
  push();
}

function applyLoginItem() {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: store.settings.startWithSystem, args: ['--hidden'] });
}

// ---- IPC -----------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('state', () => publicState());
  ipcMain.handle('pair.start', () => startPairing());
  ipcMain.handle('pair.cancel', () => {
    server.cancelPairing();
    state.pairing = null;
    push();
  });
  ipcMain.handle('unpair', async () => {
    const r = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: [t('إلغاء الربط', 'Unpair'), t('إلغاء', 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('إلغاء ربط الهاتف؟', 'Unpair this phone?'),
      detail: t('ستحتاج إلى مسح رمز QR من جديد لإعادة الربط.', 'You will need to scan a QR code again to reconnect.'),
    });
    if (r.response !== 0) return;
    server.send({ t: 'unpaired' }).catch(() => {});
    store.forgetDevice();
    setTimeout(() => server.kick(), 200);
    Object.assign(state, { connected: false, battery: null, notifications: [] });
    push();
  });
  ipcMain.handle('files.pick', () => pickAndSend());
  ipcMain.handle('files.send', (_e, paths) => sendFiles(Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('files.cancel', (_e, id) => transfers.cancel(String(id)));
  ipcMain.handle('files.open', (_e, p) => {
    if (typeof p === 'string' && p.startsWith(downloadDir())) shell.showItemInFolder(p);
    else shell.openPath(downloadDir());
  });
  ipcMain.handle('files.clear', () => {
    state.transfers = state.transfers.filter((x) => x.state === 'active');
    push();
  });
  ipcMain.handle('clip.send', () => sendClipboard());
  ipcMain.handle('clip.copy', (_e, text) => {
    lastClip = String(text);
    clipboard.writeText(String(text));
  });
  ipcMain.handle('ring', (_e, on) => ring(!!on));
  ipcMain.handle('notif.dismiss', (_e, key) => {
    server.send({ t: 'notif.dismiss', key: String(key) }).catch(() => {});
    state.notifications = state.notifications.filter((x) => x.key !== key);
    push();
  });
  ipcMain.handle('notif.clear', () => {
    for (const n of state.notifications) server.send({ t: 'notif.dismiss', key: n.key }).catch(() => {});
    state.notifications = [];
    push();
  });
  ipcMain.handle('notif.action', (_e, key, i, reply) => {
    const msg = { t: 'notif.action', key: String(key), i: Number(i) };
    if (typeof reply === 'string') msg.reply = reply;
    return server.send(msg).then(() => true, () => false);
  });
  ipcMain.handle('settings.set', (_e, patch) => {
    const s = store.setSettings(patch || {});
    if ('startWithSystem' in patch) applyLoginItem();
    if ('theme' in patch || 'language' in patch) {
      if (win && process.platform === 'win32') win.setTitleBarOverlay(overlayColors());
      updateTray();
    }
    push();
    return s;
  });
  ipcMain.handle('settings.pickDir', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    if (!r.canceled && r.filePaths[0]) store.setSettings({ downloadDir: r.filePaths[0] });
    push();
  });
  ipcMain.handle('open.url', (_e, url) => {
    if (/^https:\/\//.test(String(url))) shell.openExternal(String(url));
  });
}

// ---- lifecycle -----------------------------------------------------------

app.on('second-instance', showWindow);
app.on('before-quit', () => {
  quitting = true;
});
app.on('window-all-closed', () => {
  if (!store.settings.minimizeToTray) app.quit();
});

app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'), safeStorage);
  Menu.setApplicationMenu(null);
  registerIpc();
  await startServer();
  createWindow();
  createTray();
  watchClipboard();
  applyLoginItem();
  nativeTheme.on('updated', () => {
    if (win && process.platform === 'win32') win.setTitleBarOverlay(overlayColors());
    push();
  });
});
