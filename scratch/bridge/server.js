#!/usr/bin/env node
'use strict';

// x70 bridge: a local daemon that gives an unsandboxed TurboWarp extension the things a browser
// tab cannot have: files, processes, system metrics, a Redis cache, SQLite and raw assets.
//
//   WS   /ws              JSON-RPC: {id, method, params} -> {id, result} | {id, error}
//                          first message must be {"type":"hello","token":"..."}
//   POST /rpc             the same, one call per request (Node-RED, scripts, curl)
//   POST /event           {name, data}: fire "when I receive bridge event" hats in every project
//   GET  /assets/<path>   raw files from the assets root (?t=<token>), for live injection
//   GET  /extension.js    the extension source (no token inside; projects pair with a block)
//   GET  /health
//
// Listens on 127.0.0.1 only by default. Every call needs the token from data/bridge.token.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('./config');
const ws = require('./ws');
const redis = require('./redis');
const { Sql } = require('./sql');
const rpc = require('./rpc');
const os = require('os');
const { spawn } = require('child_process');
const { BridgeError, resolveIn } = require('./sandbox');

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version || VERSION; } catch { /* no package.json */ }
const STARTED_AT = Date.now();

// Lightweight CPU sampler: percent busy since the previous call (good enough for a ~3s poll).
function cpuSnapshot() {
  return os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
}
let lastCpu = cpuSnapshot();
function cpuPercent() {
  const now = cpuSnapshot();
  const idle = now.idle - lastCpu.idle;
  const total = now.total - lastCpu.total;
  lastCpu = now;
  return total > 0 ? Math.round(1000 * (1 - idle / total)) / 10 : 0;
}
const memPercent = () => Math.round(1000 * (1 - os.freemem() / os.totalmem())) / 10;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.opus': 'audio/ogg', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf', '.woff2': 'font/woff2',
};

const EXTENSION_FILE = path.join(__dirname, '..', 'extension', 'x70bridge.js');

function tokenOk(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function errorPayload(e) {
  if (e instanceof BridgeError) return { code: e.code, message: e.message };
  if (e && e.code && typeof e.code === 'string') return { code: e.code, message: e.message };
  return { code: 'EFAIL', message: (e && e.message) || String(e) };
}

async function start(config = load(), { log = console.log } = {}) {
  const b = config.bridge;
  const kv = await redis.open(config.redis);
  if (kv.kind === 'memory') {
    log(`[bridge] cache: in-memory fallback${kv.error ? ` (Redis unavailable: ${kv.error.message})` : ''}`);
  } else {
    log(`[bridge] cache: Redis at ${config.redis.url}`);
  }
  const sql = new Sql(config.sqlite.path);
  log(`[bridge] sqlite: ${config.sqlite.path}`);
  for (const dir of Object.values(b.fsRoots)) fs.mkdirSync(dir, { recursive: true });

  const clients = new Set();
  const broadcast = (name, data, from) => {
    const msg = JSON.stringify({ type: 'event', name, data: data ?? '' });
    for (const c of clients) if (c !== from && c.authed) c.send(msg);
  };
  const methods = rpc.create({ config, kv, sql, broadcast });

  async function call(method, params, client) {
    if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new BridgeError('ENOMETHOD', `Unknown method ${method}`);
    return methods[method](params && typeof params === 'object' ? params : {}, client);
  }

  let boundPort = b.port;
  // A dotted-suffix match (host === suf OR host endsWith "." + suf) so "evilapp.github.dev" is
  // NOT accepted for the "app.github.dev" suffix — only real sub-hosts of it are.
  const suffixOk = (host) => b.allowedHostSuffixes.some((suf) => host === suf || host.endsWith(`.${suf}`));
  const isLoopback = (host) => host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]' || host === b.host;
  const hostOk = (req) => {
    // Rejecting unknown Host values defeats DNS rebinding (evil.example resolving to 127.0.0.1);
    // loopback is always allowed, and a forwarded port (Codespaces/tunnel) is allowed by suffix.
    const h = String(req.headers.host || '').toLowerCase();
    if (!h) return false;
    const p = String(boundPort);
    if ([`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`, `${b.host}:${p}`].includes(h)) return true;
    const hostname = h.replace(/:\d+$/, '');
    return isLoopback(hostname) || suffixOk(hostname);
  };
  const originOk = (origin) => {
    if (!origin) return true;
    if (b.allowedOrigins.includes('*') || b.allowedOrigins.includes(origin)) return true;
    let hostname;
    try { hostname = new URL(origin).hostname.toLowerCase(); } catch { return false; }
    return isLoopback(hostname) || suffixOk(hostname);
  };
  const reqToken = (req, url) => {
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    return url.searchParams.get('t') || req.headers['x-bridge-token'];
  };

  const send = (res, status, body, headers = {}) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    res.writeHead(status, {
      'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json',
      ...headers,
    });
    res.end(buf);
  };

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const parts = []; let n = 0; let over = false;
    const tooBig = () => reject(new BridgeError('ETOOBIG', 'Request body too large'));
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) {
        over = true;
        // Stop buffering, but drain the rest so the handler can still send a clean 413 response.
        // Only a pathologically huge body (an attack, not a big save) is force-closed.
        if (n > limit * 4 + 65536) { tooBig(); req.destroy(); }
      } else {
        parts.push(d);
      }
    });
    req.on('end', () => (over ? tooBig() : resolve(Buffer.concat(parts).toString('utf8'))));
    req.on('aborted', tooBig);
    req.on('error', reject);
  });

  // Binary body (for .sb3 uploads to /build).
  const readRaw = (req, limit) => new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) { reject(new BridgeError('ETOOBIG', 'Upload too large')); req.destroy(); } else parts.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });

  const SAFE_SB3 = /^[A-Za-z0-9._ -]+\.(sb3|sb2|sb)$/;
  const SAFE_HTML = /^[A-Za-z0-9._-]+\.html$/;

  // Package an uploaded project by spawning the build tool in a child process (isolated from the
  // bridge event loop). The built game is paired to this same origin so it works from the port.
  function runBuild(absFile, publicBase) {
    return new Promise((resolve) => {
      const args = ['--disable-warning=ExperimentalWarning', path.join(config.root, 'tools', 'build.js'), absFile, '--target=html'];
      const env = { ...process.env };
      if (publicBase) env.X70_BRIDGE_PUBLIC_URL = publicBase;
      const child = spawn(process.execPath, args, { cwd: config.root, env });
      const out = [];
      const grab = (d) => { if (out.join('').length < 20000) out.push(d.toString()); };
      child.stdout.on('data', grab);
      child.stderr.on('data', grab);
      const timer = setTimeout(() => child.kill('SIGKILL'), 240000);
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, log: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, log: out.join('') }); });
    });
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const listBuilds = () => {
    try { return fs.readdirSync(config.build.outDir).filter((f) => f.endsWith('.html')).sort(); }
    catch { return []; }
  };
  // A token-free status page at GET / so opening the forwarded-port URL shows "it works", the
  // version, the built games, and the connection steps — never the token. Stats refresh live from
  // /health so it is visibly a running Node page. The extension URL is built from the request host.
  const STUDIO_FILE = path.join(__dirname, 'studio.html');
  const CONFIG_FILE = process.env.X70_CONFIG || path.join(config.root, 'pipeline.config.json');
  // The full Studio web app (bridge/studio.html), with the mount prefix and version injected so
  // its relative URLs resolve whether it is hit directly (7070) or under the /x70 mount.
  const studioPage = (req) => {
    const prefix = String(req.headers['x-forwarded-prefix'] || '').replace(/\/$/, '');
    return fs.readFileSync(STUDIO_FILE, 'utf8').split('__X70_PREFIX__').join(prefix).split('__X70_VERSION__').join(VERSION);
  };

  const server = http.createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://bridge'); } catch { return send(res, 400, 'Bad URL'); }
    if (!hostOk(req)) return send(res, 421, 'Wrong Host header');
    const origin = req.headers.origin;
    const cors = origin && originOk(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
    if (req.method === 'OPTIONS') {
      return send(res, originOk(origin) ? 204 : 403, '', {
        ...cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Bridge-Token',
        'Access-Control-Max-Age': '600',
      });
    }
    if (origin && !originOk(origin)) return send(res, 403, `Origin ${origin} is not in bridge.allowedOrigins`);

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/status')) {
        return send(res, 200, studioPage(req), { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        let runtime = config.runtime;
        try { runtime = { ...runtime, ...(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).runtime || {}) }; } catch { /* use loaded */ }
        return send(res, 200, { runtime }, cors);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/download/')) {
        const name = decodeURIComponent(url.pathname.slice('/download/'.length));
        if (!/^[A-Za-z0-9._-]+\.html$/.test(name) || !listBuilds().includes(name)) return send(res, 404, 'No such game', cors);
        const data = await fs.promises.readFile(path.join(config.build.outDir, name)).catch(() => null);
        if (!data) return send(res, 404, 'No such game', cors);
        return send(res, 200, data, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true, version: VERSION, kv: kv.kind, clients: clients.size,
          platform: process.platform, node: process.version, uptime: (Date.now() - STARTED_AT) / 1000,
          cpu: cpuPercent(), mem: memPercent(), totalMem: os.totalmem(), load: os.loadavg()[0],
          games: listBuilds().length,
        }, cors);
      }
      if (req.method === 'GET' && url.pathname === '/token') {
        // The pairing token, for the dashboard's "reveal & copy" action. It grants bridge access,
        // so the dashboard warns and only fetches it on an explicit click; keep the port private.
        return send(res, 200, { token: b.token }, { ...cors, 'Cache-Control': 'no-store' });
      }
      if (req.method === 'GET' && url.pathname === '/extension.js') {
        return send(res, 200, fs.readFileSync(EXTENSION_FILE), { ...cors, 'Content-Type': 'text/javascript; charset=utf-8' });
      }
      if (req.method === 'GET' && url.pathname === '/games') {
        return send(res, 200, { builds: listBuilds() }, cors);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/play/')) {
        // Serve a packaged game so it can be played straight from the port. A game that uses the
        // x70 Bridge blocks carries the baked token, so keep a forwarded port Private to share.
        const name = decodeURIComponent(url.pathname.slice('/play/'.length));
        if (!/^[A-Za-z0-9._-]+\.html$/.test(name) || !listBuilds().includes(name)) {
          return send(res, 404, 'No such game', cors);
        }
        const file = path.join(config.build.outDir, name);
        const data = await fs.promises.readFile(file).catch(() => null);
        if (!data) return send(res, 404, 'No such game', cors);
        return send(res, 200, data, { ...cors, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      if (!tokenOk(reqToken(req, url), b.token)) return send(res, 401, 'Missing or wrong bridge token', cors);

      if (req.method === 'POST' && url.pathname === '/build') {
        const name = String(url.searchParams.get('name') || '').trim();
        if (!SAFE_SB3.test(name)) return send(res, 400, { error: { code: 'ENAME', message: 'name must be a .sb3 / .sb2 file' } }, cors);
        const data = await readRaw(req, b.maxFileBytes);
        if (!data.length) return send(res, 400, { error: { code: 'EEMPTY', message: 'empty upload' } }, cors);
        await fs.promises.mkdir(config.build.projectsDir, { recursive: true });
        const absFile = path.join(config.build.projectsDir, name);
        await fs.promises.writeFile(absFile, data);
        const host = String(req.headers.host || '');
        const proto = req.headers['x-forwarded-proto'] || (/^(127\.0\.0\.1|localhost|\[::1\])/.test(host) ? 'http' : 'https');
        const prefix = String(req.headers['x-forwarded-prefix'] || '').replace(/\/$/, '');
        const publicBase = host ? `${proto}://${host}${prefix}` : '';
        const r = await runBuild(absFile, publicBase);
        const game = name.replace(/\.(sb3|sb2|sb)$/i, '.html');
        if (r.code === 0 && listBuilds().includes(game)) return send(res, 200, { ok: true, game, log: r.log }, cors);
        return send(res, 200, { error: { code: 'EBUILD', message: 'Build failed (is @turbowarp/packager installed? run `cd scratch && npm install`)' }, log: r.log }, cors);
      }
      if (req.method === 'POST' && url.pathname === '/config') {
        const body = JSON.parse((await readBody(req, 65536)) || '{}');
        const rt = body.runtime || {};
        const allowed = ['framerate', 'interpolation', 'turbo', 'highQualityPen', 'warpTimer', 'maxClones', 'fencing', 'miscLimits', 'stageWidth', 'stageHeight', 'maxTextureDimension'];
        let file = {};
        try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* new file */ }
        file.runtime = file.runtime || {};
        for (const k of allowed) if (k in rt) file.runtime[k] = rt[k];
        await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(file, null, 2) + '\n');
        return send(res, 200, { ok: true, runtime: file.runtime }, cors);
      }
      if (req.method === 'POST' && url.pathname === '/games/delete') {
        const body = JSON.parse((await readBody(req, 4096)) || '{}');
        const name = String(body.name || '');
        if (!SAFE_HTML.test(name) || !listBuilds().includes(name)) return send(res, 404, { error: { code: 'ENOENT', message: 'No such game' } }, cors);
        await fs.promises.rm(path.join(config.build.outDir, name), { force: true });
        return send(res, 200, { ok: true }, cors);
      }

      if (req.method === 'GET' && url.pathname.startsWith('/assets/')) {
        const rel = decodeURIComponent(url.pathname.slice('/assets/'.length));
        const file = resolveIn(b.fsRoots, 'assets', rel);
        const st = await fs.promises.stat(file).catch(() => null);
        if (!st || !st.isFile()) return send(res, 404, 'No such asset', cors);
        res.writeHead(200, {
          ...cors, 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
        });
        return fs.createReadStream(file).pipe(res);
      }
      if (req.method === 'POST' && (url.pathname === '/rpc' || url.pathname === '/event')) {
        const body = JSON.parse((await readBody(req, b.maxFileBytes * 1.4 + 1024)) || '{}');
        if (url.pathname === '/event') {
          broadcast(String(body.name || ''), body.data, null);
          return send(res, 200, { ok: true, delivered: [...clients].filter((c) => c.authed).length }, cors);
        }
        try {
          return send(res, 200, { result: await call(String(body.method), body.params, null) }, cors);
        } catch (e) {
          return send(res, 200, { error: errorPayload(e) }, cors);
        }
      }
      return send(res, 404, 'Not found', cors);
    } catch (e) {
      const status = e instanceof SyntaxError ? 400 : (e && e.code === 'ETOOBIG') ? 413 : 500;
      return send(res, status, { error: errorPayload(e) }, cors);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let url;
    try { url = new URL(req.url, 'http://bridge'); } catch { return socket.destroy(); }
    if (url.pathname !== '/ws' || !hostOk(req) || !originOk(req.headers.origin)) {
      return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    const c = ws.accept(req, socket, head, { maxMessageBytes: Math.ceil(b.maxFileBytes * 1.4) + 4096 });
    if (!c) return;
    c.authed = false;
    clients.add(c);
    const helloTimer = setTimeout(() => { if (!c.authed) c.close(4001, 'hello timeout'); }, 5000);
    c.on('close', () => { clearTimeout(helloTimer); clients.delete(c); });
    c.on('message', async (text, binary) => {
      if (binary) return c.close(1003, 'text only');
      let msg;
      try { msg = JSON.parse(text); } catch { return c.close(1007, 'bad JSON'); }
      if (!c.authed) {
        if (msg && msg.type === 'hello' && tokenOk(msg.token, b.token)) {
          c.authed = true;
          clearTimeout(helloTimer);
          c.send(JSON.stringify({ type: 'welcome', kv: kv.kind, platform: process.platform, assets: !!b.fsRoots.assets }));
        } else {
          c.close(4003, 'bad token');
        }
        return;
      }
      const id = msg && msg.id;
      try {
        const result = await call(String(msg.method), msg.params, c);
        c.send(JSON.stringify({ id, result: result === undefined ? null : result }));
      } catch (e) {
        c.send(JSON.stringify({ id, error: errorPayload(e) }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(b.port, b.host, resolve);
  });
  const port = boundPort = server.address().port;
  log(`[bridge] listening on http://${b.host}:${port}  (token file: ${b.tokenFile})`);

  // Heartbeat: ping each client periodically so a forwarded port (Codespaces/tunnel) does not drop
  // the connection as idle during a long session, and so dead peers are reaped instead of leaking.
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.authed) continue;
      if (c.isAlive === false) { c.close(4000, 'ping timeout'); continue; }
      c.ping();
    }
  }, 30000);
  if (heartbeat.unref) heartbeat.unref();

  const close = () => new Promise((resolve) => {
    clearInterval(heartbeat);
    for (const c of clients) c.close(1001, 'shutting down');
    server.close(() => { try { sql.close(); } catch { /* already closed */ } kv.store.close(); resolve(); });
    server.closeAllConnections();
  });
  return { server, port, close, kv, sql, config };
}

if (require.main === module) {
  start().then(({ close }) => {
    const stop = () => close().then(() => process.exit(0));
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }).catch((e) => {
    console.error('[bridge] failed to start:', e.message);
    process.exit(1);
  });
}

module.exports = { start };
