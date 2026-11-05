'use strict';
// Phone features on the PC side: media, quick controls, calls, messages,
// clipboard history and the incoming-call popup.

const { BrowserWindow, ipcMain, clipboard, screen } = require('electron');
const path = require('path');
const fs = require('fs');

const HISTORY_MAX = 50;

class Phone {
  /**
   * @param {object} ctx { state, store, server, push, toast, t, showWindow, dataDir, icon }
   */
  constructor(ctx) {
    Object.assign(this, ctx);
    const s = this.state;
    s.media = null;
    s.status = null;
    s.call = null;
    s.calllog = null;
    s.contacts = null;
    s.smsThreads = null;
    s.smsThread = null;
    s.phoneVersion = '';
    s.seenApps = {};
    this.historyFile = path.join(this.dataDir, 'clipboard-history.json');
    try {
      s.clipHistory = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      if (!Array.isArray(s.clipHistory)) s.clipHistory = [];
    } catch {
      s.clipHistory = [];
    }
    this.callWin = null;
  }

  send(msg) {
    return this.server.send(msg).then(() => true, () => false);
  }

  onConnected() {
    this.sendFilter();
  }

  onDisconnected() {
    Object.assign(this.state, { media: null, status: null, call: null });
    this.closeCallWindow();
  }

  sendFilter() {
    this.send({ t: 'notif.filter', muted: this.store.settings.mutedApps || [] });
  }

  inQuietHours() {
    const st = this.store.settings;
    if (!st.quietEnabled) return false;
    const toMin = (s) => {
      const [h, m] = String(s).split(':').map((x) => parseInt(x, 10) || 0);
      return h * 60 + m;
    };
    const now = new Date();
    const n = now.getHours() * 60 + now.getMinutes();
    const a = toMin(st.quietFrom);
    const b = toMin(st.quietTo);
    return a <= b ? n >= a && n < b : n >= a || n < b;
  }

  // ---- messages from the phone -------------------------------------------

  handle(msg) {
    const s = this.state;
    switch (msg.t) {
      case 'hello.phone':
        s.phoneVersion = String(msg.version || '');
        break;
      case 'status':
        s.status = msg;
        break;
      case 'media':
        s.media = msg.active ? msg : null;
        break;
      case 'call':
        this.onCall(msg);
        break;
      case 'calllog':
        s.calllog = { allowed: !!msg.allowed, items: Array.isArray(msg.items) ? msg.items : [] };
        break;
      case 'contacts':
        s.contacts = Array.isArray(msg.items) ? msg.items : [];
        break;
      case 'sms.threads':
        s.smsThreads = { allowed: !!msg.allowed, items: Array.isArray(msg.items) ? msg.items : [] };
        break;
      case 'sms.thread':
        s.smsThread = { thread: msg.thread, address: msg.address, name: msg.name, items: (msg.items || []).slice().reverse() };
        break;
      case 'sms.new':
        this.onSms(msg);
        break;
      case 'sms.sent':
        if (!msg.ok) this.toast(this.t('تعذّر إرسال الرسالة', 'Message not sent'), String(msg.address || ''));
        setTimeout(() => this.refreshSms(), 1200);
        break;
      default:
        return false;
    }
    this.push();
    return true;
  }

  noteApp(n) {
    if (n.pkg && !this.state.seenApps[n.pkg]) this.state.seenApps[n.pkg] = n.app || n.pkg;
  }

  onCall(msg) {
    const prev = this.state.call;
    const call = { state: msg.state, number: String(msg.number || ''), name: String(msg.name || ''), since: Date.now() };
    this.state.call = msg.state === 'idle' ? null : call;
    if (msg.state === 'ringing') {
      this.openCallWindow();
      this.toast(this.t('مكالمة واردة', 'Incoming call'), call.name || call.number || this.t('رقم مخفي', 'Unknown number'));
    } else if (msg.state === 'idle') {
      this.closeCallWindow();
      if (prev && prev.state === 'ringing') {
        this.toast(this.t('مكالمة فائتة', 'Missed call'), prev.name || prev.number);
      }
    } else if (this.callWin) {
      this.callWin.webContents.send('call', this.state.call);
    }
  }

  onSms(msg) {
    const who = msg.name || msg.address;
    if (!this.inQuietHours() && this.store.settings.desktopNotifications) {
      this.toast(`${this.t('رسالة من', 'Message from')} ${who}`, String(msg.body || '').slice(0, 200));
    }
    this.refreshSms();
  }

  refreshSms() {
    this.send({ t: 'sms.threads.request' });
    const cur = this.state.smsThread;
    if (cur) this.send({ t: 'sms.thread.request', thread: cur.thread });
  }

  // ---- incoming call popup ----------------------------------------------

  openCallWindow() {
    if (this.callWin && !this.callWin.isDestroyed()) {
      this.callWin.webContents.send('call', this.state.call);
      this.callWin.showInactive();
      return;
    }
    const { workArea } = screen.getPrimaryDisplay();
    const w = 360;
    const h = 150;
    this.callWin = new BrowserWindow({
      width: w,
      height: h,
      x: workArea.x + workArea.width - w - 16,
      y: workArea.y + workArea.height - h - 16,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      transparent: true,
      focusable: true,
      icon: this.icon,
      webPreferences: {
        preload: path.join(__dirname, 'preload-call.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.callWin.loadFile(path.join(__dirname, 'renderer', 'call.html'), {
      query: { lang: this.store.settings.language, theme: this.store.settings.theme },
    });
    this.callWin.once('ready-to-show', () => {
      this.callWin.webContents.send('call', this.state.call);
      this.callWin.showInactive();
    });
    this.callWin.on('closed', () => {
      this.callWin = null;
    });
  }

  closeCallWindow() {
    if (this.callWin && !this.callWin.isDestroyed()) this.callWin.close();
    this.callWin = null;
  }

  // ---- clipboard history --------------------------------------------------

  remember(text, from) {
    if (!this.store.settings.clipHistory || !text || text.length > 100_000) return;
    // One-time codes are not kept.
    if (/^\s*\d{4,8}\s*$/.test(text)) return;
    const h = this.state.clipHistory.filter((x) => x.text !== text);
    const pinned = this.state.clipHistory.find((x) => x.text === text && x.pinned);
    h.unshift({ text, from, time: Date.now(), pinned: !!pinned });
    const pins = h.filter((x) => x.pinned);
    const rest = h.filter((x) => !x.pinned).slice(0, HISTORY_MAX);
    this.state.clipHistory = h.filter((x) => pins.includes(x) || rest.includes(x));
    this.saveHistory();
    this.push();
  }

  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.state.clipHistory), { mode: 0o600 });
    } catch {}
  }

  // ---- IPC ---------------------------------------------------------------

  registerIpc() {
    const s = this.state;
    ipcMain.handle('media.cmd', (_e, cmd, pos) => this.send({ t: 'media.cmd', cmd: String(cmd), pos: Number(pos) || 0 }));
    ipcMain.handle('toggle', (_e, what, value) => this.send({ t: 'toggle', what: String(what), value }));
    ipcMain.handle('volume', (_e, stream, value) => this.send({ t: 'volume.set', stream: String(stream), value: Number(value) }));
    ipcMain.handle('nav', (_e, action) => this.send({ t: 'nav', action: String(action) }));
    ipcMain.handle('call.cmd', (_e, cmd) => this.send({ t: 'call.cmd', cmd: String(cmd) }));
    ipcMain.handle('call.dial', (_e, number) => this.send({ t: 'call.dial', number: String(number) }));
    ipcMain.handle('calllog', () => this.send({ t: 'calllog.request' }));
    ipcMain.handle('contacts', () => this.send({ t: 'contacts.request' }));
    ipcMain.handle('sms.threads', () => this.send({ t: 'sms.threads.request' }));
    ipcMain.handle('sms.open', (_e, thread) => {
      s.smsThread = s.smsThread && s.smsThread.thread === thread ? s.smsThread : { thread, items: [], loading: true };
      this.push();
      return this.send({ t: 'sms.thread.request', thread: Number(thread) });
    });
    ipcMain.handle('sms.close', () => {
      s.smsThread = null;
      this.push();
    });
    ipcMain.handle('sms.send', (_e, address, body) => {
      const msg = { t: 'sms.send', address: String(address), body: String(body), ref: String(Date.now()) };
      if (s.smsThread && s.smsThread.address === address) {
        s.smsThread.items.push({ id: `p${msg.ref}`, body: msg.body, date: Date.now(), out: true, pending: true });
        this.push();
      }
      return this.send(msg);
    });
    ipcMain.handle('clip.history.copy', (_e, i) => {
      const item = s.clipHistory[i];
      if (item) clipboard.writeText(item.text);
    });
    ipcMain.handle('clip.history.pin', (_e, i) => {
      const item = s.clipHistory[i];
      if (item) item.pinned = !item.pinned;
      this.saveHistory();
      this.push();
    });
    ipcMain.handle('clip.history.delete', (_e, i) => {
      s.clipHistory.splice(i, 1);
      this.saveHistory();
      this.push();
    });
    ipcMain.handle('clip.history.clear', () => {
      s.clipHistory = s.clipHistory.filter((x) => x.pinned);
      this.saveHistory();
      this.push();
    });
    ipcMain.handle('notif.mute', (_e, pkg, muted) => {
      const set = new Set(this.store.settings.mutedApps || []);
      if (muted) set.add(String(pkg));
      else set.delete(String(pkg));
      this.store.setSettings({ mutedApps: [...set] });
      if (muted) s.notifications = s.notifications.filter((n) => n.pkg !== pkg);
      this.sendFilter();
      this.push();
    });
    // From the call popup.
    ipcMain.on('callwin', (_e, action) => {
      if (action === 'answer') this.send({ t: 'call.cmd', cmd: 'answer' });
      if (action === 'decline') this.send({ t: 'call.cmd', cmd: 'decline' });
      if (action === 'open') this.showWindow();
      if (action === 'close' || action === 'decline') this.closeCallWindow();
    });
  }
}

module.exports = { Phone };
