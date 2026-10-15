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

let VERSION = '0.0.0';
try { VERSION = require('../package.json').version || VERSION; } catch { /* no package.json */ }
const STARTED_AT = Date.now();

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

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const listBuilds = () => {
    try { return fs.readdirSync(config.build.outDir).filter((f) => f.endsWith('.html')).sort(); }
    catch { return []; }
  };
  // A token-free status page at GET / so opening the forwarded-port URL shows "it works", the
  // version, the built games, and the connection steps — never the token. Stats refresh live from
  // /health so it is visibly a running Node page. The extension URL is built from the request host.
  const landingPage = (req) => {
    const host = esc(String(req.headers.host || `127.0.0.1:${boundPort}`));
    const proto = req.headers['x-forwarded-proto'] || (/^(127\.0\.0\.1|localhost|\[::1\])/.test(host) ? 'http' : 'https');
    // When reverse-proxied under a path (e.g. /x70), the mount sends x-forwarded-prefix so the
    // page's own URLs resolve correctly; empty when the bridge is hit directly.
    const prefix = esc(String(req.headers['x-forwarded-prefix'] || '').replace(/\/$/, ''));
    const base = `${proto}://${host}${prefix}`;
    const builds = listBuilds();
    const buildsHtml = builds.length
      ? `<ul>${builds.map((f) => `<li><code>scratch/dist/${esc(f)}</code></li>`).join('')}</ul>`
      : '<p class="mut">No builds yet — run <code>npm run build</code> and they appear here.</p>';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>x70 Bridge</title>
<style>:root{color-scheme:light dark;--bg:#f6f8fa;--fg:#1f2328;--mut:#656d76;--card:#fff;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--accent:#1f6feb}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--mut:#8b949e;--card:#161b22;--line:#30363d;--ok:#3fb950;--bad:#f85149;--accent:#4493f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;padding:24px}
.card{max-width:700px;margin:0 auto 16px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 4px;display:flex;align-items:center;gap:10px}h2{font-size:15px;margin:20px 0 8px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 20%,transparent);transition:background .3s}
.dot.off{background:var(--bad);box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 20%,transparent)}
.sub{color:var(--mut);margin:0}.mut{color:var(--mut)}.tag{font:12px ui-monospace,Menlo,monospace;color:var(--mut);border:1px solid var(--line);border-radius:999px;padding:1px 8px;margin-left:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:12px;margin:18px 0}
.stat{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.stat b{display:block;font-size:18px}.stat span{color:var(--mut);font-size:12px}
ol{padding-left:20px}ul{padding-left:20px}li{margin:3px 0}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:1px 6px;font:13px ui-monospace,Menlo,monospace;word-break:break-all}
a{color:var(--accent)}.foot{color:var(--mut);font-size:12px;margin-top:4px}</style></head>
<body><div class="card">
<h1><span class="dot" id="dot"></span><span id="state">x70 Bridge is running</span><span class="tag">v${esc(VERSION)}</span></h1>
<p class="sub">Local daemon for high-performance TurboWarp / Scratch projects.</p>
<div class="grid">
<div class="stat"><b id="kv">${esc(kv.kind)}</b><span>cache</span></div>
<div class="stat"><b id="clients">${clients.size}</b><span>connected</span></div>
<div class="stat"><b id="uptime">0s</b><span>uptime</span></div>
<div class="stat"><b>${esc(process.platform)}</b><span>${esc(process.version)}</span></div>
</div>
<h2>Connect from TurboWarp</h2>
<ol>
<li>Add a custom extension from <code>${base}/extension.js</code> (keep "Run without sandbox" on).</li>
<li>Use the <b>pair with bridge</b> block once with <code>${base}</code> and your token from <code>scratch/data/bridge.token</code>.</li>
<li>Build standalone games with <code>npm run build</code> — the bridge is baked in.</li>
</ol>
<h2>Built games (${builds.length})</h2>
${buildsHtml}
<p class="foot">Live JSON: <a href="${prefix}/health">${prefix}/health</a> · Extension: <a href="${prefix}/extension.js">${prefix}/extension.js</a> · This page never shows your token.</p>
</div>
<script>
const fmt=s=>{s=Math.floor(s);return s<60?s+"s":s<3600?Math.floor(s/60)+"m "+(s%60)+"s":Math.floor(s/3600)+"h "+Math.floor(s%3600/60)+"m"};
async function tick(){try{const r=await fetch("${prefix}/health",{cache:"no-store"});const j=await r.json();
document.getElementById("kv").textContent=j.kv;document.getElementById("clients").textContent=j.clients;
document.getElementById("uptime").textContent=fmt(j.uptime||0);
document.getElementById("dot").classList.remove("off");document.getElementById("state").textContent="x70 Bridge is running";
}catch(e){document.getElementById("dot").classList.add("off");document.getElementById("state").textContent="bridge unreachable";}}
tick();setInterval(tick,3000);
</script></body></html>`;
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
        return send(res, 200, landingPage(req), { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, version: VERSION, kv: kv.kind, clients: clients.size, platform: process.platform, node: process.version, uptime: (Date.now() - STARTED_AT) / 1000 }, cors);
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
