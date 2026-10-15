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
const { BridgeError, resolveIn } = require('./sandbox');

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
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, kv: kv.kind, clients: clients.size }, cors);
      }
      if (req.method === 'GET' && url.pathname === '/extension.js') {
        return send(res, 200, fs.readFileSync(EXTENSION_FILE), { ...cors, 'Content-Type': 'text/javascript; charset=utf-8' });
      }
      if (!tokenOk(reqToken(req, url), b.token)) return send(res, 401, 'Missing or wrong bridge token', cors);

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
