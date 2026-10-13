'use strict';

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
process.env.UPSTREAM_PROXY = '';
process.env.HTTPS_PROXY = '';
process.env.HTTP_PROXY = '';
process.env.https_proxy = '';
process.env.http_proxy = '';

const { describe, it: test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { createServer } = require('../server');

let site, proxy, siteUrl, proxyUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('proxy', () => {
before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'", 'x-frame-options': 'DENY' });
      res.end(`<!doctype html><html><head><title>Home</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<link rel="stylesheet" href="/style.css" integrity="sha384-abc">
<style>body{background:url('/bg.png')}</style>
<script>if (location.pathname !== '/') console.log(location.href);</script>
</head><body>
<a id="rel" href="page2.html?a=1&amp;b=2">rel</a>
<a id="abs" href="https://other.example/x">abs</a>
<a id="frag" href="#top">frag</a>
<a id="js" href="javascript:void(location.href='/x')">js</a>
<img srcset="/a.png 1x, /b.png 2x" src="/a.png" onclick="location.href='/c'">
<form action="/submit" method="post"><input name="q"></form>
<div style="background-image:url(&quot;/d.png&quot;)"></div>
<iframe srcdoc="<a href='/inner'>i</a>"></iframe>
<p>Ünïcödé ✓</p>
</body></html>`);
    } else if (u.pathname === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end('@import "other.css"; .x{background:url(img/x.png)} .y{background:url("data:image/png;base64,AA==")}');
    } else if (u.pathname === '/gz') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(zlib.gzipSync('<html><head></head><body><a href="/zipped">z</a></body></html>'));
    } else if (u.pathname === '/br') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'br' });
      res.end(zlib.brotliCompressSync('<a href="/brotli">b</a>'));
    } else if (u.pathname === '/redirect') {
      res.writeHead(302, { location: '/landing' });
      res.end();
    } else if (u.pathname === '/redirect-abs') {
      res.writeHead(301, { location: 'https://elsewhere.example/path' });
      res.end();
    } else if (u.pathname === '/set-cookie') {
      res.writeHead(200, { 'set-cookie': ['sid=abc123; Path=/; HttpOnly', 'pref=dark; Path=/; Max-Age=3600'], 'content-type': 'text/plain' });
      res.end('ok');
    } else if (u.pathname === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString(), url: req.url }));
      });
    } else if (u.pathname === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end('"use strict";\nvar p = window.location.pathname; var o = {location: 1}; var s = "location";');
    } else if (u.pathname === '/binary') {
      const buf = crypto.randomBytes(256 * 1024);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length, etag: '"bin"' });
      res.end(buf);
    } else if (u.pathname === '/range') {
      const data = Buffer.from('0123456789');
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (m) {
        res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': `bytes ${m[1]}-${m[2]}/10`, 'accept-ranges': 'bytes' });
        res.end(data.subarray(+m[1], +m[2] + 1));
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(data);
      }
    } else if (u.pathname === '/latin1') {
      res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
      res.end(Buffer.concat([Buffer.from('<p>caf'), Buffer.from([0xe9]), Buffer.from('</p><a href="/l">l</a>')]));
    } else {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found: ' + u.pathname);
    }
  });
  site.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
  });
  const sitePort = await listen(site);
  siteUrl = `http://127.0.0.1:${sitePort}`;
  proxy = createServer();
  const proxyPort = await listen(proxy);
  proxyUrl = `http://127.0.0.1:${proxyPort}`;
});

after(() => {
  site.close();
  proxy.close();
  site.closeAllConnections?.();
  proxy.closeAllConnections?.();
});

test('home page is served', async () => {
  const r = await request('/');
  assert.strictEqual(r.status, 200);
  assert.match(r.body, /Web Proxy/);
});

test('HTML is rewritten', async () => {
  const r = await request(`/p/${siteUrl}/`, { headers: { 'accept-encoding': 'gzip' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['content-security-policy'], undefined);
  assert.strictEqual(r.headers['x-frame-options'], undefined);
  const b = r.body;
  assert.match(b, /<script data-proxy-runtime>window.__PROXY_CFG=/);
  assert.ok(b.indexOf('data-proxy-runtime') < b.indexOf('<title>'), 'runtime injected first in head');
  assert.doesNotMatch(b, /Content-Security-Policy/i);
  assert.ok(b.includes(`href="/p/${siteUrl}/style.css"`));
  assert.doesNotMatch(b, /integrity=/);
  assert.ok(b.includes(`url("/p/${siteUrl}/bg.png")`));
  assert.ok(b.includes(`href="/p/${siteUrl}/page2.html?a=1&amp;b=2"`));
  assert.ok(b.includes('href="/p/https://other.example/x"'));
  assert.ok(b.includes('href="#top"'));
  assert.ok(b.includes(`srcset="/p/${siteUrl}/a.png 1x, /p/${siteUrl}/b.png 2x"`));
  assert.ok(b.includes(`action="/p/${siteUrl}/submit"`));
  assert.ok(b.includes(`url(&quot;/p/${siteUrl}/d.png&quot;)`));
  assert.ok(b.includes("onclick=\"__pLocation.href='/c'\""));
  assert.ok(b.includes("javascript:void(__pLocation.href='/x')"));
  assert.ok(b.includes("if (__pLocation.pathname !== '/') console.log(__pLocation.href);"));
  assert.match(b, /srcdoc="[^"]*\/p\/http:\/\/127\.0\.0\.1:\d+\/inner/);
  assert.ok(b.includes('Ünïcödé ✓'));
  assert.match(r.headers['set-cookie'].join(';'), /__psid=/);
});

test('CSS is rewritten', async () => {
  const r = await request(`/p/${siteUrl}/style.css`);
  assert.ok(r.body.includes(`@import "/p/${siteUrl}/other.css"`));
  assert.ok(r.body.includes(`url("/p/${siteUrl}/img/x.png")`));
  assert.ok(r.body.includes('url("data:image/png;base64,AA==")'));
});

test('JavaScript location references are rewritten', async () => {
  const r = await request(`/p/${siteUrl}/app.js`);
  assert.match(r.body, /^"use strict";if\(!Object\.prototype/);
  assert.ok(r.body.includes('window.__pLocation.pathname'));
  assert.ok(r.body.includes('{location: 1}'));
  assert.ok(r.body.includes('"location"'));
});

test('gzip and brotli upstream bodies are decoded and rewritten', async () => {
  const g = await request(`/p/${siteUrl}/gz`);
  assert.ok(g.body.includes(`href="/p/${siteUrl}/zipped"`));
  const b = await request(`/p/${siteUrl}/br`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
  assert.ok(b.body.includes(`href="/p/${siteUrl}/brotli"`));
});

test('non-UTF-8 pages keep their bytes', async () => {
  const r = await request(`/p/${siteUrl}/latin1`);
  assert.ok(r.headers['content-type'].includes('iso-8859-1'));
  assert.ok(Buffer.from(r.body, 'utf8').length > 0);
  assert.ok(r.body.includes(`/p/${siteUrl}/l`));
});

test('redirects stay inside the proxy', async () => {
  const r = await request(`/p/${siteUrl}/redirect`);
  assert.strictEqual(r.status, 302);
  assert.strictEqual(r.headers.location, `/p/${siteUrl}/landing`);
  const a = await request(`/p/${siteUrl}/redirect-abs`);
  assert.strictEqual(a.headers.location, '/p/https://elsewhere.example/path');
});

test('bare origin gets a trailing slash', async () => {
  const r = await request(`/p/${siteUrl}`);
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.location, `/p/${siteUrl}/`);
});

test('cookies are kept in a server-side jar per session', async () => {
  const first = await request(`/p/${siteUrl}/set-cookie`);
  const psid = first.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
  assert.ok(!first.headers['set-cookie'].some((c) => c.startsWith('sid=')), 'site cookies never reach the browser');
  const echo = await request(`/p/${siteUrl}/echo`, { headers: { cookie: psid } });
  const data = JSON.parse(echo.body);
  assert.strictEqual(data.headers.cookie, 'sid=abc123; pref=dark');
  // document.cookie view excludes HttpOnly cookies
  const js = await request(`/__proxy/cookie?url=${encodeURIComponent(siteUrl + '/')}`, { headers: { cookie: psid } });
  assert.strictEqual(js.body, 'pref=dark');
  // scripts can set cookies but cannot overwrite HttpOnly ones
  await request(`/__proxy/cookie?url=${encodeURIComponent(siteUrl + '/')}`, { method: 'POST', headers: { cookie: psid }, body: 'sid=hacked; path=/' });
  await request(`/__proxy/cookie?url=${encodeURIComponent(siteUrl + '/')}`, { method: 'POST', headers: { cookie: psid }, body: 'js=1; path=/' });
  const echo2 = JSON.parse((await request(`/p/${siteUrl}/echo`, { headers: { cookie: psid } })).body);
  assert.strictEqual(echo2.headers.cookie, 'sid=abc123; pref=dark; js=1');
  // a different session sees nothing
  const other = JSON.parse((await request(`/p/${siteUrl}/echo`)).body);
  assert.strictEqual(other.headers.cookie, undefined);
});

test('request headers are translated', async () => {
  const r = await request(`/p/${siteUrl}/echo?x=1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: proxyUrl,
      referer: `${proxyUrl}/p/${siteUrl}/form`,
      'x-forwarded-for': '1.2.3.4',
      'x-custom': 'yes',
      'sec-fetch-site': 'same-origin',
    },
    body: 'q=hello',
  });
  const d = JSON.parse(r.body);
  assert.strictEqual(d.method, 'POST');
  assert.strictEqual(d.body, 'q=hello');
  assert.strictEqual(d.url, '/echo?x=1');
  assert.strictEqual(d.headers.host, siteUrl.replace('http://', ''));
  assert.strictEqual(d.headers.origin, siteUrl);
  assert.strictEqual(d.headers.referer, `${siteUrl}/form`);
  assert.strictEqual(d.headers['x-custom'], 'yes');
  assert.strictEqual(d.headers['x-forwarded-for'], undefined);
  assert.strictEqual(d.headers['sec-fetch-site'], 'same-origin');
});

test('root-relative escapes are routed using the Referer', async () => {
  const r = await request('/api/data?id=7', { headers: { referer: `${proxyUrl}/p/${siteUrl}/some/page` } });
  assert.strictEqual(r.status, 307);
  assert.strictEqual(r.headers.location, `/p/${siteUrl}/api/data?id=7`);
});

test('root-relative escapes fall back to the last visited site', async () => {
  const home = await request(`/p/${siteUrl}/`);
  const last = home.headers['set-cookie'].find((c) => c.startsWith('__plast=')).split(';')[0];
  const r = await request('/whatever.png', { headers: { cookie: last } });
  assert.strictEqual(r.status, 307);
  assert.strictEqual(r.headers.location, `/p/${siteUrl}/whatever.png`);
});

test('binary bodies stream through untouched', async () => {
  const r = await new Promise((resolve) => {
    http.get(`${proxyUrl}/p/${siteUrl}/binary`, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, buf: Buffer.concat(chunks) }));
    });
  });
  assert.strictEqual(r.buf.length, 256 * 1024);
  assert.strictEqual(r.res.headers['content-length'], String(256 * 1024));
  assert.strictEqual(r.res.headers.etag, '"bin"');
});

test('range requests work (video seeking)', async () => {
  const r = await request(`/p/${siteUrl}/range`, { headers: { range: 'bytes=2-5' } });
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.body, '2345');
  assert.strictEqual(r.headers['content-range'], 'bytes 2-5/10');
});

test('go endpoint turns input into URLs or searches', async () => {
  const a = await request('/__proxy/go?url=example.com/path');
  assert.strictEqual(a.headers.location, '/p/https://example.com/path');
  const b = await request('/__proxy/go?url=' + encodeURIComponent('how do proxies work'));
  assert.strictEqual(b.headers.location, '/p/https://duckduckgo.com/?q=how%20do%20proxies%20work');
  const c = await request('/__proxy/go?url=' + encodeURIComponent('http://example.org'));
  assert.strictEqual(c.headers.location, '/p/http://example.org/');
});

test('upstream errors produce a friendly page', async () => {
  const r = await request('/p/http://127.0.0.1:1/');
  assert.strictEqual(r.status, 502);
  assert.match(r.body, /Connection refused/);
});

test('invalid targets are rejected', async () => {
  const r = await request('/p/http://');
  assert.strictEqual(r.status, 400);
});

test('WebSockets are tunnelled', async () => {
  const port = new URL(proxyUrl).port;
  const got = await new Promise((resolve, reject) => {
    const s = net.connect(+port, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      s.write(`GET /p/${siteUrl.replace('http', 'ws')}/socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    let sent = false;
    s.on('data', (d) => {
      buf += d.toString();
      if (!sent && buf.includes('\r\n\r\n')) {
        sent = true;
        s.write('ping');
      }
      if (buf.includes('echo:ping')) { s.destroy(); resolve(buf); }
    });
    s.on('error', reject);
    setTimeout(() => reject(new Error('timeout: ' + buf)), 3000).unref();
  });
  assert.match(got, /^HTTP\/1\.1 101/);
  assert.match(got, /sec-websocket-accept/i);
});

test('private addresses are blocked unless allowed', async () => {
  const upstream = require('../src/upstream');
  assert.ok(upstream.isPrivateIp('10.0.0.1'));
  assert.ok(upstream.isPrivateIp('192.168.1.1'));
  assert.ok(upstream.isPrivateIp('::1'));
  assert.ok(upstream.isPrivateIp('::ffff:127.0.0.1'));
  assert.ok(!upstream.isPrivateIp('93.184.216.34'));
});

});
