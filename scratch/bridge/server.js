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
    const prefix = esc(String(req.headers['x-forwarded-prefix'] || '').replace(/\/$/, ''));
    const base = `${proto}://${host}${prefix}`;
    const builds = listBuilds();
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>x70 Bridge</title>
<style>
:root{color-scheme:light dark;
 --bg:#f6f8fc;--panel:#ffffff;--panel2:#f3f5fa;--fg:#161a22;--muted:#5b6472;--line:#e6e9f0;
 --accent:#4f46e5;--accent2:#7c6cf5;--accent-fg:#fff;--ok:#10b981;--warn:#f59e0b;--bad:#ef4444;--track:#e9edf5;--shadow:0 1px 2px rgba(20,25,40,.06),0 8px 24px rgba(20,25,40,.06)}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){
 --bg:#0a0d14;--panel:#111621;--panel2:#0e131d;--fg:#e8edf5;--muted:#8a94a6;--line:#212838;
 --accent:#818cf8;--accent2:#a78bfa;--accent-fg:#0a0d14;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--track:#1a2130;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35)}}
:root[data-theme=dark]{
 --bg:#0a0d14;--panel:#111621;--panel2:#0e131d;--fg:#e8edf5;--muted:#8a94a6;--line:#212838;
 --accent:#818cf8;--accent2:#a78bfa;--accent-fg:#0a0d14;--ok:#34d399;--warn:#fbbf24;--bad:#f87171;--track:#1a2130;--shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35)}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 600px at 100% -10%,color-mix(in srgb,var(--accent) 14%,transparent),transparent),var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,system-ui,sans-serif;-webkit-font-smoothing:antialiased;padding:24px}
.wrap{max-width:860px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px 22px;box-shadow:var(--shadow)}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.mark{width:34px;height:34px;flex:none;border-radius:10px;background:linear-gradient(135deg,var(--accent),var(--accent2));display:grid;place-items:center;color:#fff}
h1{font-size:19px;margin:0;font-weight:700;letter-spacing:-.01em}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 12px;font-weight:600}
.sub{color:var(--muted);margin:2px 0 0;font-size:13px}
.spacer{flex:1}
.pill{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;padding:5px 11px;border-radius:999px;border:1px solid var(--line);background:var(--panel2)}
.tag{font:12px ui-monospace,Menlo,monospace;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 9px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--ok);box-shadow:0 0 0 4px color-mix(in srgb,var(--ok) 22%,transparent);transition:background .3s,box-shadow .3s}
.dot.off{background:var(--bad);box-shadow:0 0 0 4px color-mix(in srgb,var(--bad) 22%,transparent)}
.iconbtn{width:36px;height:36px;border-radius:10px;border:1px solid var(--line);background:var(--panel2);color:var(--fg);cursor:pointer;display:grid;place-items:center;font-size:16px}
.iconbtn:hover{border-color:var(--accent)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.tile{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:13px 14px}
.tile .big{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.tile .lbl{color:var(--muted);font-size:12px;margin-top:2px}
.bar{height:6px;border-radius:999px;background:var(--track);margin-top:9px;overflow:hidden}
.bar>span{display:block;height:100%;width:0;border-radius:999px;background:var(--accent);transition:width .5s ease,background .3s}
ol{padding-left:20px;margin:0}ol li{margin:7px 0}
code{background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 7px;font:12.5px ui-monospace,Menlo,monospace;word-break:break-all}
.row{display:flex;flex-wrap:wrap;gap:9px;margin-top:4px}
.btn{display:inline-flex;align-items:center;gap:7px;font:inherit;font-size:13.5px;font-weight:600;padding:9px 14px;border-radius:10px;cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--fg);text-decoration:none}
.btn:hover{border-color:var(--accent)}
.btn.primary{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:0}
.btn.primary:hover{filter:brightness(1.07)}
.btn:focus-visible,.iconbtn:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
.games{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px}
.game{border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--panel2);display:flex;flex-direction:column}
.game .thumb{height:92px;background:linear-gradient(135deg,color-mix(in srgb,var(--accent) 60%,#000 0%),var(--accent2));display:grid;place-items:center;color:#fff;font-size:30px}
.game .body{padding:11px 12px;display:flex;flex-direction:column;gap:9px}
.game .name{font-weight:650;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.game .acts{display:flex;gap:7px}
.game .acts .btn{padding:7px 11px;font-size:12.5px;flex:1;justify-content:center}
.empty{color:var(--muted);font-size:13.5px}
.tokfield{display:none;margin-top:10px;gap:8px;flex-wrap:wrap;align-items:center}
.tokfield input{flex:1;min-width:200px;font:12.5px ui-monospace,Menlo,monospace;padding:9px 11px;border-radius:9px;border:1px solid var(--line);background:var(--panel2);color:var(--fg)}
.warn{color:var(--warn);font-size:12.5px;margin-top:7px}
.foot{color:var(--muted);font-size:12px}
.foot a{color:var(--accent)}
#toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(16px);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:10px;font-size:13.5px;font-weight:600;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;box-shadow:var(--shadow)}
#toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:560px){body{padding:14px}.card{padding:16px}}
</style></head>
<body><div class="wrap">
  <div class="card"><header>
    <div class="mark"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21C9.5 18.4 8.2 15.3 8.2 12S9.5 5.6 12 3z"/></svg></div>
    <div><h1>x70 Bridge</h1><p class="sub">High-performance TurboWarp / Scratch pipeline</p></div>
    <div class="spacer"></div>
    <span class="tag">v${esc(VERSION)}</span>
    <span class="pill" id="statusPill"><span class="dot" id="statusDot"></span><span id="statusText">online</span></span>
    <button class="iconbtn" id="themeBtn" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </header></div>

  <div class="card">
    <div class="grid">
      <div class="tile"><div class="big" id="cpu">—</div><div class="lbl">CPU</div><div class="bar"><span id="cpuBar"></span></div></div>
      <div class="tile"><div class="big" id="mem">—</div><div class="lbl">Memory</div><div class="bar"><span id="memBar"></span></div></div>
      <div class="tile"><div class="big" id="clients">${clients.size}</div><div class="lbl">connected</div></div>
      <div class="tile"><div class="big" id="uptime">0s</div><div class="lbl">uptime</div></div>
      <div class="tile"><div class="big" id="kv" style="font-size:17px">${esc(kv.kind)}</div><div class="lbl">cache</div></div>
      <div class="tile"><div class="big" style="font-size:16px">${esc(process.platform)}</div><div class="lbl">${esc(process.version)}</div></div>
    </div>
  </div>

  <div class="card">
    <h2>Connect from TurboWarp</h2>
    <ol>
      <li>Open <a class="foot" href="https://turbowarp.org/editor" target="_blank" rel="noopener">turbowarp.org/editor</a>, add a <b>custom extension</b> and keep "Run without sandbox" on.</li>
      <li>Paste the <b>extension URL</b>, then use the <b>pair with bridge</b> block with the URL below and your token.</li>
      <li>Package standalone games with <code>npm run build</code> — the bridge is baked in.</li>
    </ol>
    <div class="row">
      <button class="btn primary" data-copy="${base}/extension.js">Copy extension URL</button>
      <button class="btn" data-copy="${base}">Copy bridge URL</button>
      <button class="btn" id="tokBtn">Reveal &amp; copy token</button>
      <a class="btn" href="https://turbowarp.org/editor" target="_blank" rel="noopener">Open TurboWarp ↗</a>
    </div>
    <div class="tokfield" id="tokField"><input id="tokInput" readonly value=""><button class="btn" data-copyinput="tokInput">Copy</button></div>
    <p class="warn" id="tokWarn" style="display:none">⚠ This token grants access to the bridge. Keep this forwarded port Private.</p>
  </div>

  <div class="card">
    <h2>Playable builds <span class="sub" id="gamesCount"></span></h2>
    <div class="games" id="games"></div>
    <p class="empty" id="gamesEmpty">No builds yet — run <code>npm run build</code> and they appear here instantly.</p>
  </div>

  <p class="foot" style="text-align:center">Live JSON <a href="${prefix}/health">${prefix}/health</a> · Extension <a href="${prefix}/extension.js">${prefix}/extension.js</a> · The token is hidden until you reveal it.</p>
</div>
<div id="toast"></div>
<script>
var P=${JSON.stringify(prefix)};
var BUILDS=${JSON.stringify(builds)};
function $(id){return document.getElementById(id)}
function fmt(s){s=Math.floor(s||0);return s<60?s+"s":s<3600?Math.floor(s/60)+"m "+(s%60)+"s":Math.floor(s/3600)+"h "+Math.floor(s%3600/60)+"m"}
var toastT;
function toast(m){var t=$("toast");t.textContent=m;t.classList.add("show");clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove("show")},1600)}
function copy(text){if(navigator.clipboard&&navigator.clipboard.writeText){return navigator.clipboard.writeText(text).then(function(){toast("Copied")},function(){window.prompt("Copy:",text)})}window.prompt("Copy:",text)}
document.addEventListener("click",function(e){
  var c=e.target.closest&&e.target.closest("[data-copy]");if(c){copy(c.getAttribute("data-copy"));return}
  var ci=e.target.closest&&e.target.closest("[data-copyinput]");if(ci){copy($(ci.getAttribute("data-copyinput")).value);return}
});
// theme toggle: auto -> light -> dark
var THEMES=["auto","light","dark"],GL={auto:"◐",light:"☀",dark:"☾"};
var theme="auto";try{theme=localStorage.getItem("x70-theme")||"auto"}catch(e){}
function applyTheme(){if(theme==="auto"){delete document.documentElement.dataset.theme}else{document.documentElement.dataset.theme=theme}$("themeBtn").textContent=GL[theme];try{localStorage.setItem("x70-theme",theme)}catch(e){}}
$("themeBtn").addEventListener("click",function(){theme=THEMES[(THEMES.indexOf(theme)+1)%3];applyTheme();toast("Theme: "+theme)});
applyTheme();
// reveal token
$("tokBtn").addEventListener("click",function(){
  fetch(P+"/token",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){
    $("tokInput").value=j.token;$("tokField").style.display="flex";$("tokWarn").style.display="block";copy(j.token);
  }).catch(function(){toast("Could not read token")});
});
// games
function barColor(v){return v<60?"var(--accent)":v<85?"var(--warn)":"var(--bad)"}
function renderGames(list){
  var g=$("games");g.innerHTML="";
  if(!list||!list.length){$("gamesEmpty").style.display="";$("gamesCount").textContent="";return}
  $("gamesEmpty").style.display="none";$("gamesCount").textContent="("+list.length+")";
  list.forEach(function(f){
    var name=f.replace(/\\.html$/,"");var url=P+"/play/"+encodeURIComponent(f);
    var el=document.createElement("div");el.className="game";
    var thumb=document.createElement("div");thumb.className="thumb";thumb.textContent="🎮";
    var body=document.createElement("div");body.className="body";
    var nm=document.createElement("div");nm.className="name";nm.textContent=name;nm.title=name;
    var acts=document.createElement("div");acts.className="acts";
    var play=document.createElement("a");play.className="btn primary";play.href=url;play.target="_blank";play.rel="noopener";play.textContent="▶ Play";
    var cp=document.createElement("button");cp.className="btn";cp.textContent="Link";cp.addEventListener("click",function(){copy(location.origin+url)});
    acts.appendChild(play);acts.appendChild(cp);body.appendChild(nm);body.appendChild(acts);el.appendChild(thumb);el.appendChild(body);g.appendChild(el);
  });
}
renderGames(BUILDS);
// live stats
function setBar(id,v){var b=$(id);b.style.width=Math.max(0,Math.min(100,v))+"%";b.style.background=barColor(v)}
function online(j){
  $("statusDot").classList.remove("off");$("statusText").textContent="online";
  $("cpu").textContent=(j.cpu!=null?j.cpu:0)+"%";setBar("cpuBar",j.cpu||0);
  $("mem").textContent=(j.mem!=null?j.mem:0)+"%";setBar("memBar",j.mem||0);
  $("clients").textContent=j.clients;$("uptime").textContent=fmt(j.uptime);$("kv").textContent=j.kv;
}
function offline(){$("statusDot").classList.add("off");$("statusText").textContent="offline"}
function tick(){fetch(P+"/health",{cache:"no-store"}).then(function(r){return r.json()}).then(function(j){online(j);
  fetch(P+"/games",{cache:"no-store"}).then(function(r){return r.json()}).then(function(g){if((g.builds||[]).length!==($("games").children.length))renderGames(g.builds)}).catch(function(){});
}).catch(offline)}
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
