'use strict';

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
let homeCache = null;

function homePage() {
  if (!homeCache || process.env.NODE_ENV === 'development') homeCache = fs.readFileSync(INDEX);
  return homeCache;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(status, title, detail, targetUrl) {
  const retry = targetUrl ? `<a class="btn" href="/p/${esc(targetUrl)}">Try again</a>` : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --text:#16181d; --muted:#5d6474; --border:#dde1ea; --accent:#3b5bdb; --accent-text:#fff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#e8eaf0; --muted:#9aa3b5; --border:#2a2f3a; --accent:#748ffc; --accent-text:#0f1115; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; display:flex; justify-content:center; padding:14vh 16px; }
  .card { max-width:560px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  .code { color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.05em; }
  h1 { margin:4px 0 8px; font-size:22px; }
  p { color:var(--muted); margin:0 0 16px; overflow-wrap:anywhere; }
  .url { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  .btn { display:inline-block; text-decoration:none; padding:8px 16px; border-radius:10px; margin-right:8px; background:var(--accent); color:var(--accent-text); font-weight:600; }
  .btn.alt { background:transparent; color:var(--text); border:1px solid var(--border); }
</style></head>
<body><div class="card">
  <div class="code">ERROR ${esc(status)}</div>
  <h1>${esc(title)}</h1>
  <p>${esc(detail)}</p>
  ${targetUrl ? `<p class="url">${esc(targetUrl)}</p>` : ''}
  ${retry}<a class="btn alt" href="/__proxy/home">Home</a>
</div></body></html>`;
}

const FAVICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="#3b5bdb" stroke-width="3"/><path d="M3 16h26M16 3c4 4 5.5 8.5 5.5 13S20 25 16 29c-4-4-5.5-8.5-5.5-13S12 7 16 3z" fill="none" stroke="#3b5bdb" stroke-width="3"/></svg>');

module.exports = { homePage, errorPage, FAVICON };
