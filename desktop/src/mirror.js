'use strict';
// Screen mirroring and remote control over ADB, using scrcpy's server
// (Apache-2.0, https://github.com/Genymobile/scrcpy). Works over a USB cable
// (USB debugging) and over Wi-Fi (wireless debugging, or adb tcpip).

const { BrowserWindow, ipcMain, app, screen, clipboard } = require('electron');
const { execFile, spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRCPY_VERSION = '3.3.4';
const SERVER_REMOTE = '/data/local/tmp/wasl-scrcpy.jar';
const CODEC_H264 = 0x68323634;
const CODEC_OPUS = 0x6f707573;

const QUALITY = {
  low: { maxSize: 1024, bitRate: 3_000_000, fps: 30 },
  balanced: { maxSize: 1600, bitRate: 8_000_000, fps: 60 },
  high: { maxSize: 0, bitRate: 16_000_000, fps: 60 },
};

/** Buffered reads from a socket: await r.read(n). */
class SocketReader {
  constructor(sock) {
    this.sock = sock;
    this.chunks = [];
    this.len = 0;
    this.waiters = [];
    this.ended = false;
    sock.on('data', (d) => {
      this.chunks.push(d);
      this.len += d.length;
      this.flush();
    });
    const end = () => {
      this.ended = true;
      this.flush();
    };
    sock.on('end', end);
    sock.on('close', end);
    sock.on('error', end);
  }

  flush() {
    while (this.waiters.length) {
      const w = this.waiters[0];
      if (this.len >= w.n) {
        this.waiters.shift();
        w.resolve(this.take(w.n));
      } else if (this.ended) {
        this.waiters.shift();
        w.reject(new Error('socket closed'));
      } else break;
    }
  }

  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
    return out;
  }

  read(n) {
    return new Promise((resolve, reject) => {
      this.waiters.push({ n, resolve, reject });
      this.flush();
    });
  }
}

// ---- control messages (scrcpy 3.3.4 ControlMessageReader) ------------------

const C = {
  touch(action, pointerId, x, y, w, h, pressure, actionButton, buttons) {
    const b = Buffer.alloc(32);
    let o = 0;
    b[o++] = 2;
    b[o++] = action;
    b.writeBigInt64BE(BigInt(pointerId), o); o += 8;
    b.writeInt32BE(Math.round(x), o); o += 4;
    b.writeInt32BE(Math.round(y), o); o += 4;
    b.writeUInt16BE(w, o); o += 2;
    b.writeUInt16BE(h, o); o += 2;
    b.writeUInt16BE(pressure >= 1 ? 0xffff : Math.round(pressure * 0x10000), o); o += 2;
    b.writeInt32BE(actionButton, o); o += 4;
    b.writeInt32BE(buttons, o);
    return b;
  },
  scroll(x, y, w, h, hs, vs) {
    const fx = (v) => {
      const f = Math.max(-1, Math.min(1, v / 16));
      return f >= 1 ? 0x7fff : Math.round(f * 0x8000);
    };
    const b = Buffer.alloc(21);
    let o = 0;
    b[o++] = 3;
    b.writeInt32BE(Math.round(x), o); o += 4;
    b.writeInt32BE(Math.round(y), o); o += 4;
    b.writeUInt16BE(w, o); o += 2;
    b.writeUInt16BE(h, o); o += 2;
    b.writeInt16BE(fx(hs), o); o += 2;
    b.writeInt16BE(fx(vs), o); o += 2;
    b.writeInt32BE(0, o);
    return b;
  },
  key(action, keycode, repeat = 0, meta = 0) {
    const b = Buffer.alloc(14);
    b[0] = 0;
    b[1] = action;
    b.writeInt32BE(keycode, 2);
    b.writeInt32BE(repeat, 6);
    b.writeInt32BE(meta, 10);
    return b;
  },
  text(s) {
    const t = Buffer.from(String(s), 'utf8').subarray(0, 300);
    const b = Buffer.alloc(5 + t.length);
    b[0] = 1;
    b.writeUInt32BE(t.length, 1);
    t.copy(b, 5);
    return b;
  },
  backOrScreenOn(action) {
    return Buffer.from([4, action]);
  },
  setClipboard(text, paste) {
    const t = Buffer.from(String(text), 'utf8').subarray(0, 256 * 1024);
    const b = Buffer.alloc(14 + t.length);
    b[0] = 9;
    b.writeBigInt64BE(BigInt(Date.now()), 1);
    b[9] = paste ? 1 : 0;
    b.writeUInt32BE(t.length, 10);
    t.copy(b, 14);
    return b;
  },
  displayPower(on) {
    return Buffer.from([10, on ? 1 : 0]);
  },
  simple(type) {
    return Buffer.from([type]);
  },
};

const POINTER_FINGER = -2; // scrcpy POINTER_ID_GENERIC_FINGER

class Mirror {
  /** @param {object} ctx { state, store, push, t, icon, dataDir, resources, isPackaged, link } */
  constructor(ctx) {
    Object.assign(this, ctx);
    this.state.mirror = { adb: false, devices: [], active: null, status: 'idle', error: '', size: null };
    this.session = null;
    this.win = null;
    this.adbPath = this.findAdb();
    this.serverPath = this.findServer();
    this.state.mirror.adb = !!(this.adbPath && this.serverPath);
    if (this.state.mirror.adb) {
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), 4000);
    }
  }

  // ---- adb ---------------------------------------------------------------

  findAdb() {
    const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
    const candidates = [
      path.join(this.resources || '', 'adb', exe),
      path.join(__dirname, '..', 'vendor', process.platform === 'win32' ? 'win' : 'linux', exe),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return exe; // try PATH
  }

  findServer() {
    const candidates = [
      path.join(this.resources || '', 'adb', 'scrcpy-server'),
      path.join(__dirname, '..', 'vendor', 'scrcpy-server'),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return null;
  }

  adb(args, timeout = 15_000) {
    return new Promise((resolve, reject) => {
      execFile(this.adbPath, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') this.state.mirror.adb = false;
          return reject(new Error((stderr || err.message || '').trim()));
        }
        resolve(String(stdout));
      });
    });
  }

  async poll() {
    try {
      const out = await this.adb(['devices', '-l'], 8000);
      const devices = [];
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = line.trim().match(/^(\S+)\s+(device|unauthorized|offline)\b(.*)$/);
        if (!m) continue;
        const model = (m[3].match(/model:(\S+)/) || [])[1] || '';
        const wifi = /:\d+$/.test(m[1]) || m[1].includes('._adb-tls-connect');
        devices.push({ serial: m[1], state: m[2], model: model.replace(/_/g, ' '), transport: wifi ? 'wifi' : 'usb' });
      }
      const before = JSON.stringify(this.state.mirror.devices);
      this.state.mirror.devices = devices;
      this.state.mirror.adb = true;
      if (before !== JSON.stringify(devices)) this.push();
      if (this.session && !devices.some((d) => d.serial === this.session.serial && d.state === 'device')) this.stop();
    } catch {
      // adb missing or busy; try again on the next tick
    }
  }

  /** The phone's IP on the Wi-Fi, from the Wasl link. */
  phoneIp() {
    const r = this.state.remote || '';
    const ip = r.replace(/^::ffff:/, '').replace(/:\d+$/, '');
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  }

  /** Switches a USB-connected phone to adb over Wi-Fi (port 5555) and connects. */
  async enableWifi(serial) {
    const ip = this.phoneIp() || (await this.adb(['-s', serial, 'shell', 'ip', 'route']).then((o) => (o.match(/src (\d+\.\d+\.\d+\.\d+)/) || [])[1]).catch(() => null));
    if (!ip) throw new Error('no-ip');
    await this.adb(['-s', serial, 'tcpip', '5555']);
    await new Promise((r) => setTimeout(r, 1500));
    const out = await this.adb(['connect', `${ip}:5555`]);
    if (!/connected/i.test(out)) throw new Error(out.trim());
    await this.poll();
    return `${ip}:5555`;
  }

  /** Android 11+ wireless debugging: pair with the code shown on the phone. */
  async pair(hostPort, code) {
    const out = await this.adb(['pair', hostPort, String(code)], 20_000);
    if (!/success/i.test(out)) throw new Error(out.trim() || 'pair failed');
    // After pairing, the phone advertises its connect port over mDNS.
    await this.autoConnect();
    return out.trim();
  }

  async connect(hostPort) {
    const out = await this.adb(['connect', hostPort]);
    if (!/connected/i.test(out) || /failed|cannot/i.test(out)) throw new Error(out.trim());
    await this.poll();
  }

  /** Finds the phone's wireless-debugging port over mDNS and connects. */
  async autoConnect() {
    try {
      const out = await this.adb(['mdns', 'services'], 8000);
      const ip = this.phoneIp();
      const lines = out.split(/\r?\n/).filter((l) => l.includes('_adb-tls-connect'));
      const pick = lines.find((l) => ip && l.includes(ip)) || lines[0];
      const m = pick && pick.match(/(\d+\.\d+\.\d+\.\d+:\d+)/);
      if (m) await this.connect(m[1]);
    } catch {}
    await this.poll();
  }

  /** The best device: USB first, then Wi-Fi. */
  pickDevice() {
    const ok = this.state.mirror.devices.filter((d) => d.state === 'device');
    return ok.find((d) => d.transport === 'usb') || ok[0] || null;
  }

  // ---- session -------------------------------------------------------------

  async toggle() {
    if (this.session) return this.stop();
    return this.start();
  }

  async start(serial) {
    if (this.session) {
      this.showWindow();
      return;
    }
    if (!this.state.mirror.adb) throw new Error('adb-missing');
    let dev = serial ? this.state.mirror.devices.find((d) => d.serial === serial) : this.pickDevice();
    if (!dev) {
      await this.autoConnect();
      dev = this.pickDevice();
    }
    if (!dev) {
      this.setStatus('error', 'no-device');
      return;
    }
    if (dev.state === 'unauthorized') {
      this.setStatus('error', 'unauthorized');
      return;
    }
    this.setStatus('starting');
    const s = { serial: dev.serial, model: dev.model, transport: dev.transport, sockets: [], proc: null, port: 0 };
    this.session = s;
    this.state.mirror.active = dev.serial;
    try {
      await this.launch(s);
      this.setStatus('running');
    } catch (e) {
      this.stop();
      this.setStatus('error', e.message);
    }
  }

  async launch(s) {
    const settings = this.store.settings;
    const q = QUALITY[settings.mirrorQuality] || QUALITY.balanced;
    const scid = crypto.randomBytes(4).readUInt32BE(0) & 0x7fffffff;
    const scidHex = scid.toString(16).padStart(8, '0');
    await this.adb(['-s', s.serial, 'push', this.serverPath, SERVER_REMOTE], 30_000);
    const fwd = await this.adb(['-s', s.serial, 'forward', 'tcp:0', `localabstract:scrcpy_${scidHex}`]);
    s.port = parseInt(fwd.trim(), 10);
    if (!s.port) throw new Error('forward failed');
    s.forward = `tcp:${s.port}`;

    const audio = settings.mirrorAudio !== false;
    const args = [
      '-s', s.serial, 'shell',
      `CLASSPATH=${SERVER_REMOTE}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', SCRCPY_VERSION,
      `scid=${scidHex}`, 'log_level=warn', 'tunnel_forward=true',
      `audio=${audio}`, 'control=true', 'video_codec=h264', 'audio_codec=opus',
      `max_size=${q.maxSize}`, `video_bit_rate=${q.bitRate}`, `max_fps=${q.fps}`,
      'stay_awake=true', 'clipboard_autosync=true', 'power_off_on_close=false', 'cleanup=true',
    ];
    s.proc = spawn(this.adbPath, args, { windowsHide: true });
    s.proc.stderr.on('data', (d) => console.log('[scrcpy]', String(d).trim()));
    s.proc.stdout.on('data', (d) => console.log('[scrcpy]', String(d).trim()));
    s.proc.on('exit', () => {
      if (this.session === s) this.stop();
    });

    // First socket: dummy byte, device name, then video codec meta.
    const video = await this.connectWithRetry(s.port);
    s.sockets.push(video.sock);
    const name = (await video.reader.read(64)).toString('utf8').replace(/\0.*$/s, '');
    const meta = await video.reader.read(12);
    if (meta.readUInt32BE(0) !== CODEC_H264) throw new Error('video unavailable');
    s.size = { w: meta.readUInt32BE(4), h: meta.readUInt32BE(8) };
    s.name = name;

    let audioConn = null;
    if (audio) {
      audioConn = await this.connectOnce(s.port);
      s.sockets.push(audioConn.sock);
    }
    const control = await this.connectOnce(s.port);
    s.sockets.push(control.sock);
    s.control = control.sock;
    control.sock.on('data', () => {}); // device messages (clipboard) are ignored; autosync handles it

    this.openWindow(s);
    this.pumpVideo(s, video.reader);
    if (audioConn) this.pumpAudio(s, audioConn.reader);
  }

  connectOnce(port) {
    return new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.setNoDelay(true);
      sock.once('connect', () => resolve({ sock, reader: new SocketReader(sock) }));
      sock.once('error', reject);
    });
  }

  async connectWithRetry(port) {
    for (let i = 0; i < 100; i++) {
      let c = null;
      try {
        c = await this.connectOnce(port);
        await c.reader.read(1); // the dummy byte proves the server is there
        return c;
      } catch {
        if (c) c.sock.destroy();
        if (!this.session) throw new Error('cancelled');
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error('server did not start');
  }

  async pumpVideo(s, reader) {
    try {
      for (;;) {
        const head = await reader.read(12);
        const ptsFlags = head.readBigUInt64BE(0);
        const size = head.readUInt32BE(8);
        const data = await reader.read(size);
        const config = (ptsFlags >> 63n) & 1n;
        const key = (ptsFlags >> 62n) & 1n;
        const pts = Number(ptsFlags & 0x3fffffffffffffffn);
        if (this.win && !this.win.isDestroyed()) {
          this.win.webContents.send('mirror.video', { config: !!config, key: !!key, pts, data: new Uint8Array(data) });
        }
      }
    } catch {
      if (this.session === s) this.stop();
    }
  }

  async pumpAudio(s, reader) {
    try {
      const codec = (await reader.read(4)).readUInt32BE(0);
      if (codec !== CODEC_OPUS) return; // 0: the phone can't capture audio (Android < 11)
      for (;;) {
        const head = await reader.read(12);
        const ptsFlags = head.readBigUInt64BE(0);
        const size = head.readUInt32BE(8);
        const data = await reader.read(size);
        if ((ptsFlags >> 63n) & 1n) continue; // config packet
        if (this.win && !this.win.isDestroyed()) {
          this.win.webContents.send('mirror.audio', { pts: Number(ptsFlags & 0x3fffffffffffffffn), data: new Uint8Array(data) });
        }
      }
    } catch {}
  }

  control(buf) {
    const s = this.session;
    if (s && s.control && !s.control.destroyed) s.control.write(buf);
  }

  /** Input from the mirror window. */
  input(e) {
    const s = this.session;
    if (!s || !e) return;
    const W = Number(e.w) | 0;
    const H = Number(e.h) | 0;
    switch (e.type) {
      case 'touch': {
        const action = { down: 0, up: 1, move: 2 }[e.action];
        if (action === undefined) return;
        this.control(C.touch(action, POINTER_FINGER, e.x, e.y, W, H, action === 1 ? 0 : 1, 0, 0));
        break;
      }
      case 'scroll':
        this.control(C.scroll(e.x, e.y, W, H, Number(e.hs) || 0, Number(e.vs) || 0));
        break;
      case 'key':
        this.control(C.key(e.action === 'up' ? 1 : 0, Number(e.keycode) | 0, 0, Number(e.meta) | 0));
        break;
      case 'press': // down + up
        this.control(C.key(0, Number(e.keycode) | 0));
        this.control(C.key(1, Number(e.keycode) | 0));
        break;
      case 'text':
        this.control(C.text(e.text));
        break;
      case 'back':
        this.control(C.backOrScreenOn(0));
        this.control(C.backOrScreenOn(1));
        break;
      case 'pastePC':
        this.control(C.setClipboard(clipboard.readText(), true));
        break;
      case 'screen':
        this.control(C.displayPower(!!e.on));
        break;
      case 'rotate':
        this.control(C.simple(11));
        break;
      case 'notifications':
        this.control(C.simple(5));
        break;
      case 'quick':
        this.control(C.simple(6));
        break;
      default:
        break;
    }
  }

  // ---- window ------------------------------------------------------------

  openWindow(s) {
    const area = screen.getPrimaryDisplay().workArea;
    const maxH = Math.round(area.height * 0.88);
    const ratio = s.size.w / s.size.h;
    const h = Math.min(maxH, 900);
    const w = Math.max(320, Math.round(h * ratio) + 0);
    this.win = new BrowserWindow({
      width: w,
      height: h + 52,
      minWidth: 260,
      minHeight: 300,
      title: `${s.name || s.model || 'Phone'} — Wasl`,
      backgroundColor: '#05060c',
      icon: this.icon,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-mirror.js'),
        contextIsolation: true,
        sandbox: true,
      },
    });
    this.win.loadFile(path.join(__dirname, 'renderer', 'mirror.html'), {
      query: { lang: this.store.settings.language, w: String(s.size.w), h: String(s.size.h), name: s.name || s.model || '' },
    });
    this.win.on('closed', () => {
      this.win = null;
      if (this.session === s) this.stop();
    });
  }

  showWindow() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show();
      this.win.focus();
    }
  }

  setStatus(status, error = '') {
    Object.assign(this.state.mirror, { status, error });
    this.push();
  }

  stop() {
    const s = this.session;
    this.session = null;
    this.state.mirror.active = null;
    if (this.state.mirror.status !== 'error') this.state.mirror.status = 'idle';
    if (s) {
      for (const sock of s.sockets) sock.destroy();
      if (s.proc) s.proc.kill();
      if (s.forward) this.adb(['-s', s.serial, 'forward', '--remove', s.forward]).catch(() => {});
    }
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.push();
  }

  stopAll() {
    clearInterval(this.pollTimer);
    this.stop();
  }

  registerIpc() {
    const wrap = (fn) => async (...a) => {
      try {
        return { ok: true, result: await fn(...a) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };
    ipcMain.handle('mirror.start', wrap((_e, serial) => this.start(serial)));
    ipcMain.handle('mirror.stop', wrap(() => this.stop()));
    ipcMain.handle('mirror.wifi', wrap((_e, serial) => this.enableWifi(serial)));
    ipcMain.handle('mirror.pair', wrap((_e, hostPort, code) => this.pair(String(hostPort), String(code))));
    ipcMain.handle('mirror.connect', wrap((_e, hostPort) => this.connect(String(hostPort))));
    ipcMain.handle('mirror.refresh', wrap(() => this.autoConnect()));
    ipcMain.on('mirror.input', (_e, ev) => this.input(ev));
    ipcMain.handle('mirror.screenshot', wrap((_e, dataUrl) => {
      const dir = path.join(app.getPath('pictures'), 'Wasl');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `Screenshot ${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      fs.writeFileSync(file, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
      return file;
    }));
  }
}

module.exports = { Mirror, C, SocketReader };
