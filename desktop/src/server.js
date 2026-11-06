'use strict';
// The PC side of the link: a TCP server for the phone and a UDP responder so
// the phone can find the PC again when its IP address changes.

const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('./protocol');

const DEFAULT_PORT = 47800;
const DISCOVERY_PORT = 47801;
const HANDSHAKE_TIMEOUT = 10_000;
const PING_EVERY = 15_000;
const IDLE_LIMIT = 45_000;

class Session extends EventEmitter {
  constructor(socket, server) {
    super();
    this.socket = socket;
    this.server = server;
    this.reader = new P.FrameReader();
    this.state = 'hello';
    this.lastSeen = Date.now();
    this.device = null;
    this.pairing = false;
    this.closed = false;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    this.handshakeTimer = setTimeout(() => {
      if (this.state !== 'ready') this.close();
    }, HANDSHAKE_TIMEOUT);
  }

  get remote() {
    return `${this.socket.remoteAddress}:${this.socket.remotePort}`;
  }

  onData(chunk) {
    this.lastSeen = Date.now();
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch {
      return this.close();
    }
    for (const f of frames) {
      if (this.closed) return;
      try {
        this.onFrame(f);
      } catch (e) {
        this.server.emit('log', `session ${this.remote}: ${e.message}`);
        return this.close();
      }
    }
  }

  onFrame({ type, body }) {
    if (this.state === 'hello') {
      if (type !== P.PLAIN) throw new Error('expected hello');
      const msg = JSON.parse(body.toString('utf8'));
      if (msg.t !== 'hello' || msg.v !== P.VERSION) throw new Error('bad hello');
      const nonceC = Buffer.from(String(msg.nonce), 'base64');
      if (nonceC.length !== 16 || !/^[0-9a-f]{16,64}$/.test(String(msg.dev))) throw new Error('bad hello');
      // A phone that just scanned a QR code says so; it must use the new key
      // even if this PC still knows it from an earlier pairing.
      const pending = this.server.pendingKey();
      let key = msg.pair === true && pending ? null : this.server.keyFor(msg.dev);
      if (!key) {
        key = pending;
        this.pairing = !!key;
      }
      if (!key) {
        this.writePlain({ t: 'error', code: 'unpaired' });
        this.socket.end();
        this.state = 'closing';
        return;
      }
      const nonceS = crypto.randomBytes(16);
      const keys = P.sessionKeys(key, nonceC, nonceS);
      this.rx = new P.Cipher(keys.c2s);
      this.tx = new P.Cipher(keys.s2c);
      this.deviceId = msg.dev;
      this.pairKey = key;
      this.writePlain({ t: 'hello', v: P.VERSION, pc: this.server.pcId, nonce: nonceS.toString('base64') });
      this.state = 'auth';
      return;
    }
    if (type !== P.SEALED) throw new Error('unexpected plaintext');
    const { msg, bin } = P.decodePayload(this.rx.open(body));
    if (this.state === 'auth') {
      if (msg.t !== 'auth') throw new Error('expected auth');
      clearTimeout(this.handshakeTimer);
      this.device = {
        id: this.deviceId,
        name: String(msg.name || 'Android').slice(0, 80),
        model: String(msg.model || '').slice(0, 80),
        os: String(msg.os || '').slice(0, 40),
      };
      if (this.pairing) this.server.completePairing({ ...this.device, key: this.pairKey });
      this.state = 'ready';
      this.send({ t: 'welcome', name: this.server.pcName });
      this.server.adopt(this);
      return;
    }
    if (msg.t === 'ping') return void this.send({ t: 'pong' });
    if (msg.t === 'pong') return;
    this.server.emit('message', msg, bin);
  }

  writePlain(msg) {
    this.socket.write(P.frame(P.PLAIN, Buffer.from(JSON.stringify(msg), 'utf8')));
  }

  /** Sends one message; resolves once the socket can take more. */
  send(msg, bin) {
    if (this.closed || !this.tx) return Promise.reject(new Error('not connected'));
    const ok = this.socket.write(P.frame(P.SEALED, this.tx.seal(P.encodePayload(msg, bin))));
    if (ok) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onDrain = () => { cleanup(); resolve(); };
      const onClose = () => { cleanup(); reject(new Error('disconnected')); };
      const cleanup = () => {
        this.socket.off('drain', onDrain);
        this.off('closed', onClose);
      };
      this.socket.once('drain', onDrain);
      this.once('closed', onClose);
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.handshakeTimer);
    this.socket.destroy();
    this.emit('closed');
  }
}

class LinkServer extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.pcId
   * @param {string} o.pcName
   * @param {(deviceId: string) => Buffer|null} o.keyFor key of a paired device
   * @param {number} [o.port]
   */
  constructor(o) {
    super();
    this.pcId = o.pcId;
    this.pcName = o.pcName;
    this.keyFor = o.keyFor;
    this.port = o.port || DEFAULT_PORT;
    this.discoveryPort = o.discoveryPort === undefined ? DISCOVERY_PORT : o.discoveryPort;
    this.pending = null;
    this.session = null;
    this.sessions = new Set();
  }

  start() {
    return new Promise((resolve, reject) => {
      this.tcp = net.createServer((socket) => {
        if (this.sessions.size > 8) return void socket.destroy();
        const s = new Session(socket, this);
        this.sessions.add(s);
        s.on('closed', () => {
          this.sessions.delete(s);
          if (this.session === s) {
            this.session = null;
            this.emit('disconnected');
          }
        });
      });
      this.tcp.once('error', reject);
      this.tcp.listen(this.port, '0.0.0.0', () => {
        this.port = this.tcp.address().port;
        this.tcp.off('error', reject);
        this.tcp.on('error', (e) => this.emit('log', `tcp: ${e.message}`));
        this.startDiscovery();
        this.pingTimer = setInterval(() => this.heartbeat(), PING_EVERY);
        resolve(this.port);
      });
    });
  }

  startDiscovery() {
    if (this.discoveryPort === null) return;
    const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    udp.on('error', (e) => this.emit('log', `udp: ${e.message}`));
    udp.on('message', (m, rinfo) => {
      const text = m.toString('utf8');
      if (text === `WASL?${this.pcId}`) {
        udp.send(Buffer.from(`WASL!${this.pcId}:${this.port}`), rinfo.port, rinfo.address);
      }
    });
    udp.bind(this.discoveryPort);
    this.udp = udp;
  }

  heartbeat() {
    const s = this.session;
    if (!s) return;
    if (Date.now() - s.lastSeen > IDLE_LIMIT) return void s.close();
    s.send({ t: 'ping' }).catch(() => {});
  }

  /** Opens a pairing window with a fresh key; returns the key. */
  beginPairing(ttlMs = 5 * 60_000) {
    const key = crypto.randomBytes(32);
    this.pending = { key, until: Date.now() + ttlMs };
    return key;
  }

  cancelPairing() {
    this.pending = null;
  }

  pendingKey() {
    if (!this.pending) return null;
    if (Date.now() > this.pending.until) {
      this.pending = null;
      return null;
    }
    return this.pending.key;
  }

  completePairing(device) {
    this.pending = null;
    this.emit('paired', device);
  }

  adopt(session) {
    const old = this.session;
    this.session = session;
    // The old session's close handler sees it is no longer current and stays quiet.
    if (old && old !== session) old.close();
    this.emit('connected', session.device, session.remote);
  }

  get connected() {
    return !!this.session;
  }

  send(msg, bin) {
    if (!this.session) return Promise.reject(new Error('not connected'));
    return this.session.send(msg, bin);
  }

  /** Drops the current phone, e.g. after unpairing. */
  kick() {
    if (this.session) this.session.close();
  }

  stop() {
    clearInterval(this.pingTimer);
    for (const s of this.sessions) s.close();
    if (this.udp) this.udp.close();
    return new Promise((r) => (this.tcp ? this.tcp.close(() => r()) : r()));
  }
}

module.exports = { LinkServer, DEFAULT_PORT, DISCOVERY_PORT };
