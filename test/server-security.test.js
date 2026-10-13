'use strict';

// Security properties: SSRF protection, open redirects, header injection, session cookie flags,
// cookie endpoint isolation, escaping in error pages and the optional BASIC_AUTH gate.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const os = require('os');
const dns = require('dns');
const crypto = require('crypto');
const config = require('../src/config');
const upstream = require('../src/upstream');
const { createServer } = require('../server');

let site, proxy, siteUrl, proxyUrl, proxyPort;
let lastHeaders = null;

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString(), raw: res.rawHeaders }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Raw HTTP/1.1 exchange, for paths a normal client would normalise. */
function rawRequest(lines) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(lines.join('\r\n') + '\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d.toString('latin1'); });
    s.on('end', () => resolve(buf));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(buf); }, 1500).unref();
  });
}

function wsHandshake(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      const key = crypto.randomBytes(16).toString('base64');
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${proxyPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`);
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) { s.destroy(); resolve(buf); }
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(buf); }, 2000).unref();
  });
}

describe('security', () => {
  before(async () => {
    site = http.createServer((req, res) => {
      lastHeaders = req.headers;
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/to-private') {
        res.writeHead(302, { location: 'http://10.0.0.1/admin' });
        return res.end();
      }
      if (u.pathname === '/to-metadata') {
        res.writeHead(307, { location: 'http://[::ffff:169.254.169.254]/latest/meta-data/' });
        return res.end();
      }
      if (u.pathname === '/spoof') {
        res.writeHead(200, { 'content-type': 'text/plain', 'x-proxy-cors-error': 'fake', 'x-proxy-private': 'nope', 'x-proxied-url': 'http://evil/' });
        return res.end('spoof');
      }
      if (u.pathname === '/cookies') {
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['sid=topsecret; HttpOnly; Path=/', 'theme=<script>alert(1)</script>; Path=/'] });
        return res.end('ok');
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    site.on('upgrade', (req, socket) => {
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.end(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    proxy = createServer();
    proxyPort = await listen(proxy);
    proxyUrl = `http://127.0.0.1:${proxyPort}`;
  });

  after(() => {
    for (const s of [site, proxy]) { s.close(); s.closeAllConnections?.(); }
  });

  afterEach(() => {
    config.allowPrivate = true;
    config.basicAuth = '';
  });

  describe('SSRF guard', () => {
    it('classifies private, reserved and public addresses', () => {
      const priv = [
        '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1',
        '172.31.255.255', '192.168.1.1', '192.0.0.8', '198.18.0.1', '224.0.0.1', '255.255.255.255',
        '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::127.0.0.1', '::7f00:1',
        '::ffff:0:10.0.0.1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:101::1', '2001:0:4136:e378::1',
        '2001:db8::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '[::1]', '100::1', 'not-an-ip',
      ];
      for (const ip of priv) assert.ok(upstream.isPrivateIp(ip), ip);
      const pub = ['93.184.216.34', '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001::200e', '::ffff:8.8.8.8', '2002:808:808::1', '64:ff9b::808:808'];
      for (const ip of pub) assert.ok(!upstream.isPrivateIp(ip), ip);
    });

    it('understands decimal, octal, hex and short IPv4 forms', () => {
      assert.strictEqual(upstream.parseLegacyIPv4('2130706433'), '127.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('0x7f.1'), '127.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('0177.0.0.1'), '127.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('127.1'), '127.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('0x0a.0x0.0.01'), '10.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('017700000001'), '127.0.0.1');
      assert.strictEqual(upstream.parseLegacyIPv4('example.com'), null);
      assert.strictEqual(upstream.parseLegacyIPv4('1.2.3.4.5'), null);
      assert.strictEqual(upstream.parseLegacyIPv4('256.1.1.1'), null);
    });

    it('refuses internal names, private literals and non-web ports', () => {
      config.allowPrivate = false;
      const blocked = [
        ['localhost'], ['LOCALHOST.'], ['app.localhost'], ['printer.local'], ['db.internal'], ['router.home.arpa'],
        ['127.0.0.1'], ['[::1]'], ['[::ffff:7f00:1]'], ['2130706433'], ['0x7f.1'], ['10.1'], ['[fd00::1]'],
        ['169.254.169.254'], ['example.com', 22], ['example.com', '25'], ['93.184.216.34', 6667],
      ];
      for (const [h, port] of blocked) assert.throws(() => upstream.checkHostAllowed(h, port), { code: 'EBLOCKED' }, `${h}:${port}`);
      for (const [h, port] of [['example.com', 443], ['93.184.216.34', 8080], ['[2606:4700::1]', 80]]) {
        assert.doesNotThrow(() => upstream.checkHostAllowed(h, port), h);
      }
    });

    it('blocks every spelling of a private address end to end', async () => {
      config.allowPrivate = false;
      lastHeaders = null;
      const port = new URL(siteUrl).port;
      for (const t of [
        `http://2130706433:${port}/`, `http://0x7f.1:${port}/`, `http://0177.0.0.1:${port}/`, `http://127.1:${port}/`,
        `http://[::1]:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, `http://[0:0:0:0:0:ffff:7f00:1]:${port}/`,
        `http://localhost:${port}/`, 'http://169.254.169.254/latest/meta-data/', 'http://[fe80::1]/', 'http://example.com:25/',
      ]) {
        const r = await request(`/p/${t}`);
        assert.strictEqual(r.status, 403, t);
        assert.match(r.body, /Request blocked/, t);
      }
      assert.strictEqual(lastHeaders, null, 'nothing reached the private server');
    });

    it('blocks host names that resolve to private addresses', async (t) => {
      const name = os.hostname();
      const addrs = await new Promise((resolve) => dns.lookup(name, { all: true }, (e, a) => resolve(e ? [] : a)));
      if (!addrs.length || !addrs.every((a) => upstream.isPrivateIp(a.address))) return t.skip('host name does not resolve to a private address here');
      config.allowPrivate = false;
      lastHeaders = null;
      const err = await new Promise((resolve) => upstream.guardedLookup(name, {}, (e) => resolve(e)));
      assert.strictEqual(err && err.code, 'EBLOCKED');
      const r = await request(`/p/http://${name}:${new URL(siteUrl).port}/`);
      assert.strictEqual(r.status, 403);
      assert.match(r.body, /private address/);
      assert.strictEqual(lastHeaders, null);
    });

    it('keeps redirects into private space inside the guard', async () => {
      const r = await request(`/p/${siteUrl}/to-private`);
      assert.strictEqual(r.headers.location, '/p/http://10.0.0.1/admin');
      const m = await request(`/p/${siteUrl}/to-metadata`);
      assert.strictEqual(m.headers.location, '/p/http://[::ffff:a9fe:a9fe]/latest/meta-data/');
      config.allowPrivate = false;
      assert.strictEqual((await request(r.headers.location)).status, 403);
      assert.strictEqual((await request(m.headers.location)).status, 403);
    });
  });

  describe('redirects and header injection', () => {
    it('never redirects off the proxy from /__proxy/go', async () => {
      for (const input of ['//evil.example', '/\\evil.example', '\\\\evil.example', 'https:evil.example', ' https://evil.example',
        'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '%2F%2Fevil.example', 'http://evil.example@good.example']) {
        const r = await request('/__proxy/go?url=' + encodeURIComponent(input));
        assert.strictEqual(r.status, 302, input);
        assert.ok(r.headers.location.startsWith('/p/') || r.headers.location === '/', `${input} -> ${r.headers.location}`);
        assert.ok(!r.headers.location.startsWith('//'), input);
      }
      const home = await request('/?url=' + encodeURIComponent('//evil.example'));
      assert.ok(home.headers.location.startsWith('/p/'));
    });

    it('cannot be tricked into writing extra headers', async () => {
      const r = await request('/__proxy/go?url=' + encodeURIComponent('http://example.com/\r\nSet-Cookie: pwned=1\r\nX-Injected: 1'));
      assert.strictEqual(r.status, 302);
      assert.ok(!(r.headers['set-cookie'] || []).some((c) => c.includes('pwned')));
      assert.strictEqual(r.headers['x-injected'], undefined);
      assert.doesNotMatch(r.headers.location, /[\r\n]/);
      const enc = await request(`/p/${siteUrl}/a%0d%0aSet-Cookie:%20pwned=1`);
      assert.ok(!(enc.headers['set-cookie'] || []).some((c) => c.includes('pwned')));
      assert.strictEqual(enc.headers['x-proxied-url'], `${siteUrl}/a%0d%0aSet-Cookie:%20pwned=1`);
      const escaped = await request('/x%0d%0aSet-Cookie:%20pwned=1', { headers: { referer: `${proxyUrl}/p/${siteUrl}/` } });
      assert.strictEqual(escaped.status, 307);
      assert.ok(!(escaped.headers['set-cookie'] || []).some((c) => c.includes('pwned')));
    });

    it('drops x-proxy-* headers an origin tries to inject', async () => {
      const r = await request(`/p/${siteUrl}/spoof`);
      assert.strictEqual(r.headers['x-proxy-cors-error'], undefined);
      assert.strictEqual(r.headers['x-proxy-private'], undefined);
      assert.strictEqual(r.headers['x-proxied-url'], `${siteUrl}/spoof`);
    });
  });

  describe('session cookies', () => {
    it('marks the session cookie HttpOnly and SameSite', async () => {
      const r = await request(`/p/${siteUrl}/`);
      const c = r.headers['set-cookie'].find((s) => s.startsWith('__psid='));
      assert.match(c, /; HttpOnly/);
      assert.match(c, /; SameSite=Lax/);
      assert.match(c, /; Path=\//);
      assert.doesNotMatch(c, /Secure/);
      const tls = await request(`/p/${siteUrl}/`, { headers: { 'x-forwarded-proto': 'https' } });
      assert.match(tls.headers['set-cookie'].find((s) => s.startsWith('__psid=')), /; Secure/);
    });

    it('marks the last-site cookie HttpOnly too', async () => {
      const html = await new Promise((resolve) => {
        const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html></html>'); });
        s.listen(0, '127.0.0.1', async () => {
          const out = await request(`/p/http://127.0.0.1:${s.address().port}/`);
          s.close();
          resolve(out);
        });
      });
      const c = html.headers['set-cookie'].find((s) => s.startsWith('__plast='));
      assert.match(c, /; HttpOnly/);
      assert.match(c, /; SameSite=Lax/);
    });

    it('never shows HttpOnly cookies to scripts and isolates sites', async () => {
      const first = await request(`/p/${siteUrl}/cookies`);
      const psid = first.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
      const url = encodeURIComponent(siteUrl + '/');
      const own = await request(`/__proxy/cookie?url=${url}`, { headers: { cookie: psid, referer: `${proxyUrl}/p/${siteUrl}/page` } });
      assert.strictEqual(own.status, 200);
      assert.strictEqual(own.body, 'theme=<script>alert(1)</script>');
      assert.match(own.headers['content-type'], /^text\/plain/);
      assert.strictEqual(own.headers['x-content-type-options'], 'nosniff');
      assert.strictEqual(own.headers['cache-control'], 'no-store');
      const other = await request(`/__proxy/cookie?url=${url}`, { headers: { cookie: psid, referer: `${proxyUrl}/p/https://evil.example/` } });
      assert.strictEqual(other.status, 403, 'a page cannot read another site\'s cookies');
      const foreign = await request(`/__proxy/cookie?url=${url}`, { method: 'POST', body: 'x=1', headers: { cookie: psid, 'sec-fetch-site': 'cross-site' } });
      assert.strictEqual(foreign.status, 403);
      const clear = await request('/__proxy/clear', { method: 'POST', headers: { cookie: psid, 'sec-fetch-site': 'cross-site' } });
      assert.strictEqual(clear.status, 403);
      assert.strictEqual((await request('/__proxy/clear', { headers: { cookie: psid } })).status, 405);
      assert.strictEqual((await request(`/__proxy/cookie?url=${encodeURIComponent('javascript:alert(1)')}`)).status, 400);
    });
  });

  describe('error pages', () => {
    const payload = '"><script>alert(1)</script><img/src=x/onerror=alert(2)>';

    it('escapes everything they reflect', async () => {
      const pages = [
        await request(`/p/http://127.0.0.1:1/${payload}`),
        await request(`/p/http://127.0.0.1:1/?q=${payload}`),
        await request(`/__proxy/${payload}`),
      ];
      config.allowPrivate = false;
      pages.push(await request(`/p/http://10.0.0.1/${payload}`));
      for (const r of pages) {
        assert.match(r.headers['content-type'], /text\/html/);
        assert.doesNotMatch(r.body, /<script>alert/);
        assert.doesNotMatch(r.body, /<img\/src=x/);
        assert.strictEqual(r.headers['x-content-type-options'], 'nosniff');
      }
    });

    it('escapes raw characters a client sends unencoded', async () => {
      const res = await rawRequest([`GET /p/http://127.0.0.1:1/"'><svg/onload=alert(1)> HTTP/1.1`, 'Host: x', 'Connection: close']);
      assert.doesNotMatch(res, /<svg\/onload/);
    });
  });

  describe('BASIC_AUTH', () => {
    const good = 'Basic ' + Buffer.from('admin:s3cr3t:with:colons').toString('base64');

    it('gates every route except the health check', async () => {
      config.basicAuth = 'admin:s3cr3t:with:colons';
      const denied = await request('/');
      assert.strictEqual(denied.status, 401);
      assert.match(denied.headers['www-authenticate'], /^Basic realm="proxy"/);
      assert.strictEqual((await request(`/p/${siteUrl}/`)).status, 401);
      assert.strictEqual((await request('/__proxy/client.js')).status, 401);
      assert.strictEqual((await request('/', { headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') } })).status, 401);
      assert.strictEqual((await request('/', { headers: { authorization: 'Bearer x' } })).status, 401);
      assert.strictEqual((await request('/', { headers: { authorization: good } })).status, 200);
      assert.strictEqual((await request('/', { headers: { authorization: good.replace('Basic', 'basic') } })).status, 200);
      const health = await request('/__proxy/health');
      assert.strictEqual(health.status, 200);
      assert.deepStrictEqual(JSON.parse(health.body), { ok: true }, 'no details without credentials');
    });

    it('never forwards the gate credentials upstream', async () => {
      config.basicAuth = 'admin:s3cr3t:with:colons';
      lastHeaders = null;
      const r = await request(`/p/${siteUrl}/`, { headers: { authorization: good } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(lastHeaders.authorization, undefined);
    });

    it('forwards a site\'s own Authorization when the gate is off', async () => {
      await request(`/p/${siteUrl}/`, { headers: { authorization: 'Bearer abc' } });
      assert.strictEqual(lastHeaders.authorization, 'Bearer abc');
    });

    it('also gates WebSocket upgrades', async () => {
      config.basicAuth = 'admin:s3cr3t:with:colons';
      const target = `/p/${siteUrl.replace('http', 'ws')}/sock`;
      const denied = await wsHandshake(target);
      assert.match(denied, /^HTTP\/1\.1 401/);
      assert.match(denied, /WWW-Authenticate: Basic/i);
      const ok = await wsHandshake(target, { Authorization: good });
      assert.match(ok, /^HTTP\/1\.1 101/);
    });
  });
});
