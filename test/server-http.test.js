'use strict';

// HTTP semantics of the proxy: methods without bodies, conditionals, ranges, streaming uploads,
// 100-continue, content codings, charsets, large/streaming bodies, header rewriting and failures.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const config = require('../src/config');
const proxyMod = require('../src/proxy');
const { createServer } = require('../server');

let site, raw10, proxy, siteUrl, http10Url, proxyUrl;
const seen = {}; // what the fixture saw, keyed by path
const waiters = {}; // promises the fixture resolves, keyed by name

function deferred() {
  let resolve;
  const p = new Promise((r) => { resolve = r; });
  p.resolve = resolve;
  return p;
}

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function request(path, { method = 'GET', headers = {}, body, decode = true, agent } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + path, { method, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (decode && res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, buf, body: buf.toString('utf8'), raw: res.rawHeaders });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const HTML = '<!doctype html><html><head><title>t</title></head><body><a href="/next">n</a></body></html>';
const encoders = {
  identity: (b) => b,
  gzip: (b) => zlib.gzipSync(b),
  deflate: (b) => zlib.deflateSync(b),
  'deflate-raw': (b) => zlib.deflateRawSync(b),
  br: (b) => zlib.brotliCompressSync(b),
};

function fixture(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  seen[p] = { headers: req.headers, method: req.method, url: req.url };
  const html = (status = 200, extra = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(HTML); };

  if (p === '/html') {
    if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); return res.end(); }
    return html(200, { etag: '"v1"', 'cache-control': 'no-cache' });
  }
  if (p === '/html-weak') return html(200, { etag: 'W/"w1"' });
  if (p === '/html-lm') {
    if (req.headers['if-modified-since']) { res.writeHead(304); return res.end(); }
    return html(200, { 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT' });
  }
  if (p === '/bin-etag') {
    if (req.headers['if-none-match'] === '"bin"') { res.writeHead(304, { etag: '"bin"' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"bin"', 'content-length': 4 });
    return res.end('abcd');
  }
  if (p === '/204') { res.writeHead(204, { 'x-thing': '1' }); return res.end(); }
  if (p === '/early-hints') {
    res.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' });
    return setTimeout(() => html(), 20);
  }
  if (p === '/range-html') {
    if (req.headers.range === 'bytes=0-4') {
      res.writeHead(206, { 'content-type': 'text/html', 'content-range': `bytes 0-4/${HTML.length}` });
      return res.end(HTML.slice(0, 5));
    }
    return html();
  }
  if (p === '/upload' || p === '/upload-stream' || p === '/reject-upload') {
    const hash = crypto.createHash('sha256');
    let length = 0;
    let first = true;
    req.on('data', (c) => {
      hash.update(c);
      length += c.length;
      if (first && waiters.firstChunk) waiters.firstChunk.resolve();
      first = false;
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        sha256: hash.digest('hex'), length, te: req.headers['transfer-encoding'] || null,
        cl: req.headers['content-length'] || null, ct: req.headers['content-type'] || null, method: req.method,
      }));
    });
    return;
  }
  if (p === '/upload-abort') {
    req.on('data', () => {});
    req.on('close', () => { seen.uploadAborted = !req.complete; if (waiters.uploadClosed) waiters.uploadClosed.resolve(); });
    return;
  }
  if (p.startsWith('/enc/')) {
    const name = p.slice(5);
    const body = Buffer.from(HTML);
    if (name === 'corrupt') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(Buffer.from('this is not gzip at all'));
    }
    if (name === 'truncated') {
      const gz = zlib.gzipSync(Buffer.from(HTML.repeat(50)));
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      return res.end(gz.subarray(0, gz.length - 30));
    }
    if (name === 'stacked') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip, br' });
      return res.end(zlib.brotliCompressSync(zlib.gzipSync(body)));
    }
    if (name === 'unknown') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'compress' });
      return res.end('opaque-bytes');
    }
    const header = name === 'deflate-raw' ? 'deflate' : name;
    res.writeHead(200, { 'content-type': 'text/html', ...(name === 'identity' ? {} : { 'content-encoding': header }) });
    return res.end(encoders[name](body));
  }
  if (p === '/bom-utf8') {
    res.writeHead(200, { 'content-type': 'text/html; charset=iso-8859-1' });
    return res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>café</p><a href="/x">x</a>')]));
  }
  if (p === '/bom-utf16') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<p>naïve ✓</p><a href="/y">y</a>', 'utf16le')]));
  }
  if (p === '/meta-sjis') {
    res.writeHead(200, { 'content-type': 'text/html' });
    // "日本" in Shift_JIS, preceded by a <meta charset> the browser must still honour.
    return res.end(Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"><title>t</title></head><body><p>'),
      Buffer.from([0x93, 0xfa, 0x96, 0x7b]), Buffer.from('</p><a href="/z">z</a></body></html>')]));
  }
  if (p === '/css-charset') {
    res.writeHead(200, { 'content-type': 'text/css' });
    return res.end(Buffer.concat([Buffer.from('@charset "iso-8859-1"; .a:after{content:"'), Buffer.from([0xe9]), Buffer.from('"} .b{background:url(i.png)}')]));
  }
  if (p === '/big-html') {
    const n = +u.searchParams.get('len');
    const body = Buffer.from('<html><body>' + 'x'.repeat(n) + '<a href="/far">f</a></body></html>');
    const headers = { 'content-type': 'text/html' };
    if (!u.searchParams.has('chunked')) headers['content-length'] = body.length;
    res.writeHead(200, headers);
    if (u.searchParams.has('chunked')) {
      for (let i = 0; i < body.length; i += 8192) res.write(body.subarray(i, i + 8192));
      return res.end();
    }
    return res.end(body);
  }
  if (p === '/sse') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: one\n\n');
    waiters.sseRelease.then(() => res.end('data: two\n\n'));
    return;
  }
  if (p === '/cookies3') {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'set-cookie': ['a=1; Path=/', 'b=2; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT', 'c=3; Path=/; HttpOnly'],
    });
    return res.end('ok');
  }
  if (p === '/clear-site-data') {
    res.writeHead(200, { 'content-type': 'text/plain', 'clear-site-data': '"cache", "cookies"' });
    return res.end('cleared');
  }
  if (p === '/echo') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ headers: req.headers, body: Buffer.concat(chunks).toString('latin1'), url: req.url }));
    });
    return;
  }
  if (p === '/utf8-header') {
    res.setHeader('x-name', Buffer.from('café ✓').toString('latin1'));
    res.setHeader('location', Buffer.from('/café/ü?q=ö').toString('latin1'));
    res.writeHead(302);
    return res.end();
  }
  if (p.endsWith('/loc')) {
    res.writeHead(302, { location: u.searchParams.get('to') });
    return res.end();
  }
  if (p === '/refresh') {
    res.writeHead(200, { 'content-type': 'text/plain', refresh: u.searchParams.get('v') });
    return res.end('r');
  }
  if (p === '/link') {
    res.setHeader('link', [
      '</app.css>; rel=preload; as=style; integrity="sha384-x"',
      '<https://fonts.example>; rel=preconnect',
      '<https://cdn.example/a,b.js>; rel=modulepreload',
    ]);
    return html();
  }
  if (p === '/download') {
    res.writeHead(200, {
      'content-type': 'text/html',
      'content-disposition': `attachment; filename="r${Buffer.from('é').toString('latin1')}sum.html"; filename*=UTF-8''r%C3%A9sum.html`,
    });
    return res.end(HTML);
  }
  if (p === '/truncated-html') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': 1000 });
    res.write('<html><body><a href="/');
    return setTimeout(() => res.socket.destroy(), 20);
  }
  if (p === '/truncated-bin') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 100000 });
    res.write(Buffer.alloc(1000, 1));
    return setTimeout(() => res.socket.destroy(), 20);
  }
  if (p === '/slow-stream') {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const t = setInterval(() => res.write(Buffer.alloc(1024, 2)), 20);
    res.on('close', () => { clearInterval(t); if (waiters.slowClosed) waiters.slowClosed.resolve(); });
    return;
  }
  if (p === '/hang') return; // never answers
  if (p === '/stall-html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.write('<html><body>partial');
  }
  if (p === '/flaky-keepalive') {
    const s = req.socket;
    s.count = (s.count || 0) + 1;
    if (s.count > 1) return s.destroy(); // a keep-alive connection the server has given up on
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('fresh');
  }
  if (p === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    return res.end(JSON.stringify({
      name: 'App', start_url: '/start', scope: '/', icons: [{ src: 'icon.png', sizes: '192x192' }],
      shortcuts: [{ name: 's', url: '/s', icons: [{ src: '/s.png' }] }],
    }));
  }
  if (p === '/no-type-html') return res.end('<!DOCTYPE html><html><head></head><body><a href="/q">q</a></body></html>');
  if (p === '/no-type-bin') return res.end(Buffer.from([0, 1, 2, 3, 0x89, 0x50]));
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found ' + p);
}

describe('HTTP semantics', () => {
  before(async () => {
    site = http.createServer(fixture);
    site.on('checkContinue', (req, res) => {
      if (req.url === '/reject-upload') {
        res.writeHead(413, { 'content-type': 'text/plain' });
        return res.end('too large');
      }
      res.writeContinue();
      fixture(req, res);
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    // A bare-bones HTTP/1.0 origin: no Content-Length, body ends when the connection closes.
    raw10 = net.createServer((sock) => {
      sock.once('data', () => {
        sock.end('HTTP/1.0 200 OK\r\nContent-Type: text/html\r\nX-Old: yes\r\n\r\n<html><body><a href="/ten">10</a></body></html>');
      });
    });
    http10Url = `http://127.0.0.1:${await listen(raw10)}`;
    proxy = createServer();
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  after(() => {
    for (const s of [site, raw10, proxy]) { s.close(); s.closeAllConnections?.(); }
  });

  it('answers HEAD without a body and with the headers a GET would get', async () => {
    const get = await request(`/p/${siteUrl}/html`);
    const head = await request(`/p/${siteUrl}/html`, { method: 'HEAD' });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.buf.length, 0);
    assert.strictEqual(head.headers['content-length'], undefined, 'length of the unrewritten body is not reported');
    assert.strictEqual(head.headers.etag, get.headers.etag);
    assert.strictEqual(seen['/html'].method, 'HEAD');
    const bin = await request(`/p/${siteUrl}/bin-etag`, { method: 'HEAD' });
    assert.strictEqual(bin.headers['content-length'], '4');
    assert.strictEqual(bin.buf.length, 0);
  });

  it('relays 204 and 304 without bodies', async () => {
    const r = await request(`/p/${siteUrl}/204`);
    assert.strictEqual(r.status, 204);
    assert.strictEqual(r.headers['x-thing'], '1');
    assert.strictEqual(r.buf.length, 0);
    const nm = await request(`/p/${siteUrl}/bin-etag`, { headers: { 'if-none-match': '"bin"' } });
    assert.strictEqual(nm.status, 304);
    assert.strictEqual(nm.headers.etag, '"bin"');
    assert.strictEqual(nm.buf.length, 0);
  });

  it('skips 1xx informational responses such as 103 Early Hints', async () => {
    const r = await request(`/p/${siteUrl}/early-hints`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes(`/p/${siteUrl}/next`));
  });

  it('tags validators of rewritten bodies with the rewriter version', async () => {
    const ver = proxyMod.clientBundle().rewriteVersion;
    const first = await request(`/p/${siteUrl}/html`);
    assert.strictEqual(first.headers.etag, `W/"pxs${ver}-v1"`);
    const again = await request(`/p/${siteUrl}/html`, { headers: { 'if-none-match': first.headers.etag } });
    assert.strictEqual(seen['/html'].headers['if-none-match'], '"v1"', 'the origin sees its own validator');
    assert.strictEqual(again.status, 304);
    assert.strictEqual(again.headers.etag, first.headers.etag);

    const stale = await request(`/p/${siteUrl}/html`, { headers: { 'if-none-match': 'W/"pxs00000000-v1"', 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT' } });
    assert.strictEqual(stale.status, 200, 'a rewrite from another proxy version is never revalidated');
    assert.strictEqual(seen['/html'].headers['if-none-match'], undefined);
    assert.strictEqual(seen['/html'].headers['if-modified-since'], undefined);

    const weak = await request(`/p/${siteUrl}/html-weak`);
    assert.strictEqual(weak.headers.etag, `W/"pxw${ver}-w1"`);
    await request(`/p/${siteUrl}/html-weak`, { headers: { 'if-none-match': weak.headers.etag } });
    assert.strictEqual(seen['/html-weak'].headers['if-none-match'], 'W/"w1"');

    const lm = await request(`/p/${siteUrl}/html-lm`);
    assert.strictEqual(lm.headers.etag, `W/"pxl${ver}-"`);
    assert.strictEqual(lm.headers['last-modified'], 'Wed, 21 Oct 2015 07:28:00 GMT');
    const lm2 = await request(`/p/${siteUrl}/html-lm`, { headers: { 'if-none-match': lm.headers.etag, 'if-modified-since': lm.headers['last-modified'] } });
    assert.strictEqual(lm2.status, 304);
    assert.strictEqual(seen['/html-lm'].headers['if-none-match'], undefined);
    assert.ok(seen['/html-lm'].headers['if-modified-since']);
  });

  it('keeps preconditions on writes even across rewriter versions', async () => {
    await request(`/p/${siteUrl}/echo`, { method: 'PUT', body: 'x', headers: { 'if-match': 'W/"pxs00000000-v1", "other"' } });
    assert.strictEqual(seen['/echo'].headers['if-match'], '"v1", "other"', 'a lost-update guard is never dropped');
    await request(`/p/${siteUrl}/echo`, { method: 'PUT', body: 'x', headers: { 'if-none-match': 'W/"pxw00000000-v1"' } });
    assert.strictEqual(seen['/echo'].headers['if-none-match'], 'W/"v1"');
  });

  it('passes other conditional headers through untouched', async () => {
    await request(`/p/${siteUrl}/bin-etag`, { headers: { 'if-range': 'Wed, 21 Oct 2015 07:28:00 GMT', range: 'bytes=0-1', 'if-match': '"bin"' } });
    assert.strictEqual(seen['/bin-etag'].headers['if-range'], 'Wed, 21 Oct 2015 07:28:00 GMT');
    assert.strictEqual(seen['/bin-etag'].headers.range, 'bytes=0-1');
    assert.strictEqual(seen['/bin-etag'].headers['if-match'], '"bin"');
    // A range of a rewritten body cannot come from the origin's bytes: the whole thing is fetched.
    const ver = proxyMod.clientBundle().rewriteVersion;
    await request(`/p/${siteUrl}/range-html`, { headers: { range: 'bytes=0-4', 'if-range': `W/"pxs${ver}-v1"` } });
    assert.strictEqual(seen['/range-html'].headers.range, undefined);
  });

  it('passes partial content through without rewriting it', async () => {
    const r = await request(`/p/${siteUrl}/range-html`, { headers: { range: 'bytes=0-4' } });
    assert.strictEqual(r.status, 206);
    assert.strictEqual(r.body, HTML.slice(0, 5));
    assert.strictEqual(r.headers['content-range'], `bytes 0-4/${HTML.length}`);
  });

  it('streams chunked uploads without buffering them', async () => {
    waiters.firstChunk = deferred();
    const a = crypto.randomBytes(100000), b = crypto.randomBytes(50000);
    const result = new Promise((resolve, reject) => {
      const req = http.request(`${proxyUrl}/p/${siteUrl}/upload-stream`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' } }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
      req.write(a);
      // The second half is only sent once the origin has the first: a buffering proxy deadlocks here.
      waiters.firstChunk.then(() => req.end(b));
    });
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('upload was buffered')), 4000).unref());
    const d = await Promise.race([result, timeout]);
    assert.strictEqual(d.length, 150000);
    assert.strictEqual(d.sha256, crypto.createHash('sha256').update(a).update(b).digest('hex'));
    assert.strictEqual(d.te, 'chunked');
    assert.strictEqual(d.cl, null);
  });

  it('forwards large fixed-length bodies byte for byte', async () => {
    const body = crypto.randomBytes(12 * 1024 * 1024);
    const r = await request(`/p/${siteUrl}/upload`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': body.length }, body });
    const d = JSON.parse(r.body);
    assert.strictEqual(d.length, body.length);
    assert.strictEqual(d.sha256, crypto.createHash('sha256').update(body).digest('hex'));
    assert.strictEqual(d.cl, String(body.length));
    assert.strictEqual(d.method, 'PUT');
  });

  it('forwards chunked bodies of methods that do not default to chunking', async () => {
    const d = await new Promise((resolve, reject) => {
      const req = http.request(`${proxyUrl}/p/${siteUrl}/upload`, { method: 'DELETE', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(JSON.parse(b)));
      });
      req.on('error', reject);
      req.write('hello ');
      req.end('world');
    });
    assert.strictEqual(d.length, 11);
    assert.strictEqual(d.te, 'chunked');
  });

  it('forwards multipart forms intact', async () => {
    const boundary = '----x' + crypto.randomBytes(8).toString('hex');
    const file = crypto.randomBytes(5000);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nhéllo\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      file, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await request(`/p/${siteUrl}/upload`, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    const d = JSON.parse(r.body);
    assert.strictEqual(d.ct, `multipart/form-data; boundary=${boundary}`);
    assert.strictEqual(d.sha256, crypto.createHash('sha256').update(body).digest('hex'));
  });

  it('answers Expect: 100-continue end to end', async () => {
    const body = Buffer.from('payload-after-continue');
    const ok = await new Promise((resolve, reject) => {
      const req = http.request(`${proxyUrl}/p/${siteUrl}/upload`, { method: 'POST', headers: { expect: '100-continue', 'content-length': body.length } });
      let continued = false;
      req.on('continue', () => { continued = true; req.end(body); });
      req.on('response', (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ continued, data: JSON.parse(b) }));
      });
      req.on('error', reject);
    });
    assert.ok(ok.continued);
    assert.strictEqual(ok.data.length, body.length);

    // The origin refuses before the body is sent: the client gets the refusal and never uploads.
    const refused = await new Promise((resolve, reject) => {
      const req = http.request(`${proxyUrl}/p/${siteUrl}/reject-upload`, { method: 'POST', headers: { expect: '100-continue', 'content-length': 10 } });
      let continued = false;
      req.on('continue', () => { continued = true; });
      req.on('response', (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { req.destroy(); resolve({ status: res.statusCode, body: b, continued }); });
      });
      req.on('error', (e) => (e.code === 'ECONNRESET' ? null : reject(e)));
    });
    assert.strictEqual(refused.status, 413);
    assert.strictEqual(refused.body, 'too large');
    assert.strictEqual(refused.continued, false);
  });

  for (const name of ['identity', 'gzip', 'deflate', 'deflate-raw', 'br', 'stacked']) {
    it(`decodes ${name} bodies before rewriting`, async () => {
      const r = await request(`/p/${siteUrl}/enc/${name}`, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
      assert.strictEqual(r.status, 200);
      assert.ok(r.body.includes(`href="/p/${siteUrl}/next"`), r.body);
    });
  }

  it('reports corrupt compressed bodies and salvages truncated ones', async () => {
    const bad = await request(`/p/${siteUrl}/enc/corrupt`);
    assert.strictEqual(bad.status, 502);
    assert.match(bad.body, /Bad response from site/);
    const cut = await request(`/p/${siteUrl}/enc/truncated`);
    assert.strictEqual(cut.status, 200);
    assert.ok(cut.body.includes(`/p/${siteUrl}/next`));
  });

  it('passes unknown content codings through untouched', async () => {
    const r = await request(`/p/${siteUrl}/enc/unknown`, { decode: false });
    assert.strictEqual(r.headers['content-encoding'], 'compress');
    assert.strictEqual(r.body, 'opaque-bytes');
  });

  it('honours a UTF-8 byte order mark over the declared charset', async () => {
    const r = await request(`/p/${siteUrl}/bom-utf8`);
    assert.match(r.headers['content-type'], /charset=utf-8/);
    assert.ok(r.body.includes('<p>café</p>'));
    assert.notStrictEqual(r.buf[0], 0xef, 'the BOM is not duplicated into the output');
    assert.ok(r.body.includes(`/p/${siteUrl}/x`));
  });

  it('decodes UTF-16 documents and serves them as UTF-8', async () => {
    const r = await request(`/p/${siteUrl}/bom-utf16`);
    assert.match(r.headers['content-type'], /charset=utf-8/);
    assert.ok(r.body.includes('naïve ✓'));
    assert.ok(r.body.includes(`/p/${siteUrl}/y`));
  });

  it('keeps legacy encodings byte-for-byte and declares a <meta> charset in the header', async () => {
    const r = await request(`/p/${siteUrl}/meta-sjis`);
    assert.match(r.headers['content-type'], /charset=shift_jis/);
    assert.ok(r.buf.includes(Buffer.from([0x93, 0xfa, 0x96, 0x7b])));
    assert.ok(r.body.includes(`/p/${siteUrl}/z`));
    const css = await request(`/p/${siteUrl}/css-charset`);
    assert.match(css.headers['content-type'], /charset=iso-8859-1/);
    assert.ok(css.buf.includes(Buffer.from([0xe9])));
    assert.ok(css.body.includes(`/p/${siteUrl}/i.png`));
  });

  it('streams HTML above MAX_REWRITE_BYTES untouched, with or without a length', async () => {
    const saved = config.maxRewriteBytes;
    config.maxRewriteBytes = 64 * 1024;
    try {
      const sized = await request(`/p/${siteUrl}/big-html?len=200000`);
      assert.strictEqual(sized.status, 200);
      assert.strictEqual(sized.headers['content-length'], String(sized.buf.length));
      assert.ok(sized.body.includes('href="/far"'), 'not rewritten');
      const chunked = await request(`/p/${siteUrl}/big-html?len=200000&chunked=1`);
      assert.strictEqual(chunked.status, 200);
      assert.strictEqual(chunked.buf.length, 200000 + '<html><body><a href="/far">f</a></body></html>'.length);
      assert.ok(chunked.body.endsWith('<a href="/far">f</a></body></html>'));
      const small = await request(`/p/${siteUrl}/big-html?len=1000&chunked=1`);
      assert.ok(small.body.includes(`/p/${siteUrl}/far`), 'small bodies are still rewritten');
    } finally {
      config.maxRewriteBytes = saved;
    }
  });

  it('never buffers text/event-stream', async () => {
    waiters.sseRelease = deferred();
    const events = await new Promise((resolve, reject) => {
      http.get(`${proxyUrl}/p/${siteUrl}/sse`, { headers: { accept: 'text/event-stream', 'sec-fetch-dest': 'empty' } }, (res) => {
        assert.strictEqual(res.headers['x-accel-buffering'], 'no');
        const got = [];
        res.setEncoding('utf8');
        res.on('data', (c) => {
          got.push(c);
          // The first event arrives while the origin is still holding the stream open.
          if (got.length === 1) waiters.sseRelease.resolve();
        });
        res.on('end', () => resolve(got.join('')));
      }).on('error', reject);
    });
    assert.strictEqual(events, 'data: one\n\ndata: two\n\n');
  });

  it('stores every Set-Cookie header of a response', async () => {
    const first = await request(`/p/${siteUrl}/cookies3`);
    const psid = first.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
    const echo = JSON.parse((await request(`/p/${siteUrl}/echo`, { headers: { cookie: psid } })).body);
    assert.strictEqual(echo.headers.cookie, 'a=1; b=2; c=3');
  });

  it('applies Clear-Site-Data: "cookies" to the jar instead of the proxy origin', async () => {
    const first = await request(`/p/${siteUrl}/cookies3`);
    const psid = first.headers['set-cookie'].find((c) => c.startsWith('__psid=')).split(';')[0];
    const r = await request(`/p/${siteUrl}/clear-site-data`, { headers: { cookie: psid } });
    assert.strictEqual(r.headers['clear-site-data'], undefined, 'it would wipe every proxied site');
    const echo = JSON.parse((await request(`/p/${siteUrl}/echo`, { headers: { cookie: psid } })).body);
    assert.strictEqual(echo.headers.cookie, undefined);
  });

  it('keeps non-ASCII header bytes and decodes UTF-8 Location headers', async () => {
    const r = await request(`/p/${siteUrl}/utf8-header`);
    assert.strictEqual(Buffer.from(r.headers['x-name'], 'latin1').toString('utf8'), 'café ✓');
    assert.strictEqual(r.headers.location, `/p/${siteUrl}/caf%C3%A9/%C3%BC?q=%C3%B6`);
    const echo = JSON.parse((await request(`/p/${siteUrl}/echo`, { headers: { 'x-utf8': Buffer.from('ü').toString('latin1') } })).body);
    assert.strictEqual(Buffer.from(echo.headers['x-utf8'], 'latin1').toString('utf8'), 'ü');
  });

  it('rewrites relative, protocol-relative and fragment Locations and leaves other schemes', async () => {
    const loc = async (to) => (await request(`/p/${siteUrl}/a/loc?to=${encodeURIComponent(to)}`)).headers.location;
    assert.strictEqual(await loc('../up?x=1'), `/p/${siteUrl}/up?x=1`);
    assert.strictEqual(await loc('next'), `/p/${siteUrl}/a/next`);
    assert.strictEqual(await loc('//other.example/x'), '/p/http://other.example/x');
    assert.strictEqual(await loc('/target#section-2'), `/p/${siteUrl}/target#section-2`);
    assert.strictEqual(await loc('https://elsewhere.example/'), '/p/https://elsewhere.example/');
    assert.strictEqual(await loc('myapp://callback?code=1'), 'myapp://callback?code=1');
    assert.strictEqual(await loc('mailto:someone@example.com'), 'mailto:someone@example.com');
  });

  it('rewrites the Refresh header', async () => {
    const rf = async (v) => (await request(`/p/${siteUrl}/refresh?v=${encodeURIComponent(v)}`)).headers.refresh;
    assert.strictEqual(await rf('5; url=/next'), `5; url=/p/${siteUrl}/next`);
    assert.strictEqual(await rf("0;URL='https://example.org/x'"), '0; url=/p/https://example.org/x');
    assert.strictEqual(await rf('3, other'), `3; url=/p/${siteUrl}/other`);
    assert.strictEqual(await rf('10'), '10');
  });

  it('rewrites Link preload hints instead of dropping them', async () => {
    const r = await request(`/p/${siteUrl}/link`);
    assert.strictEqual(r.headers.link,
      `</p/${siteUrl}/app.css>; rel=preload; as=style, </p/https://cdn.example/a,b.js>; rel=modulepreload`);
  });

  it('passes downloads through byte for byte with their Content-Disposition', async () => {
    const r = await request(`/p/${siteUrl}/download`);
    assert.strictEqual(r.body, HTML, 'attachments are not rewritten');
    assert.strictEqual(r.headers['content-disposition'], `attachment; filename="r${Buffer.from('é').toString('latin1')}sum.html"; filename*=UTF-8''r%C3%A9sum.html`);
  });

  it('talks to HTTP/1.0 origins that end bodies by closing', async () => {
    const r = await request(`/p/${http10Url}/`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers['x-old'], 'yes');
    assert.ok(r.body.includes(`/p/${http10Url}/ten`));
  });

  it('handles origins that close the connection early', async () => {
    const html = await request(`/p/${siteUrl}/truncated-html`);
    assert.strictEqual(html.status, 502);
    assert.match(html.body, /Connection interrupted/);
    const bin = await new Promise((resolve) => {
      http.get(`${proxyUrl}/p/${siteUrl}/truncated-bin`, (res) => {
        let n = 0;
        res.on('data', (c) => { n += c.length; });
        res.on('end', () => resolve({ n, complete: res.complete }));
        res.on('error', () => resolve({ n, complete: false }));
        res.on('aborted', () => resolve({ n, complete: false }));
      }).on('error', () => resolve({ n: -1, complete: false }));
    });
    assert.strictEqual(bin.complete, false, 'the truncation reaches the browser instead of a short "complete" body');
  });

  it('cancels the upstream request when the client goes away', async () => {
    waiters.slowClosed = deferred();
    await new Promise((resolve) => {
      const req = http.get(`${proxyUrl}/p/${siteUrl}/slow-stream`, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
    await Promise.race([waiters.slowClosed, new Promise((_, rej) => setTimeout(() => rej(new Error('upstream not cancelled')), 2000).unref())]);

    waiters.uploadClosed = deferred();
    const up = http.request(`${proxyUrl}/p/${siteUrl}/upload-abort`, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } });
    up.on('error', () => {});
    up.write(Buffer.alloc(4096));
    setTimeout(() => up.destroy(), 100);
    await Promise.race([waiters.uploadClosed, new Promise((_, rej) => setTimeout(() => rej(new Error('upload not cancelled')), 2000).unref())]);
    assert.strictEqual(seen.uploadAborted, true);
  });

  it('turns upstream timeouts into a 504 page', async () => {
    const saved = config.upstreamTimeout;
    config.upstreamTimeout = 300;
    try {
      const r = await request(`/p/${siteUrl}/hang`);
      assert.strictEqual(r.status, 504);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.body, /Timed out/);
      const stalled = await request(`/p/${siteUrl}/stall-html`);
      assert.strictEqual(stalled.status, 504);
    } finally {
      config.upstreamTimeout = saved;
    }
  });

  it('retries idempotent requests once on a stale keep-alive connection', async () => {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const a = await request(`/p/${siteUrl}/flaky-keepalive`, { agent });
    const b = await request(`/p/${siteUrl}/flaky-keepalive`, { agent });
    agent.destroy();
    assert.strictEqual(a.body, 'fresh');
    assert.strictEqual(b.status, 200);
    assert.strictEqual(b.body, 'fresh');
  });

  it('labels every response with the real URL', async () => {
    const r = await request(`/p/${siteUrl}/a%20b/c?d=%2F&e=f`);
    assert.strictEqual(r.headers['x-proxied-url'], `${siteUrl}/a%20b/c?d=%2F&e=f`);
  });

  it('rewrites web app manifests', async () => {
    const r = await request(`/p/${siteUrl}/manifest.json`, { headers: { 'sec-fetch-dest': 'manifest' } });
    const m = JSON.parse(r.body);
    assert.strictEqual(m.start_url, `/p/${siteUrl}/start`);
    assert.strictEqual(m.scope, `/p/${siteUrl}/`);
    assert.strictEqual(m.icons[0].src, `/p/${siteUrl}/icon.png`);
    assert.strictEqual(m.shortcuts[0].url, `/p/${siteUrl}/s`);
    assert.strictEqual(m.shortcuts[0].icons[0].src, `/p/${siteUrl}/s.png`);
  });

  it('sniffs untyped documents like a browser would', async () => {
    const doc = await request(`/p/${siteUrl}/no-type-html`, { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } });
    assert.match(doc.body, /data-proxy-runtime/);
    assert.ok(doc.body.includes(`/p/${siteUrl}/q`));
    const bin = await request(`/p/${siteUrl}/no-type-bin`, { headers: { 'sec-fetch-dest': 'document' } });
    assert.deepStrictEqual([...bin.buf], [0, 1, 2, 3, 0x89, 0x50]);
  });

  it('accepts targets with a percent-encoded scheme', async () => {
    const r = await request(`/p/${encodeURIComponent(siteUrl + '/html')}`);
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes(`/p/${siteUrl}/next`));
  });

  it('answers malformed requests with the right status', async () => {
    const send = (data) => new Promise((resolve) => {
      const s = net.connect(new URL(proxyUrl).port, '127.0.0.1', () => s.write(data));
      let out = '';
      s.on('data', (d) => { out += d; });
      s.on('close', () => resolve(out));
      s.on('error', () => resolve(out));
    });
    assert.match(await send('GARBAGE\r\n\r\n'), /^HTTP\/1\.1 400 /);
    assert.match(await send(`GET / HTTP/1.1\r\nHost: x\r\nX-Big: ${'a'.repeat(20000)}\r\n\r\n`), /^HTTP\/1\.1 431 /);
  });

  it('turns a pasted proxy URL back into the site it points at', async () => {
    const r = await request('/__proxy/go?url=' + encodeURIComponent(`${proxyUrl}/p/https://example.com/x?y=1`));
    assert.strictEqual(r.headers.location, '/p/https://example.com/x?y=1');
  });

  it('survives origins that send invalid or unexpected status lines', async () => {
    const lines = {
      '/s099': 'HTTP/1.1 099 Weird\r\nContent-Length: 2\r\n\r\nhi',
      '/s000': 'HTTP/1.1 000 Zero\r\nContent-Length: 2\r\n\r\nhi',
      '/s600': 'HTTP/1.1 600 Six\r\nContent-Type: text/html\r\nContent-Length: 18\r\n\r\n<a href="/x">x</a>',
      '/ctl': 'HTTP/1.1 200 OK\r\nX-Ctl: a\x01b\r\nContent-Length: 2\r\n\r\nhi',
      '/dupcl': 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nhi',
      '/101': 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: foo\r\nConnection: Upgrade\r\n\r\n',
    };
    const odd = net.createServer((sock) => sock.once('data', (d) => sock.end(lines[String(d).split(' ')[1]] || 'HTTP/1.1 404 NF\r\n\r\n')));
    const base = `http://127.0.0.1:${await listen(odd)}`;
    try {
      const status = async (p) => (await request(`/p/${base}${p}`)).status;
      assert.strictEqual(await status('/s099'), 502);
      assert.strictEqual(await status('/s000'), 502);
      const six = await request(`/p/${base}/s600`);
      assert.strictEqual(six.status, 600);
      assert.ok(six.body.includes(`/p/${base}/x`));
      assert.strictEqual(await status('/ctl'), 502);
      assert.strictEqual(await status('/dupcl'), 502);
      assert.strictEqual(await status('/101'), 502);
      assert.strictEqual((await request('/__proxy/health')).status, 200, 'the proxy is still up');
    } finally {
      odd.close();
    }
  });

  it('unwraps proxied URLs that point back at the proxy', async () => {
    const r = await request(`/p/${proxyUrl}/p/${siteUrl}/html`);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.location, `/p/${siteUrl}/html`);
  });
});
