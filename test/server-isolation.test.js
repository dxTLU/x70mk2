'use strict';

// Cross-site isolation emulation: every proxied site shares the proxy's origin, so the server
// applies SameSite and CORS rules using the requesting page (Referer) and Sec-Fetch-* metadata.
// 127.0.0.1 and 127.0.0.2 are different sites; two ports on 127.0.0.1 are same-site, cross-origin.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const config = require('../src/config');
const proxyMod = require('../src/proxy');
const { createServer } = require('../server');

let servers = [];
let proxyUrl, A, A2, B; // origins of the page site, a same-site sibling and a cross-site API
let log = [];

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function fixture(name) {
  return (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    log.push({ server: name, method: req.method, path: p, headers: req.headers });
    const origin = req.headers.origin;
    const json = (status, obj, extra = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...extra });
      res.end(JSON.stringify(obj));
    };
    const reflect = origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', vary: 'Origin' } : {};
    switch (p) {
      case '/set-cookies':
        res.writeHead(200, {
          'content-type': 'text/plain',
          'set-cookie': ['strict=1; SameSite=Strict; Path=/', 'lax=1; SameSite=Lax; Path=/', 'dflt=1; Path=/', 'none=1; SameSite=None; Secure; Path=/'],
        });
        return res.end('ok');
      case '/set-more':
        res.writeHead(200, { 'content-type': 'image/png', 'set-cookie': ['x3p=1; Path=/', 'y3p=1; SameSite=None; Secure; Path=/'] });
        return res.end('png');
      case '/echo':
        return json(200, { cookie: req.headers.cookie || '', origin: origin || null, referer: req.headers.referer || null, site: req.headers['sec-fetch-site'] || null });
      case '/page':
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end('<html><head></head><body>page</body></html>');
      case '/cors/none':
        return json(200, { secret: 's3cret' });
      case '/cors/star':
        return json(200, { data: 'public' }, {
          'access-control-allow-origin': '*', 'x-secret': 'hidden', 'x-exposed': 'shown', 'access-control-expose-headers': 'X-Exposed',
        });
      case '/cors/reflect':
        return json(200, { data: 'private', cookie: req.headers.cookie || '' }, { ...reflect, 'x-secret': 'hidden' });
      case '/cors/specific':
        return json(200, { secret: 's3cret' }, { 'access-control-allow-origin': 'http://somewhere.else' });
      case '/cors/multi':
        return json(200, { secret: 's3cret' }, { 'access-control-allow-origin': `${origin}, http://other` });
      case '/cors/api':
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            ...reflect, 'access-control-allow-methods': 'PUT, DELETE', 'access-control-allow-headers': 'X-Foo, Content-Type',
            'access-control-max-age': '60',
          });
          return res.end();
        }
        return json(200, { method: req.method, got: req.headers['x-foo'] || null }, reflect);
      case '/cors/api-wild':
        if (req.method === 'OPTIONS') {
          res.writeHead(200, { 'access-control-allow-origin': origin, 'access-control-allow-methods': '*', 'access-control-allow-headers': '*', 'access-control-max-age': '0' });
          return res.end();
        }
        return json(200, { ok: true }, { 'access-control-allow-origin': origin });
      case '/cors/api-deny':
        if (req.method === 'OPTIONS') {
          res.writeHead(200, { 'access-control-allow-origin': origin });
          return res.end();
        }
        return json(200, { reached: true }, reflect);
      case '/cors/preflight-500':
        if (req.method === 'OPTIONS') { res.writeHead(500); return res.end(); }
        return json(200, { reached: true }, reflect);
      case '/cors/redirect':
        res.writeHead(302, { location: '/cors/reflect' });
        return res.end();
      case '/cors/304':
        if (req.headers['if-none-match'] === '"e"') { res.writeHead(304, { etag: '"e"' }); return res.end(); }
        return json(200, { v: 1 }, { etag: '"e"', ...reflect });
      case '/cors/setcookie':
        return json(200, { ok: true }, { ...reflect, 'set-cookie': 'fromcors=1; SameSite=None; Secure; Path=/' });
      case '/font':
        res.writeHead(200, { 'content-type': 'font/woff2' });
        return res.end('font');
      default:
        res.writeHead(404);
        return res.end();
    }
  };
}

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let psid;

/** A request as the browser sends it from a proxied page at `page` (a real URL) to `target`. */
function from(page, target, { method = 'GET', mode = 'cors', dest = 'empty', headers = {}, body } = {}) {
  const h = {
    cookie: psid, referer: `${proxyUrl}/p/${page}`, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': mode,
    'sec-fetch-dest': dest, ...headers,
  };
  if (method !== 'GET' && method !== 'HEAD') h.origin = proxyUrl;
  return request(`/p/${target}`, { method, headers: h, body });
}

/** A navigation the user started (address bar, bookmark, home page). */
function typed(target, extra = {}) {
  return request(`/p/${target}`, {
    headers: { cookie: psid, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', ...extra },
  });
}

const cookieNames = (r) => JSON.parse(r.body).cookie.split('; ').filter(Boolean).map((c) => c.split('=')[0]).sort();

describe('cross-site isolation', () => {
  before(async () => {
    const make = async (name, host) => {
      const s = http.createServer(fixture(name));
      servers.push(s);
      return `http://${host}:${await listen(s, host)}`;
    };
    A = await make('A', '127.0.0.1');
    A2 = await make('A2', '127.0.0.1');
    B = await make('B', '127.0.0.2');
    const proxy = createServer();
    servers.push(proxy);
    proxyUrl = `http://127.0.0.1:${await listen(proxy, '127.0.0.1')}`;
    const first = await request(`/p/${B}/set-cookies`);
    psid = first.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
    await typed(`${A2}/set-cookies`);
  });

  after(() => {
    for (const s of servers) { s.close(); s.closeAllConnections?.(); }
  });

  beforeEach(() => {
    log = [];
    proxyMod.preflightCache.clear();
    config.emulateCors = true;
    config.emulateSameSite = true;
  });

  describe('SameSite', () => {
    it('sends every cookie on navigations the user started', async () => {
      assert.deepStrictEqual(cookieNames(await typed(`${B}/echo`)), ['dflt', 'lax', 'none', 'strict']);
    });

    it('sends only SameSite=None cookies with cross-site subresources', async () => {
      const r = await from(`${A}/page`, `${B}/echo`, { mode: 'no-cors', dest: 'image' });
      assert.deepStrictEqual(cookieNames(r), ['none']);
      const echo = JSON.parse(r.body);
      assert.strictEqual(echo.site, 'cross-site');
      assert.strictEqual(echo.referer, `${A}/`, 'cross-origin requests get only the origin as Referer');
    });

    it('sends Lax cookies on cross-site top-level navigations', async () => {
      const r = await from(`${A}/page`, `${B}/echo`, { mode: 'navigate', dest: 'document' });
      assert.deepStrictEqual(cookieNames(r), ['dflt', 'lax', 'none']);
    });

    it('sends only fresh default cookies with cross-site top-level POSTs', async () => {
      const r = await from(`${A}/page`, `${B}/echo`, { method: 'POST', mode: 'navigate', dest: 'document', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' });
      assert.deepStrictEqual(cookieNames(r), ['dflt', 'none']);
      assert.strictEqual(JSON.parse(r.body).origin, A);
    });

    it('treats cross-site iframes as third-party contexts', async () => {
      const r = await from(`${A}/page`, `${B}/echo`, { mode: 'navigate', dest: 'iframe' });
      assert.deepStrictEqual(cookieNames(r), ['none']);
    });

    it('sends every cookie to same-site, cross-origin hosts', async () => {
      const r = await from(`${A}/page`, `${A2}/echo`, { mode: 'no-cors', dest: 'image' });
      assert.deepStrictEqual(cookieNames(r), ['dflt', 'lax', 'none', 'strict']);
      assert.strictEqual(JSON.parse(r.body).site, 'same-site');
    });

    it('keeps the full Referer for same-origin requests', async () => {
      const r = await from(`${B}/page?x=1`, `${B}/echo`, { mode: 'no-cors', dest: 'image' });
      const echo = JSON.parse(r.body);
      assert.strictEqual(echo.referer, `${B}/page?x=1`);
      assert.strictEqual(echo.site, 'same-origin');
    });

    it('treats requests from pages outside the proxy as cross-site', async () => {
      const nav = await request(`/p/${B}/echo`, {
        headers: { cookie: psid, referer: 'https://evil.example/', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      assert.deepStrictEqual(cookieNames(nav), ['dflt', 'lax', 'none']);
      const echo = JSON.parse(nav.body);
      assert.strictEqual(echo.site, 'cross-site');
      assert.strictEqual(echo.referer, null);
      const img = await request(`/p/${B}/echo`, {
        headers: { cookie: psid, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'image' },
      });
      assert.deepStrictEqual(cookieNames(img), ['none']);
      const post = await request(`/p/${B}/echo`, {
        method: 'POST', body: 'x',
        headers: { cookie: psid, origin: 'https://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' },
      });
      assert.strictEqual(JSON.parse(post.body).origin, 'null');
    });

    it('ignores non-None cookies set by cross-site subresources', async () => {
      await from(`${A}/page`, `${B}/set-more`, { mode: 'no-cors', dest: 'image' });
      const names = cookieNames(await typed(`${B}/echo`));
      assert.ok(names.includes('y3p'));
      assert.ok(!names.includes('x3p'));
    });

    it('can be switched off', async () => {
      config.emulateSameSite = false;
      const r = await from(`${A}/page`, `${B}/echo`, { mode: 'no-cors', dest: 'image' });
      for (const n of ['dflt', 'lax', 'none', 'strict']) assert.ok(cookieNames(r).includes(n), n);
    });
  });

  describe('CORS', () => {
    it('blocks reading a cross-origin response that does not opt in', async () => {
      const r = await from(`${A}/page`, `${B}/cors/none`);
      assert.strictEqual(r.status, 403);
      assert.match(r.headers['x-proxy-cors-error'], /Access-Control-Allow-Origin/);
      assert.ok(!r.body.includes('s3cret'));
      const seen = log.find((l) => l.path === '/cors/none');
      assert.strictEqual(seen.headers.origin, A, 'the real page origin is sent, even for GET');
    });

    it('allows wildcard origins for uncredentialed requests only', async () => {
      const r = await from(`${A}/page`, `${B}/cors/star`);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(JSON.parse(r.body).data, 'public');
      const omit = await from(`${A}/page`, `${B}/cors/star`, { headers: { 'x-proxy-credentials': 'omit' } });
      assert.strictEqual(omit.status, 200);
      assert.strictEqual(log.at(-1).headers.cookie, undefined, 'credentials: omit sends no cookies');
      assert.strictEqual(log.at(-1).headers['x-proxy-credentials'], undefined);
      const inc = await from(`${A}/page`, `${B}/cors/star`, { headers: { 'x-proxy-credentials': 'include' } });
      assert.strictEqual(inc.status, 403);
      assert.match(inc.headers['x-proxy-cors-error'], /credentials/);
    });

    it('exposes only safelisted and listed response headers', async () => {
      const r = await from(`${A}/page`, `${B}/cors/star`);
      assert.strictEqual(r.headers['x-secret'], undefined);
      assert.strictEqual(r.headers['x-exposed'], 'shown');
      assert.match(r.headers['content-type'], /json/);
      assert.strictEqual(r.headers['access-control-allow-origin'], undefined, 'CORS headers stay between proxy and origin');
      assert.match(r.headers.vary, /Referer/);
      assert.strictEqual(r.headers['x-proxy-private'], '1');
    });

    it('allows a reflected origin with credentials', async () => {
      const r = await from(`${A}/page`, `${B}/cors/reflect`, { headers: { 'x-proxy-credentials': 'include' } });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['x-secret'], undefined);
      const sent = JSON.parse(r.body).cookie.split('; ').map((c) => c.split('=')[0]);
      assert.ok(sent.includes('none'), 'cross-site credentialed fetches carry SameSite=None cookies');
      assert.ok(!sent.includes('lax') && !sent.includes('strict') && !sent.includes('dflt'));
    });

    it('blocks mismatched or multiple Access-Control-Allow-Origin values', async () => {
      assert.strictEqual((await from(`${A}/page`, `${B}/cors/specific`)).status, 403);
      assert.strictEqual((await from(`${A}/page`, `${B}/cors/multi`)).status, 403);
    });

    it('sends simple requests without a preflight', async () => {
      const r = await from(`${A}/page`, `${B}/cors/api`, { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: 'hi' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(log.map((l) => l.method), ['POST']);
    });

    it('preflights non-simple methods and headers, then caches the result', async () => {
      const r = await from(`${A}/page`, `${B}/cors/api`, { method: 'PUT', headers: { 'x-foo': 'bar', 'content-type': 'application/json' }, body: '{}' });
      assert.strictEqual(r.status, 200);
      assert.deepStrictEqual(JSON.parse(r.body), { method: 'PUT', got: 'bar' });
      const [pre, actual] = log;
      assert.strictEqual(pre.method, 'OPTIONS');
      assert.strictEqual(pre.headers['access-control-request-method'], 'PUT');
      assert.strictEqual(pre.headers['access-control-request-headers'], 'content-type,x-foo');
      assert.strictEqual(pre.headers.origin, A);
      assert.strictEqual(pre.headers.cookie, undefined, 'preflights never carry credentials');
      assert.strictEqual(actual.method, 'PUT');
      log = [];
      await from(`${A}/page`, `${B}/cors/api`, { method: 'PUT', headers: { 'x-foo': 'baz' }, body: '{}' });
      assert.deepStrictEqual(log.map((l) => l.method), ['PUT'], 'Access-Control-Max-Age is honoured');
    });

    it('stops the actual request when the preflight fails', async () => {
      const r = await from(`${A}/page`, `${B}/cors/api-deny`, { method: 'DELETE' });
      assert.strictEqual(r.status, 403);
      assert.match(r.headers['x-proxy-cors-error'], /DELETE/);
      assert.deepStrictEqual(log.map((l) => l.method), ['OPTIONS'], 'the side effect never happens');
      log = [];
      const e = await from(`${A}/page`, `${B}/cors/preflight-500`, { method: 'PUT' });
      assert.strictEqual(e.status, 403);
      assert.match(e.headers['x-proxy-cors-error'], /HTTP ok status/);
      assert.deepStrictEqual(log.map((l) => l.method), ['OPTIONS']);
    });

    it('never lets a header wildcard cover Authorization', async () => {
      const ok = await from(`${A}/page`, `${B}/cors/api-wild`, { method: 'PATCH', headers: { 'x-anything': '1' } });
      assert.strictEqual(ok.status, 200);
      const auth = await from(`${A}/page`, `${B}/cors/api-wild`, { method: 'PATCH', headers: { authorization: 'Bearer t' } });
      assert.strictEqual(auth.status, 403);
      assert.match(auth.headers['x-proxy-cors-error'], /authorization/);
    });

    it('requires CORS approval on redirects', async () => {
      const r = await from(`${A}/page`, `${B}/cors/redirect`);
      assert.strictEqual(r.status, 403);
    });

    it('leaves same-origin, no-cors and markup-initiated CORS loads alone', async () => {
      assert.strictEqual((await from(`${B}/page`, `${B}/cors/none`)).status, 200, 'same-origin fetch');
      assert.strictEqual((await from(`${A}/page`, `${B}/cors/none`, { mode: 'no-cors', dest: 'image' })).status, 200);
      assert.strictEqual((await from(`${A}/page`, `${B}/font`, { mode: 'cors', dest: 'font' })).status, 200);
      assert.strictEqual((await from(`${A}/page`, `${B}/cors/none`, { mode: 'navigate', dest: 'document' })).status, 200);
    });

    it('applies to same-site but cross-origin requests', async () => {
      assert.strictEqual((await from(`${A}/page`, `${A2}/cors/none`)).status, 403);
    });

    it('lets revalidations through', async () => {
      const r = await from(`${A}/page`, `${B}/cors/304`, { headers: { 'if-none-match': '"e"' } });
      assert.strictEqual(r.status, 304);
    });

    it('cannot attribute requests without a Referer and lets them through', async () => {
      const r = await request(`/p/${B}/cors/none`, { headers: { cookie: psid, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
      assert.strictEqual(r.status, 200);
    });

    it('ignores Set-Cookie on requests made without credentials', async () => {
      await from(`${A}/page`, `${B}/cors/setcookie`, { headers: { 'x-proxy-credentials': 'omit' } });
      assert.ok(!cookieNames(await typed(`${B}/echo`)).includes('fromcors'));
      await from(`${A}/page`, `${B}/cors/setcookie`, { headers: { 'x-proxy-credentials': 'include' } });
      assert.ok(cookieNames(await typed(`${B}/echo`)).includes('fromcors'));
    });

    it('can be switched off', async () => {
      config.emulateCors = false;
      assert.strictEqual((await from(`${A}/page`, `${B}/cors/none`)).status, 200);
    });
  });

  describe('upstream request headers', () => {
    const fakeReq = (headers) => ({ headers: { host: 'proxy.test', ...headers }, socket: {}, method: 'GET' });
    const jar = { header: () => '' };

    it('drops the Referer on https -> http downgrades', () => {
      const h = proxyMod.buildUpstreamHeaders(
        fakeReq({ referer: 'http://proxy.test/p/https://secure.example/account?id=1', 'sec-fetch-site': 'same-origin' }),
        new URL('http://plain.example/x'), jar);
      assert.strictEqual(h.referer, undefined);
      assert.strictEqual(h['sec-fetch-site'], 'cross-site');
    });

    it('strips URL credentials and fragments from the Referer', () => {
      const h = proxyMod.buildUpstreamHeaders(
        fakeReq({ referer: 'http://proxy.test/p/https://user:pw@a.example/p?q=1' }), new URL('https://a.example/x'), jar);
      assert.strictEqual(h.referer, 'https://a.example/p?q=1');
    });
  });
});
