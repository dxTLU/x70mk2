'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { pipeline } = require('stream');
const { promisify } = require('util');
const config = require('./config');
const upstream = require('./upstream');
const { PREFIX, decodeTarget, proxify, isProxiedPath } = require('./urls');
const { rewriteHtml } = require('./rewrite-html');
const { rewriteCss } = require('./rewrite-css');
const { rewriteScript } = require('./rewrite-js');
const { SessionStore, siteOf, registrableDomain } = require('./cookies');
const pages = require('./pages');

const SESSION_COOKIE = '__psid';
const LAST_COOKIE = '__plast';

const sessions = new SessionStore({ file: config.dataFile, persist: config.persistSessions, ttlMs: config.sessionTtlMs });

// ---- client runtime bundle ----------------------------------------------------------------

const PUBLIC = path.join(__dirname, '..', 'public');
const CLIENT_SOURCES = [path.join(__dirname, 'rewrite-js.js'), path.join(PUBLIC, 'client.js')];
const REWRITER_SOURCES = ['rewrite-html.js', 'rewrite-css.js', 'rewrite-js.js', 'urls.js', 'proxy.js'].map((f) => path.join(__dirname, f));

/**
 * /__proxy/client.js is the JS rewriter followed by the browser runtime. The rewriter is a UMD
 * module; inside this wrapper `module`, `exports`, `define` and `require` are undefined
 * parameters, so it can only publish globalThis.__proxyRewriteJs and declares no other global
 * (and a page's own AMD loader or `module` global is never touched).
 */
function buildClientBundle() {
  const stamp = CLIENT_SOURCES.map((f) => fs.statSync(f).mtimeMs).join(':');
  const rewriter = fs.readFileSync(CLIENT_SOURCES[0], 'utf8');
  const runtime = fs.readFileSync(CLIENT_SOURCES[1], 'utf8');
  const body = Buffer.from(
    ';(function (module, exports, define, require) {\n' + rewriter + '\n}());\n' + runtime + '\n', 'utf8');
  const version = crypto.createHash('sha1').update(body).digest('hex').slice(0, 10);
  const rv = crypto.createHash('sha1').update(version);
  for (const f of REWRITER_SOURCES) rv.update(fs.readFileSync(f));
  return {
    body, version, stamp,
    gzip: zlib.gzipSync(body, { level: 9 }),
    etag: `"${version}"`,
    // Changes whenever anything that shapes rewritten output changes; see versionEtag().
    rewriteVersion: rv.digest('hex').slice(0, 8),
  };
}

let bundle = buildClientBundle();

function clientBundle() {
  if (process.env.NODE_ENV === 'development') {
    let stamp = '';
    try { stamp = CLIENT_SOURCES.map((f) => fs.statSync(f).mtimeMs).join(':'); } catch { /* keep old */ }
    if (stamp && stamp !== bundle.stamp) {
      try { bundle = buildClientBundle(); } catch (e) { console.error('[proxy] client bundle reload failed:', e.message); }
    }
  }
  return bundle;
}

// ---- header tables -------------------------------------------------------------------------

// Request headers never forwarded upstream as-is.
const REQ_DROP = new Set([
  'host', 'cookie', 'origin', 'referer', 'connection', 'keep-alive', 'proxy-connection',
  'proxy-authorization', 'te', 'trailer', 'upgrade', 'accept-encoding', 'forwarded', 'via',
  'x-real-ip', 'true-client-ip', 'x-client-ip', 'x-cluster-client-ip', 'fastly-client-ip',
  'x-varnish', 'surrogate-capability', 'authorization-proxy', 'service-worker', 'transfer-encoding',
  'expect', 'http2-settings',
]);

// Response headers never sent back to the browser.
const RES_DROP = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'strict-transport-security', 'public-key-pins', 'public-key-pins-report-only', 'expect-ct',
  'set-cookie', 'set-cookie2', 'alt-svc', 'report-to', 'reporting-endpoints', 'nel',
  'cross-origin-embedder-policy', 'cross-origin-embedder-policy-report-only',
  'cross-origin-opener-policy', 'cross-origin-opener-policy-report-only', 'cross-origin-resource-policy',
  'clear-site-data', 'referrer-policy', 'connection', 'keep-alive', 'transfer-encoding',
  'proxy-authenticate', 'proxy-connection', 'trailer', 'upgrade', 'origin-agent-cluster', 'service-worker-allowed',
  'x-xss-protection', 'permissions-policy', 'feature-policy', 'document-policy', 'timing-allow-origin',
  'speculation-rules', 'x-proxied-url',
  // Proxied responses are only ever consumed by pages on the proxy's own origin; CORS is
  // decided here (see corsCheck), and other real origins must not be able to read through us.
  'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods',
  'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age',
  'access-control-allow-private-network',
]);

// Representation metadata that no longer describes a rewritten body.
const REWRITE_DROP = new Set(['content-length', 'content-encoding', 'content-md5', 'digest', 'content-digest', 'repr-digest', 'etag']);

// ---------------------------------------------------------------------------------------

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

const parseList = (v) => String(v == null ? '' : v).split(',').map((s) => s.trim()).filter(Boolean);

function publicOrigin(req) {
  const proto = config.trustProxy && req.headers['x-forwarded-proto']
    ? String(req.headers['x-forwarded-proto']).split(',')[0].trim()
    : (req.socket.encrypted ? 'https' : 'http');
  const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host || `localhost:${config.port}`;
  return proto + '://' + String(host).split(',')[0].trim();
}

/** host[:port] the browser used to reach the proxy, or null if the request names a bogus one. */
function selfHost(req) {
  try { return new URL(publicOrigin(req)).host; } catch { return null; }
}

function isSecureRequest(req) {
  return publicOrigin(req).startsWith('https:');
}

function sessionFor(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  let id = cookies[SESSION_COOKIE];
  if (!id || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) {
    id = SessionStore.newId();
    if (res) {
      res._newCookies = res._newCookies || [];
      res._newCookies.push(`${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000` + (isSecureRequest(req) ? '; Secure' : ''));
    }
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

/** Make a value we reflect into a response header unable to break the header block. */
function headerSafe(v) {
  return String(v).replace(/[^\t\x20-\x7e\x80-\xff]/g, (c) => (c === '\r' || c === '\n' || c === '\0' ? '' : encodeURIComponent(c)));
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, withNewCookies(res, { 'content-length': buf.length, ...headers }));
  res.end(res.req && res.req.method === 'HEAD' ? undefined : buf);
}

function sendText(res, status, text, extra = {}) {
  send(res, status, text, {
    'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...extra,
  });
}

function sendError(res, status, title, detail, targetUrl) {
  send(res, status, pages.errorPage(status, title, detail, targetUrl), {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
}

function redirect(res, location, status = 302) {
  send(res, status, '', { location: headerSafe(location), 'cache-control': 'no-store' });
}

const ERROR_TITLES = {
  ENOTFOUND: 'Site not found', EAI_AGAIN: 'DNS lookup failed', ECONNREFUSED: 'Connection refused',
  ECONNRESET: 'Connection reset', ETIMEDOUT: 'Timed out', EBLOCKED: 'Request blocked', EPROXY: 'Upstream proxy error',
  EHOSTUNREACH: 'Host unreachable', ENETUNREACH: 'Network unreachable', EPIPE: 'Connection reset',
  CERT_HAS_EXPIRED: 'Certificate expired', DEPTH_ZERO_SELF_SIGNED_CERT: 'Untrusted certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'Untrusted certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Untrusted certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'Certificate mismatch',
};

function sendUpstreamError(res, err, target) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  const status = err.code === 'EBLOCKED' ? 403 : err.code === 'ETIMEDOUT' ? 504 : 502;
  const title = ERROR_TITLES[err.code] || (/^HPE_/.test(err.code || '') ? 'Bad response from site' : 'Could not load page');
  if (config.logRequests) console.error('[proxy] upstream error', target.href, err.code, err.message);
  sendError(res, status, title, `${err.message}${err.code ? ' (' + err.code + ')' : ''}`, target.href);
}

function timeoutError(what) {
  return Object.assign(new Error(`The site took too long to ${what}.`), { code: 'ETIMEDOUT' });
}

/**
 * Wrap an event callback that writes to `res`: it runs outside handle()'s try/catch, so anything
 * it throws must end this response instead of the whole process.
 */
function guarded(res, fn) {
  return (...args) => {
    try {
      const out = fn(...args);
      if (out && typeof out.catch === 'function') out.catch((e) => failInternal(res, e));
      return out;
    } catch (e) {
      failInternal(res, e);
    }
  };
}

function failInternal(res, e) {
  console.error('[proxy] internal error', e);
  if (!res.headersSent && !res.destroyed) sendError(res, 500, 'Internal error', e.message);
  else res.destroy();
}

// ---- authentication -------------------------------------------------------------------

function sameSecret(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Whether an Authorization header carries the proxy's own BASIC_AUTH credentials. */
function isProxyAuth(value) {
  if (!config.basicAuth || !value) return false;
  const m = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(String(value));
  return Boolean(m) && sameSecret(Buffer.from(m[1], 'base64').toString('utf8'), config.basicAuth);
}

function authorized(req) {
  return !config.basicAuth || isProxyAuth(req.headers.authorization);
}

function checkAuth(req, res) {
  if (authorized(req)) return true;
  sendText(res, 401, 'Authentication required', { 'www-authenticate': 'Basic realm="proxy", charset="UTF-8"' });
  return false;
}

// ---- who is asking: initiator, site context, CORS --------------------------------------
//
// Residual limitation: every proxied site runs on the proxy's single browser origin. The browser
// therefore sees all of them as same-origin and enforces nothing between them; a hostile page can
// still script a same-origin iframe or popup of another proxied site, and requests that carry no
// Referer cannot be attributed to a page. What the server can do is re-apply the browser's rules
// to every request it can attribute (via the Referer, which stays complete because proxied pages
// get `Referrer-Policy: same-origin`, and the Sec-Fetch-* metadata): SameSite cookie restrictions
// and CORS for cross-origin fetch/XHR. That keeps honest sites behaving as they do natively and
// stops a page from reading another site's credentialed data with a plain fetch().

/** Real URL of the page that issued this request, recovered from the Referer. */
function refererTarget(req) {
  const ref = req.headers.referer;
  if (!ref) return null;
  try {
    const r = new URL(ref);
    if (r.host !== selfHost(req)) return null;
    return decodeTarget(r.pathname + r.search);
  } catch {
    return null;
  }
}

const NAV_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object', 'fencedframe']);

/**
 * @returns {{initiator: URL|null, foreign: boolean, sameOrigin: boolean, sameSite: boolean,
 *   mode: string, dest: string, topLevel: boolean, cookieContext: string}}
 */
function requestContext(req, target) {
  const h = req.headers;
  const fetchSite = String(h['sec-fetch-site'] || '').toLowerCase();
  const mode = String(h['sec-fetch-mode'] || '').toLowerCase();
  const dest = String(h['sec-fetch-dest'] || '').toLowerCase();
  // The browser labels requests coming from pages outside the proxy as cross-site/same-site.
  const foreign = fetchSite === 'cross-site' || fetchSite === 'same-site';
  const initiator = foreign ? null : refererTarget(req);
  const sameOrigin = Boolean(initiator) && initiator.origin === target.origin;
  // Without a Referer the request was typed, bookmarked or opened from the home page.
  const sameSite = !foreign && (!initiator || siteOf(initiator) === siteOf(target));
  const topLevel = mode ? mode === 'navigate' && (!dest || dest === 'document') : (!dest || dest === 'document');
  const cookieContext = !config.emulateSameSite || sameSite ? 'same-site' : topLevel ? 'top-nav' : 'cross-site';
  return { initiator, foreign, sameOrigin, sameSite, mode, dest, topLevel, cookieContext };
}

/** CORS emulation applies to cross-origin fetch()/XHR/EventSource requests. */
function corsContext(req, ctx) {
  if (!config.emulateCors || ctx.mode !== 'cors' || !ctx.initiator || ctx.sameOrigin) return null;
  // Fonts, module scripts and crossorigin media also use CORS mode, but they are loaded by the
  // page's markup and their initiator (often a stylesheet) is not the document; leave them be.
  if (ctx.dest && ctx.dest !== 'empty') return null;
  // The runtime may tell us the credentials mode; without it we cannot know whether the page
  // asked for cookies, so cookies follow SameSite and only the origin check applies.
  const cred = String(req.headers['x-proxy-credentials'] || '').toLowerCase();
  const credentials = cred === 'include' ? 'include' : cred === 'omit' || cred === 'same-origin' ? 'omit' : 'unknown';
  return { origin: ctx.initiator.origin, credentials };
}

function credentialsAllowed(req, cors) {
  if (String(req.headers['x-proxy-credentials'] || '').toLowerCase() === 'omit') return false;
  return !(cors && cors.credentials === 'omit');
}

const CORS_SAFE_METHODS = new Set(['GET', 'HEAD', 'POST']);
// Headers the browser or a front end adds by itself. Page scripts cannot set them, so they never
// make a request "non-simple". Conditionals are among them because the HTTP cache adds them
// when it revalidates, below the CORS layer.
const UA_HEADERS = new Set([
  'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range',
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent',
  'priority', 'pragma', 'cache-control', 'upgrade-insecure-requests', 'purpose', 'save-data',
  'device-memory', 'dpr', 'viewport-width', 'width', 'rtt', 'downlink', 'ect', 'forwarded', 'x-real-ip',
  'true-client-ip', 'x-client-ip', 'x-cluster-client-ip', 'x-varnish', 'x-request-id', 'x-correlation-id',
  'cdn-loop', 'traceparent', 'tracestate', 'x-cloud-trace-context', 'http2-settings',
]);
const UA_HEADER_PREFIX = /^(?:sec-|proxy-|x-forwarded-|x-proxy-|cf-|x-amzn-|x-amz-cf-|cloudfront-|fastly-|akamai-|x-azure-|x-arr-|x-envoy-|x-vercel-|x-b3-)/;
const CORS_UNSAFE_BYTE = /[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/;

function isSafelistedRequestHeader(name, value) {
  if (value.length > 128) return false;
  switch (name) {
    case 'accept': return !CORS_UNSAFE_BYTE.test(value);
    case 'accept-language':
    case 'content-language': return /^[0-9A-Za-z *,\-.;=]*$/.test(value);
    case 'content-type': {
      if (CORS_UNSAFE_BYTE.test(value)) return false;
      const essence = value.split(';')[0].trim().toLowerCase();
      return essence === 'application/x-www-form-urlencoded' || essence === 'multipart/form-data' || essence === 'text/plain';
    }
    case 'range': return /^bytes=\d+-\d*$/.test(value);
    default: return false;
  }
}

/** Author-set request headers that are not CORS-safelisted, sorted and lower-cased. */
function corsUnsafeHeaders(req) {
  const unsafe = [];
  const safelisted = [];
  let safelistedBytes = 0;
  for (const [k, v] of Object.entries(req.headers)) {
    if (UA_HEADERS.has(k) || UA_HEADER_PREFIX.test(k)) continue;
    if (k === 'authorization' && isProxyAuth(v)) continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v);
    if (isSafelistedRequestHeader(k, value)) { safelisted.push(k); safelistedBytes += value.length; } else unsafe.push(k);
  }
  if (safelistedBytes > 1024) unsafe.push(...safelisted);
  return [...new Set(unsafe)].sort();
}

/** Fetch standard "CORS check". Returns a failure reason, or null when the response may be read. */
function corsCheck(headers, cors) {
  const acao = headers['access-control-allow-origin'];
  if (acao === undefined) return `No 'Access-Control-Allow-Origin' header is present (request origin ${cors.origin})`;
  const value = String(acao).trim();
  if (value.includes(',')) return `'Access-Control-Allow-Origin' contains multiple values '${value}'`;
  const credentialed = cors.credentials === 'include';
  if (value === '*' && !credentialed) return null;
  if (value !== cors.origin) {
    return value === '*'
      ? "'Access-Control-Allow-Origin' is '*' but the request includes credentials"
      : `'Access-Control-Allow-Origin' is '${value}', not ${cors.origin}`;
  }
  if (!credentialed) return null;
  if (String(headers['access-control-allow-credentials'] || '').trim() !== 'true') {
    return "'Access-Control-Allow-Credentials' must be 'true' for a request with credentials";
  }
  return null;
}

function preflightAllows(entry, method, unsafe, cors) {
  const wildcard = cors.credentials !== 'include';
  const methods = entry.methods.map((m) => m.toUpperCase());
  if (!CORS_SAFE_METHODS.has(method) && !methods.includes(method) && !(wildcard && methods.includes('*'))) {
    return `Method ${method} is not allowed by Access-Control-Allow-Methods in preflight response`;
  }
  for (const name of unsafe) {
    if (entry.headers.includes(name)) continue;
    if (wildcard && name !== 'authorization' && entry.headers.includes('*')) continue;
    return `Request header field ${name} is not allowed by Access-Control-Allow-Headers in preflight response`;
  }
  return null;
}

// Preflight results, keyed like the browser's CORS-preflight cache (origin, URL, credentials).
const preflightCache = new Map();
const PREFLIGHT_CACHE_MAX = 5000;

function corsFailure(reason) {
  return Object.assign(new Error(reason), { cors: true });
}

/** Emulate the browser's CORS preflight: OPTIONS to the real server without credentials. */
function runPreflight(req, target, ctx, cors, unsafe, cb) {
  const method = req.method;
  const key = cors.origin + ' ' + cors.credentials + ' ' + target.href;
  const cached = preflightCache.get(key);
  if (cached && cached.expires > Date.now() && !preflightAllows(cached, method, unsafe, cors)) return cb(null);

  const headers = { host: target.host, accept: '*/*', origin: cors.origin, 'access-control-request-method': method };
  if (unsafe.length) headers['access-control-request-headers'] = unsafe.join(',');
  for (const k of ['user-agent', 'accept-language', 'sec-fetch-dest']) if (req.headers[k]) headers[k] = req.headers[k];
  if (req.headers['sec-fetch-mode']) headers['sec-fetch-mode'] = 'cors';
  if (req.headers['sec-fetch-site']) headers['sec-fetch-site'] = fetchSiteFor(ctx);
  const referer = refererFor(ctx.initiator, target, req.headers['x-proxy-referrer-policy']);
  if (referer) headers.referer = referer;

  let up;
  try {
    up = upstream.request(target, { method: 'OPTIONS', headers });
  } catch (e) {
    return cb(e);
  }
  let done = false;
  const finish = (err) => { if (!done) { done = true; cb(err); } };
  up.setTimeout(config.upstreamTimeout, () => up.destroy(timeoutError('answer the CORS preflight')));
  up.on('error', finish);
  up.on('response', (res) => {
    res.resume();
    up.setTimeout(0);
    if (res.statusCode < 200 || res.statusCode > 299) {
      return finish(corsFailure(`Response to preflight request doesn't have HTTP ok status (${res.statusCode})`));
    }
    const fail = corsCheck(res.headers, cors);
    if (fail) return finish(corsFailure('Response to preflight request: ' + fail));
    const entry = {
      methods: parseList(res.headers['access-control-allow-methods']),
      headers: parseList(res.headers['access-control-allow-headers']).map((s) => s.toLowerCase()),
    };
    const denied = preflightAllows(entry, method, unsafe, cors);
    if (denied) return finish(corsFailure(denied));
    const maxAge = /^\d+$/.test(String(res.headers['access-control-max-age'] || '').trim())
      ? Math.min(+res.headers['access-control-max-age'], 7200) : 5;
    if (maxAge > 0) {
      if (preflightCache.size >= PREFLIGHT_CACHE_MAX) preflightCache.delete(preflightCache.keys().next().value);
      preflightCache.set(key, { ...entry, expires: Date.now() + maxAge * 1000 });
    }
    finish(null);
  });
  up.end();
}

function sendCorsError(res, reason, target) {
  if (config.logRequests) console.error('[proxy] CORS blocked', target.href, reason);
  // The page sees an error status and no upstream data; the runtime can turn this into the
  // network error a browser would raise.
  sendText(res, 403, `Blocked by CORS policy: ${reason}`, {
    'x-proxy-cors-error': headerSafe(reason).slice(0, 300),
    'x-proxied-url': target.href,
  });
}

// ---- upstream request headers --------------------------------------------------------------

function fetchSiteFor(ctx) {
  if (ctx.foreign) return 'cross-site';
  if (!ctx.initiator) return 'none';
  return ctx.sameOrigin ? 'same-origin' : ctx.sameSite ? 'same-site' : 'cross-site';
}

/**
 * The Referer a browser would send under `policy` (default strict-origin-when-cross-origin). The
 * runtime can pass a page's per-request policy as X-Proxy-Referrer-Policy: the browser itself must
 * keep sending the full proxied Referer so that requests can be attributed.
 */
function refererFor(initiator, target, policy) {
  if (!initiator) return null;
  const secure = (u) => u.protocol === 'https:' || u.protocol === 'wss:';
  const downgrade = secure(initiator) && !secure(target);
  const same = initiator.origin === target.origin;
  const full = initiator.origin + initiator.pathname + initiator.search;
  const origin = initiator.origin + '/';
  switch (String(policy || '').toLowerCase()) {
    case 'no-referrer': return null;
    case 'no-referrer-when-downgrade': return downgrade ? null : full;
    case 'origin': return origin;
    case 'origin-when-cross-origin': return same ? full : origin;
    case 'same-origin': return same ? full : null;
    case 'strict-origin': return downgrade ? null : origin;
    case 'unsafe-url': return full;
    default: return downgrade ? null : same ? full : origin;
  }
}

function buildUpstreamHeaders(req, target, jar, { ctx = requestContext(req, target), cors = null, sendCookies = true } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (REQ_DROP.has(k) || k.startsWith('cf-') || k.startsWith('x-forwarded-') || k.startsWith('x-proxy-')) continue;
    h[k] = v;
  }
  if (h.authorization && isProxyAuth(h.authorization)) delete h.authorization; // never leak the gate's password
  h.host = target.host;

  const accepted = String(req.headers['accept-encoding'] || '');
  const enc = ['gzip', 'deflate', 'br'].filter((e) => new RegExp('\\b' + e + '\\b', 'i').test(accepted));
  h['accept-encoding'] = enc.length ? enc.join(', ') : 'identity';

  if (req.headers['transfer-encoding'] !== undefined && req.headers['content-length'] === undefined) {
    h['transfer-encoding'] = 'chunked';
  }
  if (req.expectContinue && requestHasBody(req)) h.expect = '100-continue';

  const referer = refererFor(ctx.initiator, target, req.headers['x-proxy-referrer-policy']);
  if (referer) h.referer = referer;
  if (req.headers['sec-fetch-site']) h['sec-fetch-site'] = fetchSiteFor(ctx);

  if (cors) {
    h.origin = cors.origin;
  } else if (req.headers.origin !== undefined) {
    const o = String(req.headers.origin);
    if (o === 'null' || ctx.foreign) h.origin = 'null';
    else h.origin = ctx.initiator ? ctx.initiator.origin : target.origin;
  }

  if (sendCookies) {
    const cookie = jar.header(target, { context: ctx.cookieContext, method: req.method });
    if (cookie) h.cookie = cookie;
  }
  return h;
}

function requestHasBody(req) {
  return req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length']) > 0;
}

// ---- conditional requests over rewritten bodies --------------------------------------------
// A rewritten body is a different representation from the upstream one, and it changes whenever
// the rewriter does. Its validators are therefore tagged with the rewriter version:
//   "abc"  -> W/"pxs<ver>-abc"     W/"abc" -> W/"pxw<ver>-abc"     (Last-Modified only) -> W/"pxl<ver>-"
// Incoming validators are translated back. On cache revalidations (If-None-Match on GET/HEAD)
// tags from another rewriter version are dropped, so browsers never revalidate a stale rewrite
// into a 304; preconditions on writes (If-Match, If-None-Match on PUT...) always keep their tag.

const PX_ETAG = /^W\/"px([swl])([0-9a-f]{8})-(.*)"$/;

function versionEtag(etag, lastModified) {
  const v = clientBundle().rewriteVersion;
  if (etag) {
    const m = /^(W\/)?"(.*)"$/.exec(String(etag).trim());
    if (m) return `W/"px${m[1] ? 'w' : 's'}${v}-${m[2]}"`;
  }
  return lastModified ? `W/"pxl${v}-"` : null;
}

function translateConditionals(h, method) {
  const v = clientBundle().rewriteVersion;
  const state = { versioned: false, stale: false };
  for (const name of ['if-none-match', 'if-match', 'if-range']) {
    // Only touch headers that carry one of our tags (If-Range may also hold a date).
    if (h[name] === undefined || !/W\/"px[swl]/.test(String(h[name]))) continue;
    const revalidation = name === 'if-none-match' && (method === 'GET' || method === 'HEAD');
    const tags = String(h[name]).match(/(?:W\/)?"[^"]*"|\*/g) || [];
    const out = [];
    for (const t of tags) {
      const m = PX_ETAG.exec(t);
      if (!m) { out.push(t); continue; }
      if (name === 'if-range') { state.rangeOverRewrite = true; continue; }
      if (revalidation) {
        if (m[2] !== v) { state.stale = true; continue; }
        state.versioned = true;
      }
      if (m[1] === 's') out.push(`"${m[3]}"`);
      else if (m[1] === 'w') out.push(`W/"${m[3]}"`);
    }
    if (out.length) h[name] = out.join(', ');
    else delete h[name];
  }
  if (state.stale) delete h['if-modified-since'];
  // A range of a rewritten body cannot be served from the upstream bytes: fetch it whole.
  if (state.rangeOverRewrite) { delete h.range; delete h['if-range']; }
  return state;
}

// ---- response headers ----------------------------------------------------------------------

/** Header values arrive as latin1; browsers read raw UTF-8 bytes in Location as UTF-8. */
function headerToUtf8(v) {
  const s = String(v);
  if (!/[\x80-\xff]/.test(s)) return s;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(s, 'latin1')); } catch { return s; }
}

function rewriteHeaderUrl(value, base) {
  const decoded = headerToUtf8(value);
  const out = proxify(decoded, base);
  return out === decoded ? String(value) : headerSafe(out);
}

/** Refresh: "<delay>[;,] [url=]<url>" as parsed by the HTML "shared declarative refresh steps". */
function rewriteRefresh(value, base) {
  const m = /^\s*(\d*(?:\.[\d.]*)?)\s*(?:[;,]\s*)?(?:url\s*=\s*)?(["']?)(.*?)\2?\s*$/i.exec(headerToUtf8(value));
  if (!m || m[1] === '' || !m[3]) return String(value);
  return headerSafe(`${m[1] || '0'}; url=${proxify(m[3], base)}`);
}

/** Split a Link header on the commas between entries (not inside <...> or quotes). */
function splitLinkHeader(v) {
  const parts = [];
  let cur = '', inUrl = false, inQuote = false;
  for (const ch of String(v)) {
    if (inQuote) { if (ch === '"') inQuote = false; cur += ch; continue; }
    if (ch === '<') inUrl = true;
    else if (ch === '>') inUrl = false;
    else if (ch === '"' && !inUrl) inQuote = true;
    else if (ch === ',' && !inUrl) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * Keep Link preload/prefetch/modulepreload hints working by pointing them through the proxy.
 * Connection hints (preconnect, dns-prefetch) would only warm up the proxy itself and are dropped,
 * as are integrity attributes (the rewritten bytes no longer match).
 */
function rewriteLinkHeader(value, base) {
  const out = [];
  for (const entry of splitLinkHeader(headerToUtf8(value))) {
    const m = /^\s*<([^>]*)>(.*)$/s.exec(entry);
    if (!m) continue;
    const params = m[2];
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^;,\s]+))/i.exec(params);
    const rels = rel ? (rel[1] || rel[2]).toLowerCase().split(/\s+/) : [];
    if (rels.length && rels.every((r) => r === 'preconnect' || r === 'dns-prefetch' || r === 'serviceworker')) continue;
    const url = m[1].trim();
    out.push('<' + (url ? proxify(url, base) : url) + '>' + params.replace(/;\s*integrity\s*=\s*(?:"[^"]*"|[^;,]*)/gi, ''));
  }
  return out.length ? headerSafe(out.join(', ')) : null;
}

const CORS_SAFELISTED_RESPONSE = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);
// Needed by the browser itself to handle the response, whatever the page may read.
const TRANSPORT_HEADERS = new Set([
  'content-encoding', 'content-range', 'accept-ranges', 'vary', 'date', 'age', 'etag', 'location',
  'x-proxied-url', 'x-proxy-private', 'referrer-policy',
]);

function filterResponseHeaders(up, target, { rewriting = false, cors = null, versioned = false, status = 200 } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(up)) {
    if (RES_DROP.has(k) || k.startsWith('x-proxy-')) continue;
    if (rewriting && REWRITE_DROP.has(k)) continue;
    out[k] = v;
  }
  if (up.location !== undefined) out.location = rewriteHeaderUrl(up.location, target.href);
  if (up['content-location'] !== undefined) out['content-location'] = rewriteHeaderUrl(up['content-location'], target.href);
  if (up.refresh !== undefined) out.refresh = rewriteRefresh(up.refresh, target.href);
  for (const k of ['sourcemap', 'x-sourcemap']) if (up[k] !== undefined) out[k] = rewriteHeaderUrl(up[k], target.href);
  if (up.link !== undefined) {
    const link = rewriteLinkHeader([].concat(up.link).join(', '), target.href);
    if (link) out.link = link; else delete out.link;
  }
  if (rewriting) {
    const tag = versionEtag(up.etag, up['last-modified']);
    if (tag) out.etag = tag;
  } else if (versioned && status === 304 && up.etag) {
    out.etag = versionEtag(up.etag);
  }
  if (cors) {
    // A cross-origin response only exposes safelisted headers and those the server lists.
    const exposed = parseList(up['access-control-expose-headers']).map((s) => s.toLowerCase());
    const all = exposed.includes('*') && cors.credentials !== 'include';
    for (const k of Object.keys(out)) {
      if (!CORS_SAFELISTED_RESPONSE.has(k) && !TRANSPORT_HEADERS.has(k) && !all && !exposed.includes(k)) delete out[k];
    }
  }
  out['referrer-policy'] = 'same-origin';
  out['x-proxied-url'] = target.href;
  return out;
}

function addVary(headers, token) {
  const have = parseList(headers.vary).map((s) => s.toLowerCase());
  if (have.includes('*') || have.includes(token.toLowerCase())) return;
  headers.vary = headers.vary ? headers.vary + ', ' + token : token;
}

// ---- body rewriting -----------------------------------------------------------------------

const DOC_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object']);
const SCRIPT_DESTS = new Set(['script', 'worker', 'sharedworker', 'serviceworker', 'audioworklet', 'paintworklet']);

// Rewritten scripts are cached by content hash: bundles are big and shared across pages.
const scriptCache = new Map();
let scriptCacheBytes = 0;
const SCRIPT_CACHE_MAX = 96 * 1024 * 1024;
function cachedScript(text) {
  if (text.length < 4096) return rewriteScript(text);
  const key = crypto.createHash('sha1').update(text).digest('base64');
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

/** Which rewriter a response needs, or null to stream it untouched. */
function kindOf(contentType, dest, disposition) {
  // Downloads must arrive byte-for-byte, even when they happen to be HTML or JS.
  if (/^\s*attachment/i.test(String(disposition || ''))) return null;
  const ct = String(contentType || '').toLowerCase().trim();
  if (dest && SCRIPT_DESTS.has(dest)) {
    // Whatever the label, a script request gets script treatment (unless it is clearly JSON/data).
    return /json|image\/|video\/|audio\/|font\/|octet-stream|wasm/.test(ct) ? null : 'js';
  }
  if (dest === 'style') return /^text\/css/.test(ct) || !ct || /^text\/plain/.test(ct) ? 'css' : null;
  if (dest === 'manifest' || /^application\/manifest\+json/.test(ct)) return !ct || /json/.test(ct) ? 'manifest' : null;
  if (/^(text\/html|application\/xhtml\+xml)/.test(ct)) return !dest || DOC_DESTS.has(dest) || dest === 'empty' ? 'html' : null;
  if (/^text\/css/.test(ct)) return 'css';
  if (/^image\/svg\+xml/.test(ct)) return 'svg';
  if (/^(text|application)\/(x-)?(javascript|ecmascript)|^text\/jscript/.test(ct)) return 'js';
  // No Content-Type on a navigation: browsers sniff, so do we (see looksLikeHtml).
  if (!ct && (!dest || NAV_DESTS.has(dest))) return 'sniff';
  return null;
}

class UnsupportedEncoding extends Error {}

const inflateAsync = promisify(zlib.inflate);
const inflateRawAsync = promisify(zlib.inflateRaw);
const gunzipAsync = promisify(zlib.gunzip);
const brotliAsync = promisify(zlib.brotliDecompress);
const gzipAsync = promisify(zlib.gzip);

function codingsOf(header) {
  return parseList(String(header || '').toLowerCase()).filter((c) => c !== 'identity');
}

function supportedEncoding(header) {
  return codingsOf(header).every((c) => ['gzip', 'x-gzip', 'deflate', 'br'].includes(c));
}

/** Undo Content-Encoding (possibly several, applied in order). Truncated streams decode as far as they go. */
async function decodeBody(buf, header) {
  const limit = { maxOutputLength: Math.max(config.maxRewriteBytes * 8, 1 << 20) };
  for (const c of codingsOf(header).reverse()) {
    if (c === 'gzip' || c === 'x-gzip') buf = await gunzipAsync(buf, { ...limit, finishFlush: zlib.constants.Z_SYNC_FLUSH });
    else if (c === 'br') buf = await brotliAsync(buf, { ...limit, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    else if (c === 'deflate') {
      // "deflate" is meant to be zlib-wrapped, but plenty of servers send raw deflate.
      try {
        buf = await inflateAsync(buf, { ...limit, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      } catch (e) {
        if (e.code === 'ERR_BUFFER_TOO_LARGE') throw e;
        buf = await inflateRawAsync(buf, { ...limit, finishFlush: zlib.constants.Z_SYNC_FLUSH });
      }
    } else throw new UnsupportedEncoding(c);
  }
  return buf;
}

// WHATWG Encoding labels that mean UTF-8 / UTF-16; everything else is kept byte-for-byte.
const UTF8_LABELS = new Set(['utf-8', 'utf8', 'unicode-1-1-utf-8', 'unicode11utf8', 'unicode20utf8', 'x-unicode20utf8']);
const UTF16LE_LABELS = new Set(['utf-16', 'utf-16le', 'unicode', 'ucs-2', 'csunicode', 'iso-10646-ucs-2', 'unicodefeff']);

function sniffCharset(buf, contentType, kind) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { charset: 'utf-8', from: 'bom' };
  if (buf[0] === 0xfe && buf[1] === 0xff) return { charset: 'utf-16be', from: 'bom' };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { charset: 'utf-16le', from: 'bom' };
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType || '');
  if (m) return { charset: m[1].toLowerCase(), from: 'header' };
  const head = buf.toString('latin1', 0, Math.min(buf.length, 4096));
  let d = null;
  if (kind === 'css') d = /^@charset "([\w.:-]+)";/.exec(head);
  else if (kind === 'html' || kind === 'svg' || kind === 'sniff') {
    d = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head) || /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head);
  }
  return d ? { charset: d[1].toLowerCase(), from: 'document' } : { charset: null, from: null };
}

/**
 * Decode a body for rewriting. UTF-8 and UTF-16 become JS strings and go out as UTF-8; legacy
 * single/multi-byte encodings are mapped byte-for-byte through latin1 so they reach the browser
 * unchanged (form submissions and query strings keep using the page's own encoding).
 * @returns {{text: string, encoding: 'utf8'|'latin1', charset: string|null, declare: boolean}}
 */
function bytesToText(buf, contentType, kind) {
  const sniffed = sniffCharset(buf, contentType, kind);
  const cs = sniffed.charset;
  if (cs === 'utf-16be' || (cs && UTF16LE_LABELS.has(cs))) {
    try {
      const text = new TextDecoder(cs === 'utf-16be' ? 'utf-16be' : 'utf-16le').decode(buf);
      return { text, encoding: 'utf8', charset: 'utf-8', declare: true };
    } catch { /* fall through to bytes */ }
  }
  if (!cs || UTF8_LABELS.has(cs)) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      return { text, encoding: 'utf8', charset: 'utf-8', declare: true };
    } catch { /* not valid UTF-8 */ }
  }
  // Declaring the document's own charset in the header keeps it effective even if the injected
  // runtime pushes a <meta charset> out of the browser's 1024-byte prescan window.
  return { text: buf.toString('latin1'), encoding: 'latin1', charset: sniffed.from === 'document' ? cs : null, declare: sniffed.from === 'document' };
}

function looksLikeHtml(text) {
  return /^\s*<(?:!doctype\s+html|html|head|body|title|meta|script|!--|div|p\b|a\b|link|style|table|h[1-6])/i.test(text);
}

/** Point a web app manifest's URLs back through the proxy. */
function rewriteManifest(text, base) {
  let m;
  try { m = JSON.parse(text); } catch { return text; }
  if (!m || typeof m !== 'object') return text;
  const fix = (o, k) => { if (o && typeof o[k] === 'string') o[k] = proxify(o[k], base); };
  const fixAll = (list, k) => { if (Array.isArray(list)) for (const o of list) fix(o, k); };
  fix(m, 'start_url');
  fix(m, 'scope');
  fixAll(m.icons, 'src');
  fixAll(m.screenshots, 'src');
  if (Array.isArray(m.shortcuts)) for (const s of m.shortcuts) { fix(s, 'url'); fixAll(s && s.icons, 'src'); }
  fixAll(m.file_handlers, 'action');
  fixAll(m.protocol_handlers, 'url');
  if (m.share_target) fix(m.share_target, 'action');
  return JSON.stringify(m);
}

function clientConfig(target, req, cookies) {
  const cfg = {
    url: target.href,
    prefix: PREFIX,
    toolbar: config.toolbar,
    origin: publicOrigin(req),
  };
  // document.cookie's first read is answered from here instead of a synchronous request.
  if (typeof cookies === 'string') cfg.cookies = cookies;
  return cfg;
}

function injectionFor(target, req, cookies) {
  const cfg = JSON.stringify(clientConfig(target, req, cookies)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<script data-proxy-runtime>window.__PROXY_CFG=${cfg};</script><script src="/__proxy/client.js?v=${clientBundle().version}" data-proxy-runtime></script>`;
}

function acceptsGzip(req) {
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

function writeHeadWithStatus(res, status, statusMessage, headers) {
  const msg = typeof statusMessage === 'string' && /^[\t\x20-\x7e\x80-\xff]*$/.test(statusMessage) ? statusMessage : undefined;
  if (msg) res.writeHead(status, msg, withNewCookies(res, headers));
  else res.writeHead(status, withNewCookies(res, headers));
}

async function finishRewritten(req, res, status, statusMessage, headers, text, encoding) {
  let body = Buffer.from(text, encoding);
  addVary(headers, 'Accept-Encoding');
  if (body.length > 1024 && acceptsGzip(req)) {
    try {
      body = await gzipAsync(body, { level: 5 });
      headers['content-encoding'] = 'gzip';
    } catch { /* send uncompressed */ }
  }
  if (res.destroyed) return;
  headers['content-length'] = body.length;
  writeHeadWithStatus(res, status, statusMessage, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---------------------------------------------------------------------------------------

const RETRYABLE = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE', 'PUT', 'DELETE']);

function proxyRequest(req, res, target) {
  if (target.protocol === 'ws:') target.protocol = 'http:';
  if (target.protocol === 'wss:') target.protocol = 'https:';

  // A proxied URL that points back at the proxy itself: unwrap it instead of looping.
  if (target.host === selfHost(req)) {
    return redirect(res, '/' + (target.pathname + target.search).replace(/^\/+/, ''));
  }

  const { jar } = sessionFor(req, res);
  const ctx = requestContext(req, target);
  const cors = corsContext(req, ctx);
  const sendCookies = credentialsAllowed(req, cors);
  const headers = buildUpstreamHeaders(req, target, jar, { ctx, cors, sendCookies });
  const cond = translateConditionals(headers, req.method);
  const st = { jar, ctx, cors, sendCookies, headers, cond, hasBody: requestHasBody(req) };

  if (cors) {
    const unsafe = corsUnsafeHeaders(req);
    if (!CORS_SAFE_METHODS.has(req.method) || unsafe.length) {
      return runPreflight(req, target, ctx, cors, unsafe, guarded(res, (err) => {
        if (res.destroyed || res.headersSent) return;
        if (err) return err.cors ? sendCorsError(res, err.message, target) : sendUpstreamError(res, err, target);
        sendUpstream(req, res, target, st, 0);
      }));
    }
  }
  sendUpstream(req, res, target, st, 0);
}

function sendUpstream(req, res, target, st, attempt) {
  let upReq;
  try {
    upReq = upstream.request(target, { method: req.method, headers: st.headers });
  } catch (e) {
    return sendUpstreamError(res, e, target);
  }

  let responded = false;
  const onClientClose = () => { if (!res.writableFinished) upReq.destroy(); };
  res.on('close', onClientClose);

  upReq.setTimeout(config.upstreamTimeout, () => upReq.destroy(timeoutError('respond')));

  upReq.on('error', guarded(res, (err) => {
    if (responded) return; // body errors are handled by the response side
    res.removeListener('close', onClientClose);
    if (res.destroyed) return;
    // A pooled keep-alive connection the server had already closed: retry once on a fresh one.
    if (attempt === 0 && upReq.reusedSocket && !st.hasBody && RETRYABLE.has(err.code) && IDEMPOTENT.has(req.method)) {
      return sendUpstream(req, res, target, st, 1);
    }
    if (st.hasBody) { req.unpipe(upReq); req.resume(); }
    sendUpstreamError(res, err, target);
  }));

  if (req.expectContinue && st.hasBody) {
    // End-to-end 100-continue: tell the client to send its body once the origin agrees, or after
    // a second if the origin does not take part (RFC 9110 §10.1.1).
    const go = () => { clearTimeout(fallback); if (!res.headersSent && !res.destroyed) res.writeContinue(); };
    const fallback = setTimeout(go, 1000);
    upReq.on('continue', go);
    upReq.on('response', () => clearTimeout(fallback));
    upReq.on('close', () => clearTimeout(fallback));
  }

  // A protocol switch nobody asked for (WebSockets arrive through server.js's 'upgrade' path).
  upReq.on('upgrade', guarded(res, (upRes, socket) => {
    responded = true;
    socket.destroy();
    sendError(res, 502, 'Bad response from site', 'The site switched to another protocol unexpectedly.', target.href);
  }));

  upReq.on('response', guarded(res, (upRes) => {
    responded = true;
    upReq.setTimeout(0);
    handleResponse(req, res, target, st, upRes);
  }));

  if (st.hasBody) {
    // Stream the body (no buffering). A client that gives up mid-upload cancels the upstream request.
    req.pipe(upReq);
    req.on('close', () => { if (!req.complete) upReq.destroy(); });
    req.on('error', () => upReq.destroy());
    // An origin that answers without reading the whole upload: drain the rest so the client's
    // connection stays usable.
    upReq.on('close', () => { if (!req.complete) { req.unpipe(upReq); req.resume(); } });
  } else {
    upReq.end();
  }
}

function handleResponse(req, res, target, st, upRes) {
  const status = upRes.statusCode;
  const up = upRes.headers;
  const { jar, ctx, cors } = st;
  if (!(status >= 200 && status <= 999)) {
    // 1xx never ends up here (Node handles informational responses itself); anything else
    // outside the range HTTP allows cannot be relayed.
    upRes.destroy();
    return sendError(res, 502, 'Bad response from site', `The site answered with an invalid status code (${status}).`, target.href);
  }

  if (st.sendCookies) {
    const setCookies = up['set-cookie'];
    if (setCookies) for (const sc of [].concat(setCookies)) jar.set(sc, target, { context: ctx.cookieContext });
    if (up['clear-site-data'] && /"(?:cookies|\*)"/i.test(String(up['clear-site-data']))) jar.clearSite(target.hostname);
  }

  // Revalidations (304) are checked against the browser's cached copy, which already passed.
  if (cors && status !== 304) {
    const fail = corsCheck(up, cors);
    if (fail) {
      upRes.resume();
      return sendCorsError(res, fail, target);
    }
  }

  const isHead = req.method === 'HEAD';
  const noBody = isHead || status === 204 || status === 304 || (status >= 100 && status < 200);
  const dest = ctx.dest;
  // 206 is a slice of the upstream bytes and can only be passed through.
  let kind = status === 204 || status === 304 || status === 206 ? null : kindOf(up['content-type'], dest, up['content-disposition']);
  if (kind && !supportedEncoding(up['content-encoding'])) kind = null;
  const len = parseInt(up['content-length'] || '0', 10);
  if (len > config.maxRewriteBytes) kind = null;

  const isDocument = (kind === 'html' || kind === 'sniff') && DOC_DESTS.has(dest || 'document');
  const docCookies = isDocument ? jar.header(target, { includeHttpOnly: false }) : null;

  const responseHeaders = (rewriting) => {
    const h = filterResponseHeaders(up, target, { rewriting, cors, versioned: st.cond.versioned, status });
    const shared = /\bpublic\b/i.test(up['cache-control'] || '');
    if ((st.headers.cookie && !shared) || docCookies || cors) h['x-proxy-private'] = '1';
    // The CORS decision depends on the requesting page, so caches must not reuse it for another.
    if (cors) addVary(h, 'Referer');
    if (/^text\/event-stream/i.test(up['content-type'] || '')) h['x-accel-buffering'] = 'no';
    return h;
  };

  // Remember the origin of top-level documents so stray root-relative requests can be routed.
  if ((kind === 'html' || kind === 'sniff') && (!dest || dest === 'document') && status < 400) {
    res._newCookies = res._newCookies || [];
    res._newCookies.push(`${LAST_COOKIE}=${encodeURIComponent(target.origin)}; Path=/; HttpOnly; SameSite=Lax` + (isSecureRequest(req) ? '; Secure' : ''));
  }

  if (noBody) {
    const h = responseHeaders(Boolean(kind));
    writeHeadWithStatus(res, status, upRes.statusMessage, h);
    upRes.resume();
    res.end();
    return;
  }

  if (!kind) {
    const h = responseHeaders(false);
    writeHeadWithStatus(res, status, upRes.statusMessage, h);
    if (h['x-accel-buffering']) res.flushHeaders();
    pipeline(upRes, res, () => {});
    return;
  }

  bufferAndRewrite(req, res, target, st, upRes, kind, responseHeaders, docCookies);
}

function bufferAndRewrite(req, res, target, st, upRes, kind, responseHeaders, docCookies) {
  const status = upRes.statusCode;
  const up = upRes.headers;
  const chunks = [];
  let size = 0;
  let settled = false;

  const sendRaw = (body) => {
    const h = responseHeaders(false);
    h['content-length'] = body.length;
    writeHeadWithStatus(res, status, upRes.statusMessage, h);
    res.end(body);
  };

  const fail = (err) => {
    clearTimeout(idle);
    if (settled) return;
    settled = true;
    if (err.code === 'ETIMEDOUT') return sendUpstreamError(res, err, target);
    if (!res.headersSent && !res.destroyed) sendError(res, 502, 'Connection interrupted', `The site stopped sending the page: ${err.message}`, target.href);
    else res.destroy();
  };

  // Idle timeout while buffering (a stalled origin must not hold the request forever).
  let idle = null;
  const arm = () => {
    clearTimeout(idle);
    idle = setTimeout(() => upRes.destroy(timeoutError('send the page')), config.upstreamTimeout);
  };

  const onData = (c) => {
    size += c.length;
    chunks.push(c);
    if (size <= config.maxRewriteBytes) { arm(); return; }
    // Too large to rewrite: send what we have and stream the rest untouched.
    settled = true;
    clearTimeout(idle);
    upRes.removeListener('data', onData);
    const h = responseHeaders(false);
    writeHeadWithStatus(res, status, upRes.statusMessage, h);
    for (const b of chunks) res.write(b);
    chunks.length = 0;
    pipeline(upRes, res, () => {});
  };

  arm();
  upRes.on('data', onData);
  upRes.on('error', fail);
  upRes.on('close', () => {
    clearTimeout(idle);
    if (!upRes.complete) fail(Object.assign(new Error('connection closed early'), { code: 'ECONNRESET' }));
  });
  res.on('close', () => { if (!res.writableFinished) upRes.destroy(); });

  upRes.on('end', guarded(res, async () => {
    clearTimeout(idle);
    if (settled) return;
    settled = true;
    const raw = Buffer.concat(chunks);
    let buf;
    try {
      buf = await decodeBody(raw, up['content-encoding']);
    } catch (e) {
      if (res.destroyed) return;
      // Bigger than we are willing to inflate: hand the browser the encoded bytes untouched.
      if (e.code === 'ERR_BUFFER_TOO_LARGE') return sendRaw(raw);
      return sendError(res, 502, 'Bad response from site', `Could not decode ${up['content-encoding']} response: ${e.message}`, target.href);
    }
    if (res.destroyed) return;

    const decoded = bytesToText(buf, up['content-type'], kind);
    let { text } = decoded;
    let k = kind;
    if (k === 'sniff') {
      if (!looksLikeHtml(text)) return sendRaw(raw);
      k = 'html';
    }
    let out;
    const ct = String(up['content-type'] || '').toLowerCase();
    try {
      if (k === 'css') out = rewriteCss(text, target.href);
      else if (k === 'js') out = cachedScript(text);
      else if (k === 'manifest') out = rewriteManifest(text, target.href);
      else if (k === 'svg') out = rewriteHtml(text, target.href, { xml: true });
      else {
        const inject = DOC_DESTS.has(st.ctx.dest || 'document') ? injectionFor(target, req, docCookies) : null;
        out = rewriteHtml(text, target.href, { inject, xml: /xhtml/.test(ct) });
      }
    } catch (e) {
      console.error('[proxy] rewrite failed for', target.href, e);
      out = text;
    }

    const headers = responseHeaders(true);
    const defaultType = { css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', manifest: 'application/manifest+json' }[k] || 'text/html';
    const type = String(up['content-type'] || defaultType);
    if (decoded.declare && decoded.charset) {
      headers['content-type'] = /charset=/i.test(type)
        ? type.replace(/charset\s*=\s*["']?[\w.:-]+["']?/i, 'charset=' + decoded.charset)
        : type + '; charset=' + decoded.charset;
    } else {
      headers['content-type'] = type;
    }
    await finishRewritten(req, res, status, upRes.statusMessage, headers, out, decoded.encoding);
  }));
}

// ---------------------------------------------------------------------------------------

/** Normalise what the user typed into a URL, or turn it into a search. */
function normaliseInput(input, selfOrigin) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (isProxiedPath(s)) return decodeTarget(s)?.href || null;
  if (/^(https?|wss?):\/\//i.test(s)) {
    try {
      const u = new URL(s);
      // A full proxy URL pasted back in: use the site it points at.
      if (selfOrigin && u.origin === selfOrigin && isProxiedPath(u.pathname + u.search)) return decodeTarget(u.pathname + u.search)?.href || null;
      return u.href;
    } catch { /* fallthrough to search */ }
  }
  const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]{2,}([/?#]\S*)?$/.test(s) || /^localhost(:\d+)?([/?#].*)?$/i.test(s) || /^\[?[0-9a-f:.]+\]?(:\d+)?([/?#].*)?$/i.test(s) && /[.:]/.test(s);
  if (looksLikeHost && !/\s/.test(s)) {
    try { return new URL('https://' + s).href; } catch { /* search */ }
  }
  return config.searchUrl.replace('%s', encodeURIComponent(s));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Requests the browser says came from a page outside the proxy (cross-site CSRF attempts). */
function fromForeignPage(req) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}

function serveClient(req, res, url) {
  const b = clientBundle();
  const versioned = url.searchParams.get('v') === b.version;
  const headers = {
    'content-type': 'application/javascript; charset=utf-8',
    'cache-control': versioned ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    etag: b.etag,
    vary: 'Accept-Encoding',
  };
  if (parseList(req.headers['if-none-match']).includes(b.etag)) {
    res.writeHead(304, withNewCookies(res, headers));
    return res.end();
  }
  const gz = acceptsGzip(req);
  if (gz) headers['content-encoding'] = 'gzip';
  return send(res, 200, gz ? b.gzip : b.body, headers);
}

async function internalRoute(req, res, url) {
  const p = url.pathname;
  if (p === '/__proxy/client.js') return serveClient(req, res, url);
  if (p === '/__proxy/home' || p === '/__proxy/') {
    return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  }
  if (p === '/__proxy/go') {
    const target = normaliseInput(url.searchParams.get('url') || url.searchParams.get('q'), publicOrigin(req));
    if (!target) return redirect(res, '/');
    return redirect(res, PREFIX + target);
  }
  if (p === '/__proxy/cookie') {
    // document.cookie for the runtime. Only the page's own site may be read or written, never
    // HttpOnly cookies, and never on behalf of a page outside the proxy.
    if (req.method !== 'GET' && req.method !== 'POST') return sendText(res, 405, 'Method not allowed', { allow: 'GET, POST' });
    if (fromForeignPage(req)) return sendText(res, 403, 'Forbidden');
    let target;
    try { target = new URL(url.searchParams.get('url')); } catch { return sendText(res, 400, 'bad url'); }
    if (!/^(https?|wss?):$/.test(target.protocol)) return sendText(res, 400, 'bad url');
    const ref = refererTarget(req);
    if (ref && registrableDomain(ref.hostname) !== registrableDomain(target.hostname)) {
      return sendText(res, 403, 'Cookies of another site are not accessible');
    }
    const { jar } = sessionFor(req, res);
    if (req.method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendText(res, e.status || 400, e.message); }
      jar.set(body, target, { fromScript: true });
    }
    return sendText(res, 200, jar.header(target, { includeHttpOnly: false }));
  }
  if (p === '/__proxy/clear') {
    if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed', { allow: 'POST' });
    if (fromForeignPage(req)) return sendText(res, 403, 'Forbidden');
    const { id, jar } = sessionFor(req, res);
    jar.clear();
    sessions.delete(id);
    return sendText(res, 200, 'ok');
  }
  return sendError(res, 404, 'Not found', 'Unknown proxy endpoint.');
}

function health(req, res) {
  // Answered before the BASIC_AUTH gate so load balancers and the Varnish probe can reach it.
  const body = config.basicAuth ? { ok: true } : { ok: true, sessions: sessions.jars.size, uptime: process.uptime() };
  return send(res, 200, JSON.stringify(body), { 'content-type': 'application/json', 'cache-control': 'no-store' });
}

async function handle(req, res) {
  res.req = req;
  const started = Date.now();
  if (config.logRequests) res.on('finish', () => console.log(`[proxy] ${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`));
  try {
    const raw = req.url || '/';
    if (/^\/__proxy\/health(?:\?|$)/.test(raw)) return health(req, res);
    if (!checkAuth(req, res)) return;

    if (isProxiedPath(raw)) {
      const target = decodeTarget(raw);
      if (!target) return sendError(res, 400, 'Invalid address', 'That URL could not be understood.');
      // A bare origin ("/p/https://example.com") must end in "/" so relative URLs resolve correctly.
      if (/^\/p\/https?:\/\/[^/?#]+(?:[?#].*)?$/i.test(raw) && (req.method === 'GET' || req.method === 'HEAD')) {
        return redirect(res, PREFIX + target.href, 301);
      }
      return proxyRequest(req, res, target);
    }

    // Everything below answers locally; let a client waiting on 100-continue send its body.
    if (req.expectContinue) res.writeContinue();

    const url = new URL(raw, 'http://local');
    if (url.pathname.startsWith('/__proxy/')) return await internalRoute(req, res, url);

    // Root-relative request that escaped rewriting (e.g. built in JS): route it via the referring page.
    const ref = refererTarget(req);
    const fromHome = !ref && (url.pathname === '/' || url.pathname === '/index.html');
    if (fromHome) {
      if (url.searchParams.get('url') || url.searchParams.get('q')) {
        const target = normaliseInput(url.searchParams.get('url') || url.searchParams.get('q'), publicOrigin(req));
        if (target) return redirect(res, PREFIX + target);
      }
      return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
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
    return send(res, 200, pages.homePage(), { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  } catch (e) {
    console.error('[proxy] internal error', e);
    if (!res.headersSent) sendError(res, 500, 'Internal error', e.message);
    else res.destroy();
  }
}

module.exports = {
  handle, sessions, sessionFor, buildUpstreamHeaders, refererTarget, publicOrigin, selfHost, requestContext,
  normaliseInput, parseCookies, authorized, isProxyAuth, clientBundle, rewriteLinkHeader, rewriteRefresh,
  corsUnsafeHeaders, corsCheck, preflightCache, SESSION_COOKIE, LAST_COOKIE,
};
