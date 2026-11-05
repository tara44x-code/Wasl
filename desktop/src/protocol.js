'use strict';
// Wasl wire protocol v1: framing, handshake key derivation and AES-256-GCM.
// See docs/PROTOCOL.md. Pure Node, no dependencies.

const crypto = require('crypto');

const VERSION = 1;
const MAX_FRAME = 4 * 1024 * 1024;
const TAG_LEN = 16;
const PLAIN = 0x00;
const SEALED = 0x01;

function deriveKey(key, label, nonceC, nonceS) {
  const mac = crypto.createHmac('sha256', key);
  mac.update(Buffer.from(label, 'utf8'));
  mac.update(nonceC);
  mac.update(nonceS);
  return mac.digest();
}

function sessionKeys(key, nonceC, nonceS) {
  return {
    c2s: deriveKey(key, 'wasl/v1/c2s', nonceC, nonceS),
    s2c: deriveKey(key, 'wasl/v1/s2c', nonceC, nonceS),
  };
}

function counterNonce(counter) {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(counter), 4);
  return n;
}

/** One direction of an encrypted channel. */
class Cipher {
  constructor(key) {
    this.key = key;
    this.counter = 0;
  }
  seal(plain) {
    const c = crypto.createCipheriv('aes-256-gcm', this.key, counterNonce(this.counter++));
    const body = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
  }
  open(sealed) {
    if (sealed.length < TAG_LEN) throw new Error('short frame');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, counterNonce(this.counter++));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_LEN)), d.final()]);
  }
}

function encodePayload(msg, bin) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32BE(json.length);
  return bin && bin.length ? Buffer.concat([head, json, bin]) : Buffer.concat([head, json]);
}

function decodePayload(buf) {
  if (buf.length < 4) throw new Error('bad payload');
  const len = buf.readUInt32BE(0);
  if (4 + len > buf.length) throw new Error('bad payload length');
  const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  if (!msg || typeof msg.t !== 'string') throw new Error('bad message');
  const bin = buf.length > 4 + len ? buf.subarray(4 + len) : null;
  return { msg, bin };
}

function frame(type, body) {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(body.length + 1);
  head[4] = type;
  return Buffer.concat([head, body]);
}

/** Splits a TCP stream into frames: yields {type, body}. */
class FrameReader {
  constructor() {
    this.buf = Buffer.alloc(0);
  }
  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len < 1 || len > MAX_FRAME) throw new Error('frame too large');
      if (this.buf.length < 4 + len) break;
      out.push({ type: this.buf[4], body: this.buf.subarray(5, 4 + len) });
      this.buf = this.buf.subarray(4 + len);
    }
    return out;
  }
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function pairingUri({ pcId, pcName, hosts, port, key }) {
  const q = new URLSearchParams({
    v: String(VERSION),
    id: pcId,
    n: pcName,
    h: hosts.join(','),
    p: String(port),
    k: b64url(key),
  });
  return `wasl://pair?${q.toString()}`;
}

module.exports = {
  VERSION, MAX_FRAME, PLAIN, SEALED,
  sessionKeys, Cipher, encodePayload, decodePayload, frame, FrameReader,
  b64url, fromB64url, pairingUri,
};
