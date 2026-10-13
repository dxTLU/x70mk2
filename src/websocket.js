'use strict';

const upstream = require('./upstream');
const { decodeTarget, isProxiedPath } = require('./urls');
const proxy = require('./proxy');

const FORWARD = [
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
  'user-agent', 'accept-language', 'pragma', 'cache-control',
];

function reject(socket, status, msg) {
  if (!socket.writable) return socket.destroy();
  socket.end(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(msg)}\r\n\r\n${msg}`);
}

/** Tunnel a WebSocket upgrade at /p/wss://host/path to the real server. */
function handleUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  if (!isProxiedPath(req.url) || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    return reject(socket, 400, 'Bad Request');
  }
  const target = decodeTarget(req.url);
  if (!target) return reject(socket, 400, 'Bad Request');
  if (target.protocol === 'http:') target.protocol = 'ws:';
  if (target.protocol === 'https:') target.protocol = 'wss:';

  const fakeRes = { _newCookies: null };
  const { jar } = proxy.sessionFor(req, fakeRes);

  const headers = { host: target.host, connection: 'Upgrade', upgrade: 'websocket' };
  for (const k of FORWARD) if (req.headers[k]) headers[k] = req.headers[k];
  const ref = proxy.refererTarget(req);
  headers.origin = ref ? ref.origin : (target.protocol === 'wss:' ? 'https://' : 'http://') + target.host;
  const cookie = jar.header(target);
  if (cookie) headers.cookie = cookie;

  let upReq;
  try {
    upReq = upstream.request(target, { method: 'GET', headers, upgrade: true });
  } catch (e) {
    return reject(socket, 403, e.message);
  }
  upReq.setTimeout(30000, () => upReq.destroy(new Error('timeout')));

  upReq.on('upgrade', (upRes, upSocket, upHead) => {
    upReq.setTimeout(0);
    const setCookies = upRes.headers['set-cookie'];
    if (setCookies) for (const sc of [].concat(setCookies)) jar.set(sc, target);
    let resp = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n';
    for (const k of ['sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions']) {
      if (upRes.headers[k]) resp += `${k}: ${upRes.headers[k]}\r\n`;
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
    // WebSockets have no use for half-open TCP: once either side finishes, let the pipe flush
    // the final bytes, then tear both down.
    const ended = () => setTimeout(close, 1000).unref();
    upSocket.on('end', ended);
    socket.on('end', ended);
  });

  upReq.on('response', (upRes) => {
    // Server refused to upgrade: relay its status.
    upRes.resume();
    reject(socket, upRes.statusCode, upRes.statusMessage || 'Upgrade refused');
  });

  upReq.on('error', (err) => reject(socket, 502, 'WebSocket upstream error: ' + err.message));
  upReq.end();
}

module.exports = { handleUpgrade };
