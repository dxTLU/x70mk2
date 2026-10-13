'use strict';

// Outbound traffic through an upstream HTTP proxy (CONNECT tunnels), against a local fake proxy:
// authentication, refusals, NO_PROXY rules, HTTPS and WebSockets through the tunnel. No internet.

process.env.ALLOW_PRIVATE = '0';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy']) process.env[k] = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const crypto = require('crypto');
const { spawn } = require('child_process');
const config = require('../src/config');
const upstream = require('../src/upstream');
const { createServer } = require('../server');

// Self-signed certificate for "site.test" (EC P-256, valid until 2126), trusted by the child
// proxy through NODE_EXTRA_CA_CERTS.
const CERT = `-----BEGIN CERTIFICATE-----
MIIBlDCCATugAwIBAgIUZpwZ0zSnusWTVyO1dpi2yf2+HF8wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJc2l0ZS50ZXN0MCAXDTI2MTAxMzE4MzAxOFoYDzIxMjYwOTE5
MTgzMDE4WjAUMRIwEAYDVQQDDAlzaXRlLnRlc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAScFjipKL+Jml/Z8KQVv3UN5/jbDpN13qD/SQ7YpCD1i6aWSt5jFpx2
KxtVBAMlrnNwyV4P9a812Uc61/N85rK9o2kwZzAdBgNVHQ4EFgQUJojGN4S9hb93
djlWL5CCclL0+6UwHwYDVR0jBBgwFoAUJojGN4S9hb93djlWL5CCclL0+6UwFAYD
VR0RBA0wC4IJc2l0ZS50ZXN0MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwID
RwAwRAIgEGV47FV2OeP1RqgY+B7WURtRQbxQvR7qg2njYvRHrD8CIC30LfBItpa8
j17JAgbnNByaKVQkGjMt09cmQaeM1S9Y
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgxU1BSVv20B/Hj7dd
wI8HzU5lw+O7H4KqAd5uOdhESUChRANCAAScFjipKL+Jml/Z8KQVv3UN5/jbDpN1
3qD/SQ7YpCD1i6aWSt5jFpx2KxtVBAMlrnNwyV4P9a812Uc61/N85rK9
-----END PRIVATE KEY-----
`;

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

/** A minimal CONNECT-only forward proxy. `routes` maps "host:port" to a local address. */
function fakeProxy({ auth = null, routes = {} } = {}) {
  const log = [];
  const server = net.createServer((client) => {
    let buf = Buffer.alloc(0);
    client.on('error', () => {});
    client.on('data', function onData(d) {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      client.removeListener('data', onData);
      const [line, ...lines] = buf.subarray(0, idx).toString('latin1').split('\r\n');
      const rest = buf.subarray(idx + 4);
      const headers = {};
      for (const l of lines) headers[l.slice(0, l.indexOf(':')).trim().toLowerCase()] = l.slice(l.indexOf(':') + 1).trim();
      log.push({ line, headers });
      const m = /^CONNECT (\S+) HTTP\/1\.1$/.exec(line);
      if (!m) return client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n');
      if (auth && headers['proxy-authorization'] !== 'Basic ' + Buffer.from(auth).toString('base64')) {
        return client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="fake"\r\nContent-Length: 0\r\n\r\n');
      }
      const hp = /^\[?([^\]]+)\]?:(\d+)$/.exec(m[1]);
      const dest = routes[m[1]] || { host: hp[1], port: +hp[2] };
      const up = net.connect(dest.port, dest.host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: fake\r\n\r\n');
        if (rest.length) up.write(rest);
        up.pipe(client);
        client.pipe(up);
      });
      up.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n'));
      client.on('close', () => up.destroy());
    });
  });
  return { server, log };
}

function siteHandler(req, res) {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/page') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html><head></head><body><a href="/next">n</a><p>${req.headers.host}</p></body></html>`);
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('plain:' + req.headers.host);
}

function wsEcho(server) {
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    socket.on('error', () => {});
  });
}

function get(base, p) {
  return new Promise((resolve, reject) => {
    http.get(base + p, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

let site, proxy, proxyUrl, sitePort;

describe('upstream proxy tunnelling', () => {
  before(async () => {
    site = http.createServer(siteHandler);
    sitePort = await listen(site, '0.0.0.0');
    proxy = createServer();
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  after(() => {
    upstream.configureUpstreamProxy('', '');
    for (const s of [site, proxy]) { s.close(); s.closeAllConnections?.(); }
  });

  afterEach(() => {
    upstream.configureUpstreamProxy('', '');
    config.allowPrivate = false;
  });

  it('parses proxy URLs, including credentials and bare host:port', () => {
    const p = upstream.parseProxy('http://us%3Aer:p%40ss@proxy.example:3128');
    assert.strictEqual(p.host, 'proxy.example');
    assert.strictEqual(p.port, 3128);
    assert.strictEqual(p.auth, 'Basic ' + Buffer.from('us:er:p@ss').toString('base64'));
    assert.strictEqual(upstream.parseProxy('proxy.example:8080').port, 8080);
    assert.strictEqual(upstream.parseProxy('https://proxy.example').port, 443);
    assert.ok(upstream.parseProxy('https://proxy.example').secure);
    assert.strictEqual(upstream.parseProxy('socks5://proxy.example:1080'), null);
    assert.strictEqual(upstream.parseProxy(''), null);
  });

  it('matches NO_PROXY entries like curl and Go do', () => {
    const rules = upstream.parseNoProxy('.example.com, *.svc.cluster.local, exact.org, 10.0.0.0/8, fd00::/8, api.test:8443, [::1]');
    const by = (h, port = 443) => upstream.shouldBypass(h, port, rules);
    assert.ok(by('example.com'));
    assert.ok(by('www.example.com'));
    assert.ok(!by('notexample.com'));
    assert.ok(by('a.b.svc.cluster.local'));
    assert.ok(by('exact.org') && by('sub.exact.org'));
    assert.ok(by('10.20.30.40') && !by('11.0.0.1'));
    assert.ok(by('[fd00::1]') && !by('[fe80::1]'));
    assert.ok(by('api.test', 8443) && !by('api.test', 443));
    assert.ok(by('localhost') && by('127.0.0.5'), 'loopback never goes through the proxy');
    assert.ok(upstream.shouldBypass('anything.example', 443, upstream.parseNoProxy('*')));
    assert.ok(!upstream.shouldBypass('anything.example', 443, upstream.parseNoProxy('')));
  });

  it('tunnels plain HTTP through CONNECT with proxy authentication', async () => {
    const fake = fakeProxy({ auth: 'user:p@ss', routes: { [`site.test:${sitePort}`]: { host: '127.0.0.1', port: sitePort } } });
    const port = await listen(fake.server);
    try {
      upstream.configureUpstreamProxy(`http://user:p%40ss@127.0.0.1:${port}`, '');
      const r = await get(proxyUrl, `/p/http://site.test:${sitePort}/page`);
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes(`/p/http://site.test:${sitePort}/next`));
      assert.ok(r.body.includes(`<p>site.test:${sitePort}</p>`), 'the origin sees the real Host');
      assert.strictEqual(fake.log[0].line, `CONNECT site.test:${sitePort} HTTP/1.1`);
      assert.strictEqual(fake.log[0].headers.host, `site.test:${sitePort}`);
      assert.strictEqual(fake.log[0].headers['proxy-authorization'], 'Basic ' + Buffer.from('user:p@ss').toString('base64'));
      // Keep-alive: a second request reuses the tunnel.
      await get(proxyUrl, `/p/http://site.test:${sitePort}/other`);
      assert.strictEqual(fake.log.length, 1);
    } finally {
      fake.server.close();
    }
  });

  it('reports a proxy that refuses the credentials', async () => {
    const fake = fakeProxy({ auth: 'user:right' });
    const port = await listen(fake.server);
    try {
      upstream.configureUpstreamProxy(`http://user:wrong@127.0.0.1:${port}`, '');
      const r = await get(proxyUrl, '/p/http://site.test/');
      assert.strictEqual(r.status, 502);
      assert.match(r.body, /Upstream proxy error/);
      assert.match(r.body, /requires authentication/);
    } finally {
      fake.server.close();
    }
  });

  it('reports an unreachable proxy', async () => {
    const dead = net.createServer();
    const port = await listen(dead);
    dead.close();
    upstream.configureUpstreamProxy(`http://127.0.0.1:${port}`, '');
    const r = await get(proxyUrl, '/p/http://site.test/');
    assert.strictEqual(r.status, 502);
    assert.match(r.body, /Upstream proxy unreachable/);
  });

  it('refuses names that resolve to private addresses before tunnelling', async (t) => {
    const name = os.hostname();
    const addrs = await new Promise((resolve) => dns.lookup(name, { all: true }, (e, a) => resolve(e ? [] : a)));
    if (!addrs.length || !addrs.every((a) => upstream.isPrivateIp(a.address))) return t.skip('host name does not resolve to a private address here');
    const fake = fakeProxy();
    const port = await listen(fake.server);
    try {
      upstream.configureUpstreamProxy(`http://127.0.0.1:${port}`, '');
      const r = await get(proxyUrl, `/p/http://${name}:${sitePort}/page`);
      assert.strictEqual(r.status, 403);
      assert.strictEqual(fake.log.length, 0, 'the proxy was never asked');
    } finally {
      fake.server.close();
    }
  });

  it('connects directly to hosts listed in NO_PROXY', async (t) => {
    const ip = Object.values(os.networkInterfaces()).flat().find((a) => a && !a.internal && a.family === 'IPv4');
    if (!ip) return t.skip('no non-loopback IPv4 interface');
    config.allowPrivate = true;
    const fake = fakeProxy();
    const port = await listen(fake.server);
    try {
      const target = `/p/http://${ip.address}:${sitePort}/x`;
      upstream.configureUpstreamProxy(`http://127.0.0.1:${port}`, '');
      assert.strictEqual((await get(proxyUrl, target)).body, `plain:${ip.address}:${sitePort}`);
      assert.strictEqual(fake.log.length, 1, 'without NO_PROXY the request is tunnelled');
      for (const rule of [ip.address, `${ip.address.split('.').slice(0, 3).join('.')}.0/24`, `${ip.address}:${sitePort}`]) {
        upstream.configureUpstreamProxy(`http://127.0.0.1:${port}`, `other.example,${rule}`);
        assert.strictEqual((await get(proxyUrl, target)).body, `plain:${ip.address}:${sitePort}`, rule);
        assert.strictEqual(fake.log.length, 1, `${rule} bypasses the proxy`);
      }
      upstream.configureUpstreamProxy(`http://127.0.0.1:${port}`, `${ip.address}:1`);
      await get(proxyUrl, target);
      assert.strictEqual(fake.log.length, 2, 'a NO_PROXY entry for another port does not apply');
    } finally {
      fake.server.close();
    }
  });

  it('tunnels HTTPS and secure WebSockets, verifying the origin certificate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-tunnel-'));
    const caFile = path.join(dir, 'ca.pem');
    fs.writeFileSync(caFile, CERT);
    const secure = https.createServer({ cert: CERT, key: KEY }, siteHandler);
    wsEcho(secure);
    const securePort = await listen(secure);
    const local = { host: '127.0.0.1', port: securePort };
    const fake = fakeProxy({ auth: 'u:p', routes: { [`site.test:${securePort}`]: local, [`other.test:${securePort}`]: local } });
    const fakePort = await listen(fake.server);
    const env = {
      ...process.env, NODE_EXTRA_CA_CERTS: caFile, UPSTREAM_PROXY: `http://u:p@127.0.0.1:${fakePort}`,
      PORT: '0', HOST: '127.0.0.1', ALLOW_PRIVATE: '0', PERSIST_SESSIONS: '0', NO_PROXY: '', no_proxy: '',
    };
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const base = await new Promise((resolve, reject) => {
        let out = '';
        child.stdout.on('data', (d) => {
          out += d;
          const m = /listening on (http:\/\/[^/\s]+)/.exec(out);
          if (m) resolve(m[1].replace('localhost', '127.0.0.1'));
        });
        child.on('exit', (code) => reject(new Error('proxy exited ' + code + ': ' + out)));
        setTimeout(() => reject(new Error('proxy did not start: ' + out)), 8000).unref();
      });
      const r = await get(base, `/p/https://site.test:${securePort}/page`);
      assert.strictEqual(r.status, 200, r.body);
      assert.ok(r.body.includes(`/p/https://site.test:${securePort}/next`));
      assert.strictEqual(fake.log[0].line, `CONNECT site.test:${securePort} HTTP/1.1`);

      const port = new URL(base).port;
      const echoed = await new Promise((resolve, reject) => {
        const s = net.connect(+port, '127.0.0.1', () => {
          s.write(`GET /p/wss://site.test:${securePort}/sock HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
        });
        let buf = '';
        let sent = false;
        s.on('data', (d) => {
          buf += d;
          if (!sent && buf.includes('\r\n\r\n')) { sent = true; s.write('ping'); }
          if (buf.includes('echo:ping')) { s.destroy(); resolve(buf); }
        });
        s.on('error', reject);
        setTimeout(() => reject(new Error('no echo: ' + buf)), 4000).unref();
      });
      assert.match(echoed, /^HTTP\/1\.1 101/);

      // TLS is verified end to end through the tunnel: a certificate for another name is refused.
      const bad = await get(base, `/p/https://other.test:${securePort}/page`);
      assert.strictEqual(bad.status, 502);
      assert.match(bad.body, /Certificate mismatch/);
    } finally {
      child.kill('SIGTERM');
      fake.server.close();
      secure.close();
      secure.closeAllConnections?.();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
