'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream');
const config = require('./config');
const upstream = require('./upstream');
const { PREFIX, decodeTarget, proxify, isProxiedPath } = require('./urls');
const { rewriteHtml } = require('./rewrite-html');
const { rewriteCss } = require('./rewrite-css');
const { rewriteScript } = require('./rewrite-js');
const { SessionStore } = require('./cookies');
const pages = require('./pages');

const SESSION_COOKIE = '__psid';
const LAST_COOKIE = '__plast';

const sessions = new SessionStore({ file: config.dataFile, persist: config.persistSessions, ttlMs: config.sessionTtlMs });

const PUBLIC = path.join(__dirname, '..', 'public');
const clientJs = () => fs.readFileSync(path.join(PUBLIC, 'client.js'));
const CLIENT_JS = clientJs();

// Request headers never forwarded upstream as-is.
const REQ_DROP = new Set([
  'host', 'cookie', 'origin', 'referer', 'connection', 'keep-alive', 'proxy-connection',
  'proxy-authorization', 'te', 'trailer', 'upgrade', 'accept-encoding', 'forwarded', 'via',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip',
  'x-varnish', 'surrogate-capability', 'authorization-proxy', 'service-worker',
]);

// Response headers never sent back to the browser.
const RES_DROP = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'public-key-pins', 'public-key-pins-report-only', 'expect-ct',
  'set-cookie', 'set-cookie2', 'alt-svc', 'report-to', 'reporting-endpoints', 'nel',
  'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
  'clear-site-data', 'referrer-policy', 'connection', 'keep-alive', 'transfer-encoding',
  'proxy-authenticate', 'trailer', 'upgrade', 'link', 'origin-agent-cluster', 'service-worker-allowed',
  'x-xss-protection', 'permissions-policy', 'feature-policy', 'document-policy', 'timing-allow-origin',
]);

// ---------------------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function publicOrigin(req) {
  const proto = config.trustProxy && req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : (req.socket.encrypted ? 'https' : 'http');
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
  return proto + '://' + String(host).split(',')[0].trim();
}

function isSecureRequest(req) {
  return publicOrigin(req).startsWith('https:');
}

function sessionFor(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies[SESSION_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = SessionStore.newId();
    res._newCookies = res._newCookies || [];
    res._newCookies.push(`${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` + (isSecureRequest(req) ? '; Secure' : ''));
  }
  req._cookies = cookies;
  return { id, jar: sessions.get(id) };
}

function withNewCookies(res, headers) {
  if (res._newCookies && res._newCookies.length) {
    const existing = headers['set-cookie'] ? [].concat(headers['set-cookie']) : [];
    headers['set-cookie'] = existing.concat(res._newCookies);
    res._newCookies = null;
  }
  return headers;
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, withNewCookies(res, { 'content-length': buf.length, ...headers }));
  res.end(res.req.method === 'HEAD' ? undefined : buf);
}

function sendError(res, status, title, detail, targetUrl) {
  send(res, status, pages.errorPage(status, title, detail, targetUrl), {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
}

function redirect(res, location, status = 302) {
  send(res, status, '', { location, 'cache-control': 'no-store' });
}

/** Normalise what the user typed into a URL, or turn it into a search. */
function normaliseInput(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (isProxiedPath(s)) return decodeTarget(s)?.href || null;
  if (/^(https?|wss?):\/\//i.test(s)) {
    try { return new URL(s).href; } catch { /* fallthrough to search */ }
  }
  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]{2,}([/?#]\S*)?$/.test(s) || /^localhost(:\d+)?([/?#].*)?$/i.test(s) || /^\[?[0-9a-f:.]+\]?(:\d+)?([/?#].*)?$/i.test(s) && /[.:]/.test(s);
  if (looksLikeHost && !/\s/.test(s)) {
    try { return new URL('https://' + s).href; } catch { /* search */ }
  }
  return config.searchUrl.replace('%s', encodeURIComponent(s));
}

/** Real URL of the page that issued this request, recovered from the Referer. */
function refererTarget(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  try {
    const r = new URL(ref);
    const self = new URL(publicOrigin(req));
    if (r.host !== self.host) return null;
    return decodeTarget(r.pathname + r.search);
  } catch {
    return null;
  }
}

function siteOf(host) {
  const parts = host.split('.');
  return parts.slice(-2).join('.');
}

function buildUpstreamHeaders(req, target, jar) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_DROP.has(k) || k.startsWith('cf-') || k.startsWith('x-forwarded-')) continue;
    h[k] = v;
  }
  h.host = target.host;

  const accepted = String(req.headers['accept-encoding'] || '');
  const enc = ['gzip', 'deflate', 'br'].filter((e) => new RegExp('\\b' + e + '\\b', 'i').test(accepted));
  h['accept-encoding'] = enc.length ? enc.join(', ') : 'identity';

  const ref = refererTarget(req);
  if (ref) {
    h.referer = ref.href.replace(/#.*$/, '');
    if (req.headers['sec-fetch-site']) {
      h['sec-fetch-site'] = ref.origin === target.origin ? 'same-origin' : siteOf(ref.hostname) === siteOf(target.hostname) ? 'same-site' : 'cross-site';
    }
  } else if (req.headers['sec-fetch-site']) {
    h['sec-fetch-site'] = 'none';
  }
  if (req.headers.origin) {
    h.origin = ref ? ref.origin : target.origin;
  }

  const cookie = jar.header(target);
  if (cookie) h.cookie = cookie;
  return h;
}

function filterResponseHeaders(upHeaders, target, rewriting) {
  const out = {};
  for (const [k, v] of Object.entries(upHeaders)) {
    if (RES_DROP.has(k)) continue;
    if (rewriting && (k === 'content-length' || k === 'content-encoding' || k === 'content-md5' || k === 'digest')) continue;
    out[k] = v;
  }
  if (upHeaders.location) out.location = proxify(upHeaders.location, target.href);
  if (upHeaders['content-location']) out['content-location'] = proxify(upHeaders['content-location'], target.href);
  if (upHeaders.refresh) {
    out.refresh = String(upHeaders.refresh).replace(/(url\s*=\s*)(\S+)/i, (m, a, u) => a + proxify(u, target.href));
  }
  out['referrer-policy'] = 'same-origin';
  out['x-proxied-url'] = encodeURI(target.href);
  return out;
}

const DOC_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);

// Rewritten scripts are cached by content hash: bundles are big and shared across pages.
const scriptCache = new Map();
let scriptCacheBytes = 0;
const SCRIPT_CACHE_MAX = 96 * 1024 * 1024;
function cachedScript(text) {
  if (text.length < 4096) return rewriteScript(text);
  const key = require('crypto').createHash('sha1').update(text).digest('base64');
  const hit = scriptCache.get(key);
  if (hit !== undefined) {
    scriptCache.delete(key);
    scriptCache.set(key, hit);
    return hit;
  }
  const out = rewriteScript(text);
  scriptCache.set(key, out);
  scriptCacheBytes += out.length;
  while (scriptCacheBytes > SCRIPT_CACHE_MAX && scriptCache.size) {
    const [k, v] = scriptCache.entries().next().value;
    scriptCache.delete(k);
    scriptCacheBytes -= v.length;
  }
  return out;
}

const SCRIPT_DESTS = new Set(['script', 'worker', 'sharedworker', 'serviceworker', 'audioworklet', 'paintworklet']);

function kindOf(contentType, dest) {
  const ct = String(contentType || '').toLowerCase();
  if (dest && SCRIPT_DESTS.has(dest)) {
    // Whatever the label, a script request gets script treatment (unless it is clearly JSON/data).
    return /json|image\/|video\/|audio\/|font\/|octet-stream|wasm/.test(ct) ? null : 'js';
  }
  if (dest === 'style') return /^text\/css/.test(ct) || !ct || /^text\/plain/.test(ct) ? 'css' : null;
  if (/^(text\/html|application\/xhtml\+xml)/.test(ct)) return dest && dest !== 'document' && dest !== 'iframe' && dest !== 'frame' && dest !== 'embed' && dest !== 'object' && dest !== 'empty' ? null : 'html';
  if (/^text\/css/.test(ct)) return 'css';
  if (/^image\/svg\+xml/.test(ct)) return 'svg';
  if (/^(text|application)\/(x-)?(javascript|ecmascript)|^text\/jscript/.test(ct)) return 'js';
  return null;
}

function decompress(buf, encoding) {
  const e = String(encoding || '').trim().toLowerCase();
  try {
    if (!e || e === 'identity') return buf;
    if (e === 'gzip' || e === 'x-gzip') return zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    if (e === 'br') return zlib.brotliDecompressSync(buf);
    if (e === 'deflate') {
      try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
    }
  } catch (err) {
    throw new Error('Could not decode ' + e + ' response: ' + err.message);
  }
  throw new Error('Unsupported content-encoding: ' + e);
}

function charsetOf(contentType, buf) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '');
  if (m) return m[1].toLowerCase();
  const head = buf.toString('latin1', 0, Math.min(buf.length, 2048));
  const mm = /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  return mm ? mm[1].toLowerCase() : null;
}

/** Decode bytes to text. Returns {text, encoding} where encoding is 'utf8' or 'latin1' (byte-preserving). */
function bytesToText(buf, contentType) {
  const cs = charsetOf(contentType, buf);
  if (!cs || cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') {
    try {
      let text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { text, encoding: 'utf8' };
    } catch { /* not valid utf-8 */ }
  }
  return { text: buf.toString('latin1'), encoding: 'latin1' };
}

function clientConfig(target, req) {
  return {
    url: target.href,
    prefix: PREFIX,
    toolbar: config.toolbar,
    origin: publicOrigin(req),
  };
}

function injectionFor(target, req) {
  const cfg = JSON.stringify(clientConfig(target, req)).replace(/</g, '\\u003c');
  return `<script data-proxy-runtime>window.__PROXY_CFG=${cfg};</script><script src="/__proxy/client.js?v=${CLIENT_VERSION}" data-proxy-runtime></script>`;
}

const CLIENT_VERSION = require('crypto').createHash('sha1').update(CLIENT_JS).digest('hex').slice(0, 10);

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

function finishRewritten(req, res, status, headers, text, encoding) {
  let body = Buffer.from(text, encoding);
  headers.vary = headers.vary ? headers.vary + ', Accept-Encoding' : 'Accept-Encoding';
  const done = (buf, gz) => {
    if (gz) headers['content-encoding'] = 'gzip';
    headers['content-length'] = buf.length;
    res.writeHead(status, withNewCookies(res, headers));
    res.end(req.method === 'HEAD' ? undefined : buf);
  };
  if (body.length > 1024 && acceptsGzip(req)) {
    zlib.gzip(body, { level: 5 }, (err, gz) => (err ? done(body, false) : done(gz, true)));
  } else {
    done(body, false);
  }
}

// ---------------------------------------------------------------------------------------

function proxyRequest(req, res, target) {
  if (target.protocol === 'ws:') target.protocol = 'http:';
  if (target.protocol === 'wss:') target.protocol = 'https:';

  const { jar } = sessionFor(req, res);
  const headers = buildUpstreamHeaders(req, target, jar);

  let upReq;
  try {
    upReq = upstream.request(target, { method: req.method, headers });
  } catch (e) {
    return sendError(res, e.code === 'EBLOCKED' ? 403 : 400, 'Request blocked', e.message, target.href);
  }

  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) { aborted = true; upReq.destroy(); }
  });

  upReq.setTimeout(config.upstreamTimeout, () => {
    upReq.destroy(Object.assign(new Error('The site took too long to respond.'), { code: 'ETIMEDOUT' }));
  });

  upReq.on('error', (err) => {
    if (aborted) return;
    const status = err.code === 'EBLOCKED' ? 403 : err.code === 'ETIMEDOUT' ? 504 : 502;
    const titles = {
      ENOTFOUND: 'Site not found', EAI_AGAIN: 'DNS lookup failed', ECONNREFUSED: 'Connection refused',
      ECONNRESET: 'Connection reset', ETIMEDOUT: 'Timed out', EBLOCKED: 'Request blocked',
      CERT_HAS_EXPIRED: 'Certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'Untrusted certificate',
      ERR_TLS_CERT_ALTNAME_INVALID: 'Certificate mismatch',
    };
    if (config.logRequests) console.error('[proxy] upstream error', target.href, err.code, err.message);
    sendError(res, status, titles[err.code] || 'Could not load page', `${err.message}${err.code ? ' (' + err.code + ')' : ''}`, target.href);
  });

  upReq.on('response', (upRes) => {
    upReq.setTimeout(0);
    handleResponse(req, res, target, jar, upRes, headers.cookie);
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    upReq.end();
  } else {
    pipeline(req, upReq, (err) => { if (err && !aborted) upReq.destroy(err); });
  }
}

function handleResponse(req, res, target, jar, upRes, sentCookies) {
  const status = upRes.statusCode;

  const setCookies = upRes.headers['set-cookie'];
  if (setCookies) for (const sc of [].concat(setCookies)) jar.set(sc, target);

  const noBody = req.method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
  const kind = noBody ? null : kindOf(upRes.headers['content-type'], req.headers['sec-fetch-dest']);
  const len = parseInt(upRes.headers['content-length'] || '0', 10);
  const rewriting = Boolean(kind) && !(len > config.maxRewriteBytes);

  const headers = filterResponseHeaders(upRes.headers, target, rewriting);
  if (sentCookies && !/\bpublic\b/i.test(upRes.headers['cache-control'] || '')) headers['x-proxy-private'] = '1';

  // Remember the origin of top-level documents so stray root-relative requests can be routed.
  const dest = req.headers['sec-fetch-dest'];
  if (kind === 'html' && (!dest || dest === 'document')) {
    res._newCookies = res._newCookies || [];
    res._newCookies.push(`${LAST_COOKIE}=${encodeURIComponent(target.origin)}; Path=/; SameSite=Lax` + (isSecureRequest(req) ? '; Secure' : ''));
  }

  if (!rewriting) {
    res.writeHead(status, withNewCookies(res, headers));
    if (noBody) { upRes.resume(); res.end(); return; }
    pipeline(upRes, res, () => {});
    return;
  }

  const chunks = [];
  let size = 0;
  let tooBig = false;
  upRes.on('data', (c) => {
    size += c.length;
    if (size > config.maxRewriteBytes) { tooBig = true; upRes.destroy(); return; }
    chunks.push(c);
  });
  upRes.on('error', (err) => { if (!res.headersSent) sendError(res, 502, 'Connection interrupted', err.message, target.href); });
  upRes.on('end', () => {
    if (tooBig) return sendError(res, 502, 'Response too large', 'The response exceeded the rewrite limit.', target.href);
    let buf;
    try {
      buf = decompress(Buffer.concat(chunks), upRes.headers['content-encoding']);
    } catch (e) {
      return sendError(res, 502, 'Bad response from site', e.message, target.href);
    }
    const { text, encoding } = bytesToText(buf, upRes.headers['content-type']);
    let out;
    try {
      if (kind === 'css') out = rewriteCss(text, target.href);
      else if (kind === 'js') out = cachedScript(text);
      else if (kind === 'svg') out = rewriteHtml(text, target.href, {});
      else out = rewriteHtml(text, target.href, { inject: DOC_DESTS.has(dest || 'document') ? injectionFor(target, req) : null });
    } catch (e) {
      console.error('[proxy] rewrite failed for', target.href, e);
      out = text;
    }
    if (encoding === 'utf8') {
      const ct = String(upRes.headers['content-type'] || { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' }[kind] || 'text/html');
      headers['content-type'] = /charset=/i.test(ct) ? ct.replace(/charset\s*=\s*["']?[\w.:-]+["']?/i, 'charset=utf-8') : ct + '; charset=utf-8';
    }
    finishRewritten(req, res, status, headers, out, encoding);
  });
}

// ---------------------------------------------------------------------------------------

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function internalRoute(req, res, url) {
  const p = url.pathname;
  if (p === '/__proxy/client.js') {
    const body = process.env.NODE_ENV === 'development' ? clientJs() : CLIENT_JS;
    return send(res, 200, body, {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': url.searchParams.get('v') === CLIENT_VERSION ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
  }
  if (p === '/__proxy/home' || p === '/__proxy/') {
    return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  }
  if (p === '/__proxy/go') {
    const target = normaliseInput(url.searchParams.get('url') || url.searchParams.get('q'));
    if (!target) return redirect(res, '/');
    return redirect(res, PREFIX + target);
  }
  if (p === '/__proxy/cookie') {
    const { jar } = sessionFor(req, res);
    let target;
    try { target = new URL(url.searchParams.get('url')); } catch { return send(res, 400, 'bad url'); }
    if (req.method === 'POST') {
      const body = await readBody(req);
      jar.set(body, target, { fromScript: true });
    }
    return send(res, 200, jar.header(target, { includeHttpOnly: false }), {
      'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
    });
  }
  if (p === '/__proxy/clear' && req.method === 'POST') {
    const { id, jar } = sessionFor(req, res);
    jar.clear();
    sessions.delete(id);
    return send(res, 200, 'ok', { 'cache-control': 'no-store' });
  }
  if (p === '/__proxy/health') {
    return send(res, 200, JSON.stringify({ ok: true, sessions: sessions.jars.size, uptime: process.uptime() }), {
      'content-type': 'application/json', 'cache-control': 'no-store',
    });
  }
  return sendError(res, 404, 'Not found', 'Unknown proxy endpoint.');
}

function checkAuth(req, res) {
  if (!config.basicAuth) return true;
  const h = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(config.basicAuth).toString('base64');
  const a = Buffer.from(h);
  const b = Buffer.from(expected);
  if (a.length === b.length && require('crypto').timingSafeEqual(a, b)) return true;
  send(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="proxy", charset="UTF-8"', 'content-type': 'text/plain' });
  return false;
}

async function handle(req, res) {
  res.req = req;
  const started = Date.now();
  if (config.logRequests) res.on('finish', () => console.log(`[proxy] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
  try {
    if (!checkAuth(req, res)) return;
    const raw = req.url || '/';

    if (isProxiedPath(raw)) {
      const target = decodeTarget(raw);
      if (!target) return sendError(res, 400, 'Invalid address', 'That URL could not be understood.');
      // A bare origin ("/p/https://example.com") must end in "/" so relative URLs resolve correctly.
      if (/^\/p\/https?:\/\/[^/?#]+(?:[?#].*)?$/i.test(raw) && (req.method === 'GET' || req.method === 'HEAD')) {
        return redirect(res, PREFIX + target.href, 301);
      }
      return proxyRequest(req, res, target);
    }

    const url = new URL(raw, 'http://local');
    if (url.pathname.startsWith('/__proxy/')) return await internalRoute(req, res, url);

    // Root-relative request that escaped rewriting (e.g. built in JS): route it via the referring page.
    const ref = refererTarget(req);
    const fromHome = !ref && (url.pathname === '/' || url.pathname === '/index.html');
    if (fromHome) {
      if (url.searchParams.get('url') || url.searchParams.get('q')) {
        const target = normaliseInput(url.searchParams.get('url') || url.searchParams.get('q'));
        if (target) return redirect(res, PREFIX + target);
      }
      return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    }

    let origin = ref ? ref.origin : null;
    if (!origin) {
      const last = parseCookies(req.headers.cookie)[LAST_COOKIE];
      if (last) {
        try { origin = new URL(decodeURIComponent(last)).origin; } catch { /* ignore */ }
      }
    }
    if (origin && (ref || url.pathname !== '/favicon.ico')) {
      return redirect(res, PREFIX + new URL(raw, origin).href, 307);
    }
    if (url.pathname === '/favicon.ico') {
      return send(res, 200, pages.FAVICON, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    }
    return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
  } catch (e) {
    console.error('[proxy] internal error', e);
    if (!res.headersSent) sendError(res, 500, 'Internal error', e.message);
    else res.destroy();
  }
}

module.exports = {
  handle, sessions, sessionFor, buildUpstreamHeaders, refererTarget, publicOrigin,
  normaliseInput, parseCookies, SESSION_COOKIE,
};
