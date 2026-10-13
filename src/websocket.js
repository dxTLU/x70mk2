'use strict';

const config = require('./config');
const upstream = require('./upstream');
const { decodeTarget, isProxiedPath } = require('./urls');
const { siteOf } = require('./cookies');
const proxy = require('./proxy');

// Handshake headers worth passing on. Subprotocols and extensions (permessage-deflate) are
// negotiated end to end: the frames are relayed untouched, so whatever the two ends agree on works.
const FORWARD = [
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
  'user-agent', 'accept-language', 'pragma', 'cache-control',
];
const RELAY_BACK = ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'];

const STATUS_TEXT = require('http').STATUS_CODES;

function sendResponse(socket, status, body, headers) {
  if (!socket.writable) return socket.destroy();
  let head = `HTTP/1.1 ${status} ${(STATUS_TEXT[status] || 'Error').replace(/[^\x20-\x7e]/g, '')}\r\nConnection: close\r\n`;
  for (const [k, v] of Object.entries(headers)) head += `${k}: ${String(v).replace(/[\r\n]/g, '')}\r\n`;
  socket.end(Buffer.concat([Buffer.from(head + `Content-Length: ${body.length}\r\n\r\n`, 'latin1'), body]));
}

function reject(socket, status, msg, headers = {}) {
  sendResponse(socket, status, Buffer.from(String(msg)), {
    'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...headers,
  });
}

/** Where a stray (non-/p/) WebSocket URL was meant to go: the last site the user browsed. */
function strayTarget(req) {
  const last = proxy.parseCookies(req.headers.cookie)[proxy.LAST_COOKIE];
  if (!last) return null;
  try {
    const origin = new URL(decodeURIComponent(last));
    return new URL(req.url, origin.origin.replace(/^http/, 'ws'));
  } catch {
    return null;
  }
}

/**
 * The page a WebSocket was opened from. Handshakes carry no Referer in most browsers, so fall back
 * to the last top-level site when it is the same site as the socket's host (the common
 * www.example.com -> ws.example.com case); otherwise the socket's own origin is the best guess.
 */
function initiatorOrigin(req, target) {
  const ref = proxy.refererTarget(req);
  if (ref) return ref.origin;
  const last = proxy.parseCookies(req.headers.cookie)[proxy.LAST_COOKIE];
  if (last) {
    try {
      const u = new URL(decodeURIComponent(last));
      if (siteOf(u) === siteOf(target)) return u.origin;
    } catch { /* ignore */ }
  }
  return (target.protocol === 'wss:' ? 'https://' : 'http://') + target.host;
}

/** Tunnel a WebSocket upgrade at /p/wss://host/path to the real server. */
function handleUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return reject(socket, 400, 'Bad Request');
  if (!proxy.authorized(req)) {
    return reject(socket, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="proxy", charset="UTF-8"' });
  }
  // Cross-site WebSocket hijacking: a page on another site opening sockets through the proxy.
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let host = null;
    try { host = new URL(origin).host; } catch { /* malformed */ }
    if (host !== new URL(proxy.publicOrigin(req)).host) return reject(socket, 403, 'Cross-site WebSocket refused');
  }

  const target = isProxiedPath(req.url) ? decodeTarget(req.url) : strayTarget(req);
  if (!target) return reject(socket, 400, 'Bad Request');
  if (target.protocol === 'http:') target.protocol = 'ws:';
  if (target.protocol === 'https:') target.protocol = 'wss:';

  const hasSession = proxy.SESSION_COOKIE in proxy.parseCookies(req.headers.cookie);
  const { jar } = hasSession ? proxy.sessionFor(req, null) : { jar: null };

  const headers = { host: target.host, connection: 'Upgrade', upgrade: 'websocket' };
  for (const k of FORWARD) if (req.headers[k]) headers[k] = req.headers[k];
  headers.origin = initiatorOrigin(req, target);
  if (jar) {
    // A socket is a subresource of the page that opens it: cross-site ones only get SameSite=None.
    const sameSite = !config.emulateSameSite || siteOf(headers.origin) === siteOf(target);
    const cookie = jar.header(target, { context: sameSite ? 'same-site' : 'cross-site' });
    if (cookie) headers.cookie = cookie;
  }

  let upReq;
  try {
    upReq = upstream.request(target, { method: 'GET', headers, upgrade: true });
  } catch (e) {
    return reject(socket, e.code === 'EBLOCKED' ? 403 : 400, e.message);
  }
  let settled = false;
  const abort = () => { if (!settled) { settled = true; upReq.destroy(); } };
  socket.once('close', abort);
  upReq.setTimeout(config.upstreamTimeout, () => upReq.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    settled = true;
    socket.removeListener('close', abort);
    upReq.setTimeout(0);
    const setCookies = upRes.headers['set-cookie'];
    if (jar && setCookies) for (const sc of [].concat(setCookies)) jar.set(sc, target);
    if (!socket.writable) { upSocket.destroy(); return; }

    let resp = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n';
    for (const k of RELAY_BACK) {
      if (upRes.headers[k] !== undefined) resp += `${k}: ${String(upRes.headers[k]).replace(/[\r\n]/g, '')}\r\n`;
    }
    socket.write(resp + '\r\n');
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    upSocket.setNoDelay(true);
    socket.setNoDelay?.(true);
    upSocket.setTimeout(0);
    socket.setTimeout(0);
    upSocket.pipe(socket);
    socket.pipe(upSocket);

    const close = () => { socket.destroy(); upSocket.destroy(); };
    upSocket.on('error', close);
    socket.on('error', close);
    upSocket.on('close', close);
    socket.on('close', close);
    // WebSockets have no use for half-open TCP: once either side finishes, pipe() forwards the
    // FIN, and both are torn down after a short grace period for the closing handshake.
    const ended = () => setTimeout(close, 1000).unref();
    upSocket.once('end', ended);
    socket.once('end', ended);
  });

  upReq.on('response', (upRes) => {
    // The server refused to upgrade: relay its answer (status, type and a bounded body).
    settled = true;
    socket.removeListener('close', abort);
    upReq.setTimeout(0);
    const setCookies = upRes.headers['set-cookie'];
    if (jar && setCookies) for (const sc of [].concat(setCookies)) jar.set(sc, target);
    const chunks = [];
    let size = 0;
    const done = () => {
      const h = { 'Content-Type': upRes.headers['content-type'] || 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' };
      sendResponse(socket, upRes.statusCode, Buffer.concat(chunks), h);
    };
    upRes.on('data', (c) => {
      if (size < 65536) chunks.push(c.subarray(0, 65536 - size));
      size += c.length;
    });
    upRes.on('end', done);
    upRes.on('error', done);
  });

  upReq.on('error', (err) => {
    if (settled) return;
    settled = true;
    const status = err.code === 'EBLOCKED' ? 403 : err.code === 'ETIMEDOUT' ? 504 : 502;
    reject(socket, status, 'WebSocket upstream error: ' + err.message);
  });
  upReq.end();
}

module.exports = { handleUpgrade };
