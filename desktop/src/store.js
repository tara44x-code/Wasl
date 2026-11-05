'use strict';
// Settings and pairing data in the user's app-data folder. The pairing key is
// sealed with the OS keystore (DPAPI on Windows, libsecret/kwallet on Linux)
// whenever Electron's safeStorage is available.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULTS = {
  language: 'ar',
  theme: 'dark',
  clipboardAuto: true,
  clipboardFromPhone: true,
  desktopNotifications: true,
  openLinks: true,
  minimizeToTray: true,
  startWithSystem: false,
  downloadDir: '',
};

class Store {
  constructor(dir, safeStorage) {
    this.file = path.join(dir, 'wasl.json');
    this.safe = safeStorage;
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {}
    this.data = {
      pcId: data.pcId || crypto.randomBytes(8).toString('hex'),
      pcName: data.pcName || os.hostname(),
      device: data.device || null,
      settings: { ...DEFAULTS, ...(data.settings || {}) },
    };
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get settings() {
    return this.data.settings;
  }

  setSettings(patch) {
    for (const k of Object.keys(patch)) {
      if (k in DEFAULTS && typeof patch[k] === typeof DEFAULTS[k]) this.data.settings[k] = patch[k];
    }
    this.save();
    return this.data.settings;
  }

  get device() {
    const d = this.data.device;
    return d ? { id: d.id, name: d.name, model: d.model, os: d.os } : null;
  }

  keyFor(deviceId) {
    const d = this.data.device;
    if (!d || d.id !== deviceId) return null;
    try {
      if (d.sealed && this.safe && this.safe.isEncryptionAvailable()) {
        return Buffer.from(this.safe.decryptString(Buffer.from(d.sealed, 'base64')), 'base64');
      }
      if (d.key) return Buffer.from(d.key, 'base64');
    } catch {}
    return null;
  }

  setDevice(dev) {
    const rec = { id: dev.id, name: dev.name, model: dev.model, os: dev.os, pairedAt: Date.now() };
    const b64 = dev.key.toString('base64');
    if (this.safe && this.safe.isEncryptionAvailable()) {
      rec.sealed = this.safe.encryptString(b64).toString('base64');
    } else {
      rec.key = b64;
    }
    this.data.device = rec;
    this.save();
  }

  updateDevice(info) {
    if (!this.data.device) return;
    Object.assign(this.data.device, { name: info.name, model: info.model, os: info.os });
    this.save();
  }

  forgetDevice() {
    this.data.device = null;
    this.save();
  }
}

module.exports = { Store, DEFAULTS };
