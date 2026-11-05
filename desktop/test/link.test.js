'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { LinkServer } = require('../src/server');
const { Transfers, safeName } = require('../src/files');
const { FakePhone } = require('./fake-phone');
const P = require('../src/protocol');

function once(emitter, ev) {
  return new Promise((r) => emitter.once(ev, (...a) => r(a)));
}

async function setup() {
  const devices = new Map();
  const server = new LinkServer({
    pcId: 'pc1', pcName: 'Desk', port: 0, discoveryPort: null,
    keyFor: (id) => devices.get(id) || null,
  });
  server.on('paired', (d) => devices.set(d.id, d.key));
  const port = await server.start();
  return { server, port, devices };
}

test('pairing, then reconnecting with the stored key', async () => {
  const { server, port, devices } = await setup();
  const key = server.beginPairing();
  const phone = new FakePhone({ host: '127.0.0.1', port, key });
  const paired = once(server, 'paired');
  const welcome = await phone.connect();
  assert.equal(welcome.name, 'Desk');
  const [dev] = await paired;
  assert.equal(dev.name, 'Test Phone');
  assert.ok(devices.has(phone.deviceId));
  assert.equal(server.pendingKey(), null, 'pairing window closes once used');

  const got = once(server, 'message');
  phone.send({ t: 'clip', text: 'سلام' });
  const [msg] = await got;
  assert.deepEqual(msg, { t: 'clip', text: 'سلام' });

  const back = once(phone, 'message');
  await server.send({ t: 'ring', on: true });
  assert.deepEqual((await back)[0], { t: 'ring', on: true });
  phone.close();

  const again = new FakePhone({ host: '127.0.0.1', port, key, deviceId: phone.deviceId });
  await again.connect();
  again.close();
  await server.stop();
});

test('an unpaired phone and a wrong key are refused', async () => {
  const { server, port } = await setup();
  const stranger = new FakePhone({ host: '127.0.0.1', port, key: crypto.randomBytes(32) });
  await assert.rejects(stranger.connect(), /unpaired/);

  server.beginPairing();
  const guesser = new FakePhone({ host: '127.0.0.1', port, key: crypto.randomBytes(32) });
  const closed = once(guesser, 'close');
  guesser.connect().catch(() => {});
  await closed;
  assert.equal(server.connected, false);
  await server.stop();
});

test('a replayed frame closes the session', async () => {
  const { server, port } = await setup();
  const key = server.beginPairing();
  const phone = new FakePhone({ host: '127.0.0.1', port, key });
  await phone.connect();
  const frame = P.frame(P.SEALED, phone.tx.seal(P.encodePayload({ t: 'clip', text: 'x' })));
  phone.sock.write(frame);
  await once(server, 'message');
  const closed = once(phone, 'close');
  phone.sock.write(frame);
  await closed;
  await server.stop();
});

test('files go both ways and arrive intact', async () => {
  const { server, port } = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasl-'));
  const tr = new Transfers(() => path.join(dir, 'in'), (m, b) => server.send(m, b));
  server.on('message', (m, b) => tr.handle(m, b));
  const key = server.beginPairing();
  const phone = new FakePhone({ host: '127.0.0.1', port, key });
  await phone.connect();

  // phone -> PC, 700 KB in three chunks
  const data = crypto.randomBytes(700_000);
  const received = once(tr, 'received');
  phone.send({ t: 'file.offer', id: 'f1', name: '../evil:name.bin', size: data.length });
  for (let off = 0; off < data.length; off += 256 * 1024) {
    phone.send({ t: 'file.chunk', id: 'f1' }, data.subarray(off, off + 256 * 1024));
  }
  phone.send({ t: 'file.end', id: 'f1', sha256: crypto.createHash('sha256').update(data).digest('hex') });
  const [file] = await received;
  assert.equal(path.basename(file), 'evil_name.bin');
  assert.ok(fs.readFileSync(file).equals(data));

  // PC -> phone
  const src = path.join(dir, 'out.bin');
  const out = crypto.randomBytes(600_000);
  fs.writeFileSync(src, out);
  const parts = [];
  const done = new Promise((resolve) => {
    phone.on('message', (m, b) => {
      if (m.t === 'file.chunk') parts.push(b);
      if (m.t === 'file.end') resolve(m);
    });
  });
  await tr.sendFile(src);
  const end = await done;
  const all = Buffer.concat(parts);
  assert.ok(all.equals(out));
  assert.equal(end.sha256, crypto.createHash('sha256').update(out).digest('hex'));
  phone.close();
  await server.stop();
});

test('safeName', () => {
  assert.equal(safeName('a/b\\c.txt'), 'c.txt');
  assert.equal(safeName('CON.txt'), '_CON.txt');
  assert.equal(safeName('x?.  '), 'x_');
  assert.equal(safeName('..'), 'file');
});

test('pairing uri round trip', () => {
  const key = crypto.randomBytes(32);
  const uri = P.pairingUri({ pcId: 'abc', pcName: 'مهند PC', hosts: ['192.168.1.4', '10.0.0.2'], port: 47800, key });
  const u = new URL(uri);
  assert.equal(u.protocol, 'wasl:');
  assert.equal(u.searchParams.get('n'), 'مهند PC');
  assert.ok(P.fromB64url(u.searchParams.get('k')).equals(key));
});
