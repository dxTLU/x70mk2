'use strict';

// Reverse-proxy mount: exposes the x70 Scratch bridge (running on a loopback port) under the
// `/x70/` path of the main proxy, so everything lives on one origin/port. HTTP and WebSocket are
// both forwarded; the stripped prefix is passed on as `x-forwarded-prefix` so the bridge builds
// correct self-referential URLs (its extension URL, links, same-origin fetches).

const http = require('http');
const net = require('net');

const PREFIX = '/x70';

function stripPrefix(url) {
  const rest = url.slice(PREFIX.length); // '/x70/health' -> '/health', '/x70' -> ''
  return rest === '' ? '/' : rest;
}

function matches(url) {
  return url === PREFIX || url === `${PREFIX}/` || url.startsWith(`${PREFIX}/`) || url.startsWith(`${PREFIX}?`);
}

function create(bridgePort, host = '127.0.0.1') {
  const proto = (req) => req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');

  function httpForward(req, res) {
    const headers = { ...req.headers, 'x-forwarded-prefix': PREFIX, 'x-forwarded-proto': proto(req) };
    delete headers['content-length']; // let the agent recompute; body is piped
    const up = http.request(
      { host, port: bridgePort, method: req.method, path: stripPrefix(req.url), headers },
      (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on('error', (e) => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`x70 bridge unreachable: ${e.code || e.message}`);
    });
    req.pipe(up);
    req.on('aborted', () => up.destroy());
  }

  function upgradeForward(req, socket, head) {
    socket.on('error', () => socket.destroy());
    const upstream = net.connect(bridgePort, host, () => {
      const lines = [`${req.method} ${stripPrefix(req.url)} HTTP/1.1`];
      // rawHeaders is [k, v, k, v, ...]; preserve all except inject the forwarded prefix.
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
        if (req.rawHeaders[i].toLowerCase() === 'x-forwarded-prefix') continue;
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`x-forwarded-prefix: ${PREFIX}`, `x-forwarded-proto: ${proto(req)}`, '', '');
      upstream.write(lines.join('\r\n'));
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
  }

  return { prefix: PREFIX, matches, http: httpForward, upgrade: upgradeForward };
}

module.exports = { create, matches, PREFIX };
