'use strict';
// A phone written in Node, for tests and for trying the PC app without a phone:
//   node test/fake-phone.js "wasl://pair?..."

const net = require('net');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const P = require('../src/protocol');

class FakePhone extends EventEmitter {
  constructor({ host, port, key, deviceId, name = 'Test Phone', pair = false }) {
    super();
    Object.assign(this, { host, port, key, name, pair });
    this.deviceId = deviceId || crypto.randomBytes(16).toString('hex');
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect(this.port, this.host);
      const reader = new P.FrameReader();
      const nonceC = crypto.randomBytes(16);
      this.sock = sock;
      let state = 'hello';
      sock.on('error', reject);
      sock.on('close', () => this.emit('close'));
      sock.on('connect', () => {
        const hello = { t: 'hello', v: 1, dev: this.deviceId, nonce: nonceC.toString('base64') };
        if (this.pair) hello.pair = true;
        sock.write(P.frame(P.PLAIN, Buffer.from(JSON.stringify(hello))));
      });
      sock.on('data', (d) => {
        for (const f of reader.push(d)) {
          if (state === 'hello') {
            const m = JSON.parse(f.body.toString());
            if (m.t === 'error') return reject(new Error(m.code));
            const keys = P.sessionKeys(this.key, nonceC, Buffer.from(m.nonce, 'base64'));
            this.tx = new P.Cipher(keys.c2s);
            this.rx = new P.Cipher(keys.s2c);
            state = 'auth';
            this.send({ t: 'auth', name: this.name, model: 'Fake', os: 'Node' });
            continue;
          }
          const { msg, bin } = P.decodePayload(this.rx.open(f.body));
          if (state === 'auth' && msg.t === 'welcome') {
            state = 'ready';
            resolve(msg);
            continue;
          }
          if (msg.t === 'ping') this.send({ t: 'pong' });
          this.emit('message', msg, bin);
        }
      });
    });
  }

  send(msg, bin) {
    this.sock.write(P.frame(P.SEALED, this.tx.seal(P.encodePayload(msg, bin))));
  }

  close() {
    this.sock.destroy();
  }
}

if (require.main === module) {
  const u = new URL(process.argv[2]);
  const phone = new FakePhone({
    host: u.searchParams.get('h').split(',')[0],
    port: Number(u.searchParams.get('p')),
    key: P.fromB64url(u.searchParams.get('k')),
  });
  phone.on('message', (m) => console.log('<-', m));
  phone.connect().then((w) => {
    console.log('connected to', w.name);
    phone.send({ t: 'battery', level: 87, charging: true });
    phone.send({ t: 'notif.posted', key: 'k1', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Ali', text: 'مرحبا! شلونك؟', time: Date.now(), actions: [{ i: 0, title: 'Reply', reply: true }, { i: 1, title: 'Mark as read' }] });
    phone.send({ t: 'notif.posted', key: 'k2', pkg: 'com.google.android.gm', app: 'Gmail', title: 'Your code', text: 'Your verification code is 482913', time: Date.now() - 60000, actions: [] });
  }, (e) => console.error('failed:', e.message));
}

module.exports = { FakePhone };
