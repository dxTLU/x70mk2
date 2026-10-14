'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { start } = require('../bridge/server');
const { load } = require('../bridge/config');

function tempConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x70-'));
  const cfg = {
    runtime: { framerate: 0, interpolation: true, maxClones: 'Infinity', fencing: false, miscLimits: false },
    bridge: {
      host: '127.0.0.1', port: 0, allowedOrigins: ['null'],
      fsRoots: { data: 'data/files', assets: 'assets' }, maxFileBytes: 1048576,
      exec: { timeoutMs: 5000, maxOutputBytes: 65536, commands: { 'node-version': { cmd: process.execPath, args: ['--version'] } } },
    },
    redis: { url: '', keyPrefix: 't:', required: false },
    sqlite: { path: 'data/test.sqlite' },
    build: { projectsDir: 'projects', outDir: 'dist', targets: ['html'] },
  };
  const file = path.join(dir, 'pipeline.config.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { dir, file };
}

async function withBridge(fn) {
  const { dir, file } = tempConfig();
  const config = load(file);
  const bridge = await start(config, { log: () => {} });
  const call = (method, params, { token = config.bridge.token, host = `127.0.0.1:${bridge.port}` } = {}) =>
    new Promise((resolve, reject) => {
      const body = JSON.stringify({ method, params });
      const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Host: host, Connection: 'close' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const req = http.request({ host: '127.0.0.1', port: bridge.port, path: '/rpc', method: 'POST', headers, agent: false },
        (r) => {
          let d = '';
          r.on('data', (c) => (d += c));
          r.on('end', () => {
            let parsed = null;
            if (d) { try { parsed = JSON.parse(d); } catch { parsed = { text: d }; } }
            resolve({ status: r.statusCode, body: parsed });
          });
        });
      req.on('error', reject); req.end(body);
    });
  try {
    await fn({ bridge, call, config });
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('files round-trip inside the sandbox', () => withBridge(async ({ call }) => {
  assert.equal((await call('fs.write', { root: 'data', path: 'a/b.txt', data: 'hi' })).body.result, 2);
  assert.equal((await call('fs.read', { root: 'data', path: 'a/b.txt' })).body.result, 'hi');
  assert.deepEqual((await call('fs.list', { root: 'data', path: 'a' })).body.result, ['b.txt']);
  assert.equal((await call('fs.stat', { root: 'data', path: 'a/b.txt' })).body.result.exists, true);
}));

test('path traversal is refused', () => withBridge(async ({ call }) => {
  for (const p of ['../../etc/passwd', '/etc/passwd', 'a/../../b']) {
    const r = await call('fs.read', { root: 'data', path: p });
    assert.ok(r.body.error, `expected error for ${p}`);
    assert.equal(r.body.error.code, 'EPATH');
  }
}));

test('unknown root and unknown method are refused', () => withBridge(async ({ call }) => {
  assert.equal((await call('fs.read', { root: 'nope', path: 'x' })).body.error.code, 'EROOT');
  assert.equal((await call('totally.fake', {})).body.error.code, 'ENOMETHOD');
}));

test('only allowlisted commands run', () => withBridge(async ({ call }) => {
  const ok = await call('exec.run', { name: 'node-version' });
  assert.equal(ok.body.result.code, 0);
  assert.match(ok.body.result.stdout, /^v\d+/);
  assert.equal((await call('exec.run', { name: 'rm', args: ['-rf', '/'] })).body.error.code, 'EDENIED');
}));

test('missing or wrong token is rejected', () => withBridge(async ({ call }) => {
  assert.equal((await call('sys.ping', {}, { token: null })).status, 401);
  assert.equal((await call('sys.ping', {}, { token: 'wrong' })).status, 401);
}));

test('a foreign Host header is rejected (DNS-rebinding guard)', () => withBridge(async ({ call }) => {
  assert.equal((await call('sys.ping', {}, { host: 'evil.example.com' })).status, 421);
}));

test('cache and list operations work on the in-memory fallback', () => withBridge(async ({ call }) => {
  await call('kv.set', { key: 'score', value: '10' });
  assert.equal((await call('kv.incr', { key: 'score', by: 5 })).body.result, 15);
  assert.equal((await call('kv.get', { key: 'score' })).body.result, '15');
  await call('list.replace', { key: 'world', items: ['a', 'b', 'c'] });
  assert.equal((await call('list.len', { key: 'world' })).body.result, 3);
  assert.deepEqual((await call('list.range', { key: 'world' })).body.result, ['a', 'b', 'c']);
}));

test('SQLite exec / insertMany / query', () => withBridge(async ({ call }) => {
  await call('sql.exec', { sql: 'CREATE TABLE scores (name TEXT, score REAL)' });
  await call('sql.insertMany', { table: 'scores', columns: ['name', 'score'], rows: [['a', 3], ['b', 9], ['c', 5]] });
  const rows = (await call('sql.query', { sql: 'SELECT name FROM scores WHERE score > ? ORDER BY score DESC', params: [4] })).body.result;
  assert.deepEqual(rows, [{ name: 'b' }, { name: 'c' }]);
}));

test('insertMany rejects a bad identifier', () => withBridge(async ({ call }) => {
  const r = await call('sql.insertMany', { table: 'bad name; DROP TABLE x', columns: ['a'], rows: [[1]] });
  assert.equal(r.body.error.code, 'ESQL');
}));

test('system metrics report numbers', () => withBridge(async ({ call }) => {
  const m = (await call('sys.metrics')).body.result;
  assert.equal(typeof m.cpuPercent, 'number');
  assert.ok(m.totalMem > 0);
}));
