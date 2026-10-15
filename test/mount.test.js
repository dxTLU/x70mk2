'use strict';

// The /x70 reverse-proxy mount wired into server.js: HTTP requests and WebSocket upgrades under
// /x70 are forwarded to the bridge (here a fake upstream) with the prefix stripped and passed on.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const { createServer, setMount } = require('../server');
const x70mount = require('../scripts/x70-mount');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('mount forwards /x70/* to the upstream with the prefix stripped and x-forwarded-prefix set', async () => {
  // Fake "bridge": echoes the path it saw and the forwarded-prefix header; handles ws upgrades.
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url, prefix: req.headers['x-forwarded-prefix'] || null }));
  });
  upstream.on('upgrade', (req, socket) => {
    // end() (not write()) so the socket closes after the 101 and the test can tear down cleanly;
    // upgraded sockets detach from the server, so server.close() alone would hang on them.
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `x-saw-path: ${req.url}\r\nx-saw-prefix: ${req.headers['x-forwarded-prefix'] || ''}\r\n\r\n`);
  });
  const upPort = await listen(upstream);

  setMount(x70mount.create(upPort));
  const server = createServer();
  const port = await listen(server);

  const get = (path) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, agent: false, headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } }, (r) => {
      let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d }));
    }).on('error', reject);
  });

  try {
    // /x70/health -> upstream sees /health with the prefix header
    const health = await get('/x70/health');
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { path: '/health', prefix: '/x70' });

    // /x70 (no trailing slash) -> upstream root
    assert.equal(JSON.parse((await get('/x70')).body).path, '/');
    // /x70/assets/a.png -> /assets/a.png
    assert.equal(JSON.parse((await get('/x70/assets/a.png')).body).path, '/assets/a.png');

    // A non-/x70 path is handled by the proxy itself (home page), NOT forwarded.
    const home = await get('/');
    assert.equal(home.status, 200);
    assert.match(home.body, /userx70 host server/);

    // WebSocket upgrade under /x70/ws is forwarded (prefix stripped), 101 relayed back.
    const sawPath = await new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1', () => {
        sock.write(`GET /x70/ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n` +
          'Connection: Upgrade\r\nSec-WebSocket-Key: abc\r\nSec-WebSocket-Version: 13\r\n\r\n');
      });
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          const m = /x-saw-path: (\S+)/.exec(buf);
          assert.match(buf, /101 Switching Protocols/);
          sock.destroy();
          resolve(m && m[1]);
        }
      });
      sock.on('error', reject);
      setTimeout(() => reject(new Error('ws upgrade timed out')), 4000);
    });
    assert.equal(sawPath, '/ws');
  } finally {
    setMount(null);
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
    upstream.closeAllConnections && upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
});

test('mount passes a 502 when the bridge is down', async () => {
  // Point the mount at a port nothing listens on.
  setMount(x70mount.create(1));
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/x70/health', agent: false, headers: { Host: `127.0.0.1:${port}`, Connection: 'close' } },
        (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => resolve({ status: r.statusCode, body: d })); })
        .on('error', reject);
    });
    assert.equal(res.status, 502);
    assert.match(res.body, /unreachable/);
  } finally {
    setMount(null);
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
