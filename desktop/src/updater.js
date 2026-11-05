'use strict';
// Checks GitHub Releases for a newer version, downloads the installer for this
// platform, verifies it against SHA256SUMS.txt and runs it.

const { app, net, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const API = 'https://api.github.com/repos/tara44x-code/Wasl/releases/latest';

function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

function assetFor(assets) {
  if (process.platform === 'win32') return assets.find((a) => /^Wasl-Setup-.*\.exe$/i.test(a.name));
  if (process.platform === 'linux' && process.env.APPIMAGE) return assets.find((a) => /\.AppImage$/i.test(a.name));
  return null;
}

class Updater extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle' }; // idle | checking | current | available | downloading | ready | error
  }

  set(s) {
    this.state = s;
    this.emit('state', s);
  }

  async fetchJson(url) {
    const r = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Wasl-Desktop' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async check() {
    if (this.state.status === 'downloading') return this.state;
    this.set({ status: 'checking' });
    try {
      const rel = await this.fetchJson(API);
      const version = String(rel.tag_name || '').replace(/^v/, '');
      if (!newer(version, app.getVersion())) return this.set({ status: 'current', version: app.getVersion() }), this.state;
      const asset = assetFor(rel.assets || []);
      const sums = (rel.assets || []).find((a) => a.name === 'SHA256SUMS.txt');
      this.release = { version, url: rel.html_url, asset, sums, notes: rel.body || '' };
      this.set({ status: 'available', version, canInstall: !!asset, url: rel.html_url });
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
    return this.state;
  }

  async install() {
    const rel = this.release;
    if (!rel) return;
    if (!rel.asset) {
      shell.openExternal(rel.url);
      return;
    }
    try {
      this.set({ status: 'downloading', version: rel.version, percent: 0 });
      const r = await net.fetch(rel.asset.browser_download_url, { headers: { 'User-Agent': 'Wasl-Desktop' } });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      const total = Number(r.headers.get('content-length')) || rel.asset.size || 0;
      const file = path.join(os.tmpdir(), rel.asset.name);
      const out = fs.createWriteStream(file);
      const hash = crypto.createHash('sha256');
      let done = 0;
      let last = 0;
      const reader = r.body.getReader();
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        const buf = Buffer.from(value);
        hash.update(buf);
        if (!out.write(buf)) await new Promise((res) => out.once('drain', res));
        done += buf.length;
        const now = Date.now();
        if (now - last > 200 && total) {
          last = now;
          this.set({ status: 'downloading', version: rel.version, percent: Math.round((done / total) * 100) });
        }
      }
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      const hex = hash.digest('hex');
      if (rel.sums) {
        const sums = await (await net.fetch(rel.sums.browser_download_url, { headers: { 'User-Agent': 'Wasl-Desktop' } })).text();
        const line = sums.split(/\r?\n/).find((l) => l.trim().endsWith(rel.asset.name));
        const expected = line ? line.trim().split(/\s+/)[0].toLowerCase() : null;
        if (expected && expected !== hex) throw new Error('checksum mismatch');
      }
      this.set({ status: 'ready', version: rel.version });
      this.apply(file);
    } catch (e) {
      this.set({ status: 'error', error: e.message });
    }
  }

  apply(file) {
    if (process.platform === 'win32') {
      // Silent install, then the installer starts the new version.
      spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore' }).unref();
      setTimeout(() => app.exit(0), 500);
    } else if (process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      fs.copyFileSync(file, `${target}.new`);
      fs.chmodSync(`${target}.new`, 0o755);
      fs.renameSync(`${target}.new`, target);
      app.relaunch({ execPath: target });
      app.exit(0);
    }
  }
}

module.exports = { Updater, newer };
