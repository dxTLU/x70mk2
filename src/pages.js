'use strict';

const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '..', 'public', 'index.html');
const BRAND = 'userx70 host server';
let homeCache = null;

function homePage() {
  if (!homeCache || process.env.NODE_ENV === 'development') homeCache = fs.readFileSync(INDEX);
  return homeCache;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CERT_HINT = 'The site\'s HTTPS certificate could not be verified, and the proxy never connects insecurely. ' +
  'If this is an internal server with its own certificate authority, the administrator can trust it with NODE_EXTRA_CA_CERTS.';
const RESET_HINT = 'The connection dropped. Try again; if it keeps happening, the site or a firewall may be blocking this server.';
const UNREACHABLE_HINT = 'This server has no network route to the site. Check its network connection and firewall.';

// What the user can do about each kind of failure, by error code.
const HINTS = {
  ENOTFOUND: 'Check the spelling of the address. If it is right, the site may be down or its name may not resolve from this server.',
  EAI_AGAIN: 'This server could not reach its DNS resolver. Check its network connection, then try again.',
  ECONNREFUSED: 'The site refused the connection: it may be down, or nothing listens on that port.',
  ECONNRESET: RESET_HINT,
  EPIPE: RESET_HINT,
  ETIMEDOUT: 'The site took too long to answer. It may be overloaded or blocking this server; try again in a moment.',
  EBLOCKED: 'For safety the proxy does not open private-network addresses or itself. On a lab network the administrator can allow them with ALLOW_PRIVATE=1.',
  EPROXY: 'The upstream proxy this server sends its traffic through (UPSTREAM_PROXY or HTTPS_PROXY) failed the request. Check its address and credentials.',
  EHOSTUNREACH: UNREACHABLE_HINT,
  ENETUNREACH: UNREACHABLE_HINT,
  CERT: CERT_HINT,
  HPE: 'The site sent a response the proxy could not understand. Opening it directly may work.',
};

// Pages produced by the proxy itself, by title.
const TITLE_HINTS = {
  'Connection interrupted': 'The site stopped sending the page part-way through. Reload to try again.',
  'Bad response from site': HINTS.HPE,
  'Invalid address': 'Use a full address such as https://example.com/, or type search terms on the home page.',
  'Not found': 'This proxy address does not exist. Start again from the home page.',
  'Internal error': 'Something went wrong inside the proxy. Try again; if it keeps happening, check the server log (LOG_REQUESTS=1 logs every request).',
};

/** The error code a page is about: given explicitly, or the "(CODE)" the proxy appends to details. */
function errorCode(detail, code) {
  if (code) return String(code);
  const m = /\(([A-Z][A-Z0-9_]+)\)\s*$/.exec(String(detail || ''));
  return m ? m[1] : '';
}

function hintFor(status, title, detail, code) {
  const c = errorCode(detail, code);
  if (HINTS[c]) return HINTS[c];
  if (/CERT|^ERR_TLS_|^ERR_SSL_/.test(c)) return HINTS.CERT;
  if (/^HPE_/.test(c)) return HINTS.HPE;
  if (TITLE_HINTS[title]) return TITLE_HINTS[title];
  if (status === 504) return HINTS.ETIMEDOUT;
  if (status >= 500) return 'The site could not be loaded through the proxy. Try again, or open it directly.';
  return 'Go back and try another address, or start again from the home page.';
}

/** The target as a link that leaves the proxy, for http(s) targets only. */
function directUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The page shown when a proxied site cannot be loaded.
 * @param {number} status
 * @param {string} title
 * @param {string} detail technical detail (the proxy appends "(CODE)" for network errors)
 * @param {string} [targetUrl] the real URL that was requested
 * @param {{code?: string}} [opts] the error code, when the caller has it
 */
function errorPage(status, title, detail, targetUrl, opts = {}) {
  const hint = hintFor(Number(status), title, detail, opts.code);
  const direct = targetUrl ? directUrl(targetUrl) : null;
  const actions = [];
  if (targetUrl) actions.push(`<a class="btn" href="/p/${esc(targetUrl)}">Try again</a>`);
  // Without JavaScript (or history) "Go back" goes home.
  actions.push('<a class="btn alt" href="/__proxy/home" onclick="if(history.length>1){history.back();return false}">Go back</a>');
  if (direct) actions.push(`<a class="btn alt" href="${esc(direct)}" rel="noopener noreferrer" title="Leave the proxy and open the site in this browser">Open directly</a>`);
  actions.push('<a class="btn alt" href="/__proxy/home">Home</a>');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --text:#16181d; --muted:#5d6474; --border:#dde1ea; --accent:#3b5bdb; --accent-text:#fff; --hint:#eef1f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#e8eaf0; --muted:#9aa3b5; --border:#2a2f3a; --accent:#748ffc; --accent-text:#0f1115; --hint:#20242d; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; display:flex; justify-content:center; padding:12vh 16px 32px; }
  main { max-width:600px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; }
  .code { color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.05em; }
  h1 { margin:4px 0 8px; font-size:22px; line-height:1.3; }
  p { color:var(--muted); margin:0 0 16px; overflow-wrap:anywhere; }
  .hint { color:var(--text); background:var(--hint); border-radius:10px; padding:12px 14px; }
  .url { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; }
  details { margin:0 0 20px; color:var(--muted); font-size:14px; }
  summary { cursor:pointer; }
  details p { margin:8px 0 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:13px; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; }
  .btn { display:inline-block; text-decoration:none; padding:9px 16px; border-radius:10px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-text); font-weight:600; }
  .btn.alt { background:transparent; color:var(--text); border-color:var(--border); }
  .btn:hover { border-color:var(--accent); }
  .btn:focus-visible, summary:focus-visible { outline:3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset:2px; }
  footer { margin-top:20px; color:var(--muted); font-size:12px; }
</style></head>
<body><main>
  <div class="code">ERROR ${esc(status)}</div>
  <h1>${esc(title)}</h1>
  ${targetUrl ? `<p class="url">${esc(targetUrl)}</p>` : ''}
  <p class="hint">${esc(hint)}</p>
  ${detail ? `<details><summary>Technical details</summary><p>${esc(detail)}</p></details>` : ''}
  <div class="actions">${actions.join('')}</div>
  <footer>${esc(BRAND)}</footer>
</main></body></html>`;
}

const FAVICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="#3b5bdb" stroke-width="3"/><path d="M3 16h26M16 3c4 4 5.5 8.5 5.5 13S20 25 16 29c-4-4-5.5-8.5-5.5-13S12 7 16 3z" fill="none" stroke="#3b5bdb" stroke-width="3"/></svg>');

module.exports = { homePage, errorPage, hintFor, esc, FAVICON };
