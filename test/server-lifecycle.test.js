'use strict';

// Process lifecycle (graceful shutdown persists cookie jars, file permissions) and the client
// runtime bundle served at /__proxy/client.js.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');
const proxyMod = require('../src/proxy');
const { createServer } = require('../server');

const ROOT = path.join(__dirname, '..');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function get(base, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(base + p, { headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

function startChild(env) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ALLOW_PRIVATE: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on http:\/\/[^:]+:(\d+)/.exec(out);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)));
    setTimeout(() => reject(new Error('did not start: ' + out)), 8000).unref();
  });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited };
}

describe('graceful shutdown', () => {
  let site, siteUrl, dir;

  before(async () => {
    site = http.createServer((req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': ['keep=1; Path=/; Max-Age=3600', 'sess=1; Path=/'], 'content-type': 'text/plain' });
        return res.end('ok');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-life-'));
  });

  after(() => {
    site.close();
    site.closeAllConnections?.();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    it(`persists cookie jars on ${signal}, readable only by the owner`, async () => {
      const file = path.join(dir, signal, 'sessions.json');
      const env = { PERSIST_SESSIONS: '1', DATA_FILE: file };
      const first = startChild(env);
      const base = await first.ready;
      const r = await get(base, `/p/${siteUrl}/set`);
      const psid = r.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
      first.child.kill(signal);
      const { code } = await first.exited;
      assert.strictEqual(code, 0);
      assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
      assert.strictEqual(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const id = psid.split('=')[1];
      assert.deepStrictEqual(saved[id].cookies.map((c) => c.name).sort(), ['keep', 'sess']);
      assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), ['sessions.json'], 'no temp files left behind');

      // A restarted proxy picks the session up again, session cookies included.
      const second = startChild(env);
      const base2 = await second.ready;
      const echo = JSON.parse((await get(base2, `/p/${siteUrl}/echo`, { cookie: psid })).body);
      assert.strictEqual(echo.cookie, 'keep=1; sess=1');
      second.child.kill('SIGTERM');
      await second.exited;
    });
  }

  it('exits promptly even with a long-lived stream open', async () => {
    const slow = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const t = setInterval(() => res.write('x'), 50);
      res.on('close', () => clearInterval(t));
    });
    const slowUrl = `http://127.0.0.1:${await listen(slow)}`;
    const p = startChild({ PERSIST_SESSIONS: '0', SHUTDOWN_GRACE_MS: '300' });
    const base = await p.ready;
    await new Promise((resolve) => {
      const req = http.get(`${base}/p/${slowUrl}/`, (res) => res.once('data', resolve));
      req.on('error', () => {});
    });
    const t0 = Date.now();
    p.child.kill('SIGTERM');
    const { code } = await p.exited;
    assert.strictEqual(code, 0);
    assert.ok(Date.now() - t0 < 2000, 'the grace period bounds the wait');
    slow.close();
    slow.closeAllConnections?.();
  });
});

describe('client runtime bundle', () => {
  let proxy, proxyUrl, site, siteUrl;
  const rewriterSrc = fs.readFileSync(path.join(ROOT, 'src', 'rewrite-js.js'), 'utf8');
  const runtimeSrc = fs.readFileSync(path.join(ROOT, 'public', 'client.js'), 'utf8');
  const PREFIX = ';(function (module, exports, define, require) {\n';

  before(async () => {
    proxy = createServer();
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    site = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head><title>x</title></head><body></body></html>');
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
  });

  after(() => {
    for (const s of [proxy, site]) { s.close(); s.closeAllConnections?.(); }
  });

  it('serves the JS rewriter wrapped ahead of the runtime', async () => {
    const r = await get(proxyUrl, '/__proxy/client.js');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /^application\/javascript/);
    assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
    assert.ok(r.body.startsWith(PREFIX + rewriterSrc + '\n}());\n'));
    assert.ok(r.body.includes(runtimeSrc));
    assert.ok(r.body.indexOf(rewriterSrc) < r.body.indexOf(runtimeSrc));
    const version = crypto.createHash('sha1').update(r.buf).digest('hex').slice(0, 10);
    assert.strictEqual(proxyMod.clientBundle().version, version, 'the version is a hash of the combined body');
    assert.strictEqual(r.headers.etag, `"${version}"`);
    assert.strictEqual(r.headers['cache-control'], 'no-cache');
  });

  it('is cached forever under its version and revalidates by ETag', async () => {
    const { version, body } = proxyMod.clientBundle();
    const v = await get(proxyUrl, `/__proxy/client.js?v=${version}`);
    assert.strictEqual(v.headers['cache-control'], 'public, max-age=31536000, immutable');
    const stale = await get(proxyUrl, '/__proxy/client.js?v=0000000000');
    assert.strictEqual(stale.headers['cache-control'], 'no-cache');
    const nm = await get(proxyUrl, '/__proxy/client.js', { 'if-none-match': `"${version}"` });
    assert.strictEqual(nm.status, 304);
    assert.strictEqual(nm.buf.length, 0);
    const gz = await get(proxyUrl, '/__proxy/client.js', { 'accept-encoding': 'gzip, br' });
    assert.strictEqual(gz.headers['content-encoding'], 'gzip');
    assert.ok(zlib.gunzipSync(gz.buf).equals(body));
    assert.match(gz.headers.vary, /Accept-Encoding/);
  });

  it('is referenced from proxied documents by its current version', async () => {
    const r = await get(proxyUrl, `/p/${siteUrl}/`);
    assert.ok(r.body.includes(`<script src="/__proxy/client.js?v=${proxyMod.clientBundle().version}" data-proxy-runtime></script>`));
  });

  it('defines no global other than __proxyRewriteJs', () => {
    const { body } = proxyMod.clientBundle();
    const rewriterPart = body.toString('utf8', 0, Buffer.byteLength(PREFIX + rewriterSrc + '\n}());\n'));
    const ctx = vm.createContext({});
    const before = new Set(Object.getOwnPropertyNames(vm.runInContext('globalThis', ctx)));
    vm.runInContext(rewriterPart, ctx);
    const added = Object.getOwnPropertyNames(vm.runInContext('globalThis', ctx)).filter((k) => !before.has(k));
    assert.deepStrictEqual(added, ['__proxyRewriteJs']);
    assert.strictEqual(vm.runInContext("__proxyRewriteJs.rewriteJs('location.href = x')", ctx), '__pLocation.href = x');
  });

  it('leaves a page\'s own module, exports and AMD loader alone', () => {
    const { body } = proxyMod.clientBundle();
    const rewriterPart = body.toString('utf8', 0, Buffer.byteLength(PREFIX + rewriterSrc + '\n}());\n'));
    const ctx = vm.createContext({});
    vm.runInContext('var module = { exports: {} }; var exports = module.exports; var defined = 0; function define() { defined++; } define.amd = {};', ctx);
    vm.runInContext(rewriterPart, ctx);
    assert.strictEqual(vm.runInContext('Object.keys(module.exports).length + defined', ctx), 0);
    assert.strictEqual(vm.runInContext('typeof __proxyRewriteJs.rewriteScript', ctx), 'function');
  });

  it('reloads the runtime from disk in development', async () => {
    const clientPath = path.join(ROOT, 'public', 'client.js');
    const realStat = fs.statSync, realRead = fs.readFileSync;
    const original = proxyMod.clientBundle().version;
    process.env.NODE_ENV = 'development';
    fs.statSync = function (p, ...rest) {
      const st = realStat.call(fs, p, ...rest);
      if (p === clientPath) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { mtimeMs: st.mtimeMs + 12345 });
      return st;
    };
    fs.readFileSync = function (p, ...rest) {
      const out = realRead.call(fs, p, ...rest);
      return p === clientPath ? out + '\n/* edited */' : out;
    };
    try {
      const changed = proxyMod.clientBundle();
      assert.notStrictEqual(changed.version, original);
      assert.ok(changed.body.toString().endsWith('/* edited */\n'));
      const r = await get(proxyUrl, '/__proxy/client.js');
      assert.ok(r.body.endsWith('/* edited */\n'));
      const page = await get(proxyUrl, `/p/${siteUrl}/`);
      assert.ok(page.body.includes(`client.js?v=${changed.version}`));
    } finally {
      fs.statSync = realStat;
      fs.readFileSync = realRead;
      proxyMod.clientBundle(); // pick the real files up again
      delete process.env.NODE_ENV;
    }
    assert.strictEqual(proxyMod.clientBundle().version, original);
  });
});
