'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { EventEmitter } = require('events');
const { resolveIn, BridgeError } = require('../bridge/sandbox');
const { WebSocketConnection } = require('../bridge/ws');
const { MemoryStore } = require('../bridge/redis');
const { Sql } = require('../bridge/sql');
const { twStringify, storedOptions, commentText, stamp, MARKER } = require('../tools/twconfig');

function fakeSocket() {
  const s = new EventEmitter();
  s.writable = true;
  s.written = [];
  s.setNoDelay = () => {};
  s.write = (buf) => { s.written.push(Buffer.from(buf)); return true; };
  // A real TCP socket does not emit 'close' synchronously inside end(); only destroy tears down.
  s.end = (buf) => { if (buf) s.written.push(Buffer.from(buf)); s.writable = false; };
  s.destroy = () => { s.writable = false; s.emit('close'); };
  return s;
}

// A client->server frame: masked, FIN set, payload < 126 bytes.
function clientFrame(op, payload) {
  payload = Buffer.from(payload);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
  return Buffer.concat([Buffer.from([0x80 | op, 0x80 | payload.length]), mask, masked]);
}

test('WebSocket codec: masked text in, unmasked text out', () => {
  const s = fakeSocket();
  const conn = new WebSocketConnection(s);
  const got = [];
  conn.on('message', (t) => got.push(t));
  conn._onData(clientFrame(0x1, Buffer.from('hello', 'utf8')));
  assert.deepEqual(got, ['hello']);
  conn.send('hi');
  const out = s.written.at(-1);
  assert.equal(out[0], 0x81);          // FIN + text
  assert.equal(out[1] & 0x80, 0);      // server frames are not masked
  assert.equal(out.subarray(2).toString('utf8'), 'hi');
});

test('WebSocket heartbeat: ping marks not-alive until a pong arrives', () => {
  const s = fakeSocket();
  const conn = new WebSocketConnection(s);
  assert.equal(conn.isAlive, true);
  conn.ping();
  assert.equal(conn.isAlive, false);
  assert.equal(s.written.at(-1)[0], 0x89); // FIN + ping
  conn._onData(clientFrame(0xa, Buffer.alloc(0))); // client pong
  assert.equal(conn.isAlive, true);
});

test('WebSocket codec rejects an unmasked client frame', () => {
  const s = fakeSocket();
  const conn = new WebSocketConnection(s);
  let closedCode = null;
  conn.on('close', (code) => { closedCode = code; });
  conn._onData(Buffer.from([0x81, 0x02, 0x68, 0x69])); // unmasked "hi"
  assert.equal(closedCode, 1002);
});

test('resolveIn keeps paths inside the root and rejects escapes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x70s-'));
  const roots = { data: path.join(dir, 'data') };
  assert.equal(resolveIn(roots, 'data', 'a/b.txt'), path.join(roots.data, 'a', 'b.txt'));
  for (const bad of ['../x', '/etc/passwd', 'a/../../x', 'a\0b']) {
    assert.throws(() => resolveIn(roots, 'data', bad), (e) => e instanceof BridgeError && (e.code === 'EPATH' || e.code === 'EROOT'));
  }
  assert.throws(() => resolveIn(roots, 'missing', 'x'), (e) => e.code === 'EROOT');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveIn refuses a symlink that points outside the root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x70s-'));
  const roots = { data: path.join(dir, 'data') };
  fs.mkdirSync(roots.data, { recursive: true });
  const outside = path.join(dir, 'secret'); fs.writeFileSync(outside, 'x');
  try { fs.symlinkSync(outside, path.join(roots.data, 'link')); } catch { fs.rmSync(dir, { recursive: true, force: true }); return; }
  assert.throws(() => resolveIn(roots, 'data', 'link'), (e) => e.code === 'EPATH');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('MemoryStore mirrors the Redis command subset', async () => {
  const s = new MemoryStore();
  assert.equal(await s.command(['SET', 'k', '1']), 'OK');
  assert.equal(await s.command(['INCRBYFLOAT', 'k', '2.5']), '3.5');
  await s.command(['RPUSH', 'l', 'a', 'b']);
  assert.equal(await s.command(['LLEN', 'l']), 2);
  assert.deepEqual(await s.command(['LRANGE', 'l', 0, -1]), ['a', 'b']);
  await s.command(['HSET', 'h', 'f', 'v']);
  assert.equal(await s.command(['HGET', 'h', 'f']), 'v');
  assert.deepEqual(await s.command(['HGETALL', 'h']), ['f', 'v']);
  await s.command(['SET', 'x', '1']);
  assert.equal(await s.command(['DEL', 'x']), 1);
  assert.equal(await s.command(['GET', 'x']), null);
});

test('MemoryStore enforces PX expiry', async () => {
  const s = new MemoryStore();
  await s.command(['SET', 'k', 'v', 'PX', 10]);
  assert.equal(await s.command(['GET', 'k']), 'v');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await s.command(['GET', 'k']), null);
});

test('Sql insertMany is transactional and typed', () => {
  const db = new Sql(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  db.insertMany('t', ['v'], [['a'], ['b']]);
  assert.equal(db.query('SELECT count(*) c FROM t')[0].c, 2);
  const r = db.run('INSERT INTO t (v) VALUES (?)', ['c']);
  assert.equal(typeof r.lastInsertRowid, 'number');
  db.close();
});

test('twStringify emits Infinity as a bare literal', () => {
  assert.equal(twStringify({ a: Infinity, b: -Infinity, c: 1 }), '{"a":Infinity,"b":-Infinity,"c":1}');
});

test('storedOptions only records settings that differ from stock TurboWarp', () => {
  const o = storedOptions({ framerate: 0, interpolation: true, highQualityPen: true, turbo: false, maxClones: Infinity, miscLimits: false, fencing: false, stageWidth: 480, stageHeight: 360 });
  assert.deepEqual(o, { framerate: 0, interpolation: true, hq: true, runtimeOptions: { maxClones: Infinity, miscLimits: false, fencing: false } });
  assert.deepEqual(storedOptions({ framerate: 30, maxClones: 300, fencing: true, miscLimits: true, stageWidth: 480, stageHeight: 360 }), {});
});

test('the stored comment ends with the _twconfig_ marker', () => {
  assert.ok(commentText({ framerate: 0, maxClones: Infinity, fencing: false, miscLimits: false, stageWidth: 480, stageHeight: 360 }).endsWith(MARKER));
});

test('stamp writes a readable config comment into an .sb3', async () => {
  const JSZip = require('jszip');
  const zip = new JSZip();
  zip.file('project.json', JSON.stringify({ targets: [{ isStage: true, comments: {} }], meta: {} }));
  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  const out = await stamp(buf, { framerate: 0, maxClones: Infinity, fencing: false, miscLimits: false, interpolation: true, highQualityPen: true, stageWidth: 480, stageHeight: 360 });
  const project = JSON.parse(await (await JSZip.loadAsync(out)).file('project.json').async('string'));
  const comment = Object.values(project.targets[0].comments)[0];
  assert.ok(comment.text.endsWith(MARKER));
  assert.match(comment.text, /"maxClones":Infinity/);
  // stamping again updates the same comment instead of adding a second one
  const out2 = await stamp(out, { framerate: 60, maxClones: 300, fencing: true, miscLimits: true, stageWidth: 480, stageHeight: 360 });
  const project2 = JSON.parse(await (await JSZip.loadAsync(out2)).file('project.json').async('string'));
  assert.equal(Object.keys(project2.targets[0].comments).length, 1);
});
