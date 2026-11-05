'use strict';
// File transfer in both directions over an established link.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CHUNK = 256 * 1024;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Makes a name from the other device safe to use as a file name here. */
function safeName(name) {
  let n = String(name || 'file').split(/[\\/]/).pop();
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (!n || n === '.' || n === '..') n = 'file';
  if (RESERVED.test(n)) n = `_${n}`;
  if (Buffer.byteLength(n) > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 120) + ext;
  }
  return n;
}

/** Returns dir/name, or dir/name (2).ext etc. if it exists. */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let i = 2; fs.existsSync(p) || fs.existsSync(`${p}.part`); i++) {
    p = path.join(dir, `${base} (${i})${ext}`);
  }
  return p;
}

class Transfers extends EventEmitter {
  /**
   * @param {() => string} downloadDir where received files go
   * @param {(msg, bin) => Promise} send
   */
  constructor(downloadDir, send) {
    super();
    this.downloadDir = downloadDir;
    this.send = send;
    this.incoming = new Map();
    this.outgoing = new Map();
  }

  // ---- receiving -------------------------------------------------------

  handle(msg, bin) {
    switch (msg.t) {
      case 'file.offer': return this.onOffer(msg);
      case 'file.chunk': return this.onChunk(msg, bin);
      case 'file.end': return this.onEnd(msg);
      case 'file.cancel': return this.onCancel(msg);
      default: return false;
    }
  }

  onOffer(msg) {
    const id = String(msg.id);
    const size = Number(msg.size);
    if (this.incoming.has(id) || !Number.isFinite(size) || size < 0) return true;
    const dir = this.downloadDir();
    fs.mkdirSync(dir, { recursive: true });
    const final = uniquePath(dir, safeName(msg.name));
    const part = `${final}.part`;
    const fd = fs.openSync(part, 'w');
    const t = { id, name: path.basename(final), final, part, fd, size, got: 0, hash: crypto.createHash('sha256'), dir: 'in', started: Date.now() };
    this.incoming.set(id, t);
    this.emit('update', this.view(t, 'active'));
    return true;
  }

  onChunk(msg, bin) {
    const t = this.incoming.get(String(msg.id));
    if (!t || !bin) return true;
    if (t.got + bin.length > t.size) {
      this.failIncoming(t, 'too much data');
      return true;
    }
    fs.writeSync(t.fd, bin);
    t.hash.update(bin);
    t.got += bin.length;
    const now = Date.now();
    if (!t.lastEmit || now - t.lastEmit > 150) {
      t.lastEmit = now;
      this.emit('update', this.view(t, 'active'));
    }
    return true;
  }

  onEnd(msg) {
    const t = this.incoming.get(String(msg.id));
    if (!t) return true;
    this.incoming.delete(t.id);
    fs.closeSync(t.fd);
    const digest = t.hash.digest('hex');
    if (t.got !== t.size || (msg.sha256 && msg.sha256 !== digest)) {
      fs.rmSync(t.part, { force: true });
      this.emit('update', this.view(t, 'failed'));
      return true;
    }
    fs.renameSync(t.part, t.final);
    this.emit('update', this.view(t, 'done'));
    this.emit('received', t.final);
    return true;
  }

  onCancel(msg) {
    const id = String(msg.id);
    const t = this.incoming.get(id);
    if (t) {
      this.incoming.delete(id);
      fs.closeSync(t.fd);
      fs.rmSync(t.part, { force: true });
      this.emit('update', this.view(t, 'cancelled'));
    }
    const o = this.outgoing.get(id);
    if (o) o.cancelled = true;
    return true;
  }

  failIncoming(t, why) {
    this.incoming.delete(t.id);
    try { fs.closeSync(t.fd); } catch {}
    fs.rmSync(t.part, { force: true });
    this.send({ t: 'file.cancel', id: t.id, why }).catch(() => {});
    this.emit('update', this.view(t, 'failed'));
  }

  /** The link dropped: throw away half-received files. */
  abortAll() {
    for (const t of this.incoming.values()) {
      try { fs.closeSync(t.fd); } catch {}
      fs.rmSync(t.part, { force: true });
      this.emit('update', this.view(t, 'failed'));
    }
    this.incoming.clear();
    for (const o of this.outgoing.values()) o.cancelled = true;
  }

  // ---- sending ---------------------------------------------------------

  async sendFile(filePath) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const id = crypto.randomBytes(8).toString('hex');
    const t = { id, name: path.basename(filePath), size: stat.size, got: 0, dir: 'out', final: filePath, started: Date.now(), cancelled: false };
    this.outgoing.set(id, t);
    this.emit('update', this.view(t, 'active'));
    const hash = crypto.createHash('sha256');
    try {
      await this.send({ t: 'file.offer', id, name: t.name, size: t.size });
      const stream = fs.createReadStream(filePath, { highWaterMark: CHUNK });
      for await (const chunk of stream) {
        if (t.cancelled) {
          stream.destroy();
          throw new Error('cancelled');
        }
        hash.update(chunk);
        await this.send({ t: 'file.chunk', id }, chunk);
        t.got += chunk.length;
        const now = Date.now();
        if (!t.lastEmit || now - t.lastEmit > 150) {
          t.lastEmit = now;
          this.emit('update', this.view(t, 'active'));
        }
      }
      await this.send({ t: 'file.end', id, sha256: hash.digest('hex') });
      this.emit('update', this.view(t, 'done'));
    } catch (e) {
      this.send({ t: 'file.cancel', id }).catch(() => {});
      this.emit('update', this.view(t, t.cancelled ? 'cancelled' : 'failed'));
    } finally {
      this.outgoing.delete(id);
    }
  }

  cancel(id) {
    const o = this.outgoing.get(id);
    if (o) o.cancelled = true;
    if (this.incoming.has(id)) {
      this.onCancel({ id });
      this.send({ t: 'file.cancel', id }).catch(() => {});
    }
  }

  view(t, state) {
    return { id: t.id, name: t.name, size: t.size, done: t.got, dir: t.dir, state, path: t.final };
  }
}

module.exports = { Transfers, safeName, uniquePath, CHUNK };
