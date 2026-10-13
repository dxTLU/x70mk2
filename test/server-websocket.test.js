'use strict';

// WebSocket tunnelling: negotiation relayed end to end, cookies, refusals, close handling, and
// protection against cross-site socket hijacking.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const net = require('net');
const crypto = require('crypto');
const config = require('../src/config');
const { createServer } = require('../server');

let site, other, proxy, siteUrl, otherUrl, proxyUrl, proxyPort;
let handshakes = [];
const events = [];

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

function onUpgrade(name) {
  return (req, socket, head) => {
    const u = new URL(req.url, 'http://x');
    handshakes.push({ name, path: u.pathname, headers: req.headers });
    socket.on('error', () => {});
    if (u.pathname === '/refuse') {
      return socket.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nSet-Cookie: wsdeny=1; Path=/\r\nContent-Length: 4\r\n\r\nnope');
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    let resp = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n`;
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((s) => s.trim());
    if (protos.includes('superchat')) resp += 'Sec-WebSocket-Protocol: superchat\r\n';
    if (/permessage-deflate/.test(req.headers['sec-websocket-extensions'] || '')) resp += 'Sec-WebSocket-Extensions: permessage-deflate; server_no_context_takeover\r\n';
    resp += 'Set-Cookie: fromws=1; Path=/\r\n';
    socket.write(resp + '\r\n');
    if (head && head.length) socket.write(Buffer.concat([Buffer.from('head:'), head]));
    if (u.pathname === '/hello-bye') {
      socket.end('hello');
    } else {
      socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from(name + ':'), d])));
    }
    socket.on('end', () => {
      events.push(`${name}:end`);
      // Stay half-open like a lax server would and keep writing: once the proxy has really let go
      // of the connection, a write fails and the socket closes.
      const probe = setInterval(() => (socket.destroyed ? clearInterval(probe) : socket.write('late')), 200);
      probe.unref();
    });
    socket.on('close', () => events.push(`${name}:close`));
  };
}

function httpGet(path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(proxyUrl + path, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject);
  });
}

/** Open a raw WebSocket handshake through the proxy; resolves once the response head arrived. */
function connect(path, headers = {}, { early } = {}) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      const h = { Host: `127.0.0.1:${proxyPort}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13', ...headers };
      const head = `GET ${path} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';
      s.write(early ? Buffer.concat([Buffer.from(head), early]) : head);
    });
    let buf = Buffer.alloc(0);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      s.removeListener('data', onData);
      const head = buf.subarray(0, idx).toString('latin1');
      const status = +head.split(' ')[1];
      const headers = {};
      for (const l of head.split('\r\n').slice(1)) headers[l.slice(0, l.indexOf(':')).toLowerCase()] = l.slice(l.indexOf(':') + 1).trim();
      resolve({ socket: s, status, headers, rest: buf.subarray(idx + 4) });
    };
    s.on('data', onData);
    s.on('error', reject);
  });
}

function readUntil(socket, initial, predicate, ms = 2000) {
  return new Promise((resolve, reject) => {
    let buf = initial || Buffer.alloc(0);
    if (predicate(buf)) return resolve(buf);
    const t = setTimeout(() => reject(new Error('timed out with ' + JSON.stringify(buf.toString('latin1')))), ms);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (predicate(buf)) { clearTimeout(t); socket.removeListener('data', onData); resolve(buf); }
    };
    socket.on('data', onData);
  });
}

function waitFor(cond, ms = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('condition not met: ' + JSON.stringify(events)));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('WebSocket tunnel', () => {
  before(async () => {
    const mk = () => http.createServer((req, res) => {
      if (req.url === '/set') {
        res.writeHead(200, { 'set-cookie': 'ws=1; Path=/', 'content-type': 'text/plain' });
        return res.end('ok');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ cookie: req.headers.cookie || '' }));
    });
    site = mk();
    site.on('upgrade', onUpgrade('site'));
    other = mk();
    other.on('upgrade', onUpgrade('other'));
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    otherUrl = `http://127.0.0.2:${await listen(other, '127.0.0.2')}`;
    proxy = createServer();
    proxyPort = await listen(proxy);
    proxyUrl = `http://127.0.0.1:${proxyPort}`;
  });

  after(() => {
    for (const s of [site, other, proxy]) { s.close(); s.closeAllConnections?.(); }
  });

  afterEach(() => {
    handshakes = [];
    config.allowPrivate = true;
  });

  const ws = (base, p) => `/p/${base.replace(/^http/, 'ws')}${p}`;

  it('relays subprotocol and extension negotiation and passes frames untouched', async () => {
    const c = await connect(ws(siteUrl, '/chat'), {
      'Sec-WebSocket-Protocol': 'chat, superchat',
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
    });
    assert.strictEqual(c.status, 101);
    assert.strictEqual(c.headers['sec-websocket-protocol'], 'superchat');
    assert.strictEqual(c.headers['sec-websocket-extensions'], 'permessage-deflate; server_no_context_takeover');
    assert.ok(c.headers['sec-websocket-accept']);
    assert.strictEqual(c.headers['set-cookie'], undefined, 'site cookies never reach the browser');
    const sent = handshakes.at(-1).headers;
    assert.strictEqual(sent['sec-websocket-protocol'], 'chat, superchat');
    assert.strictEqual(sent['sec-websocket-extensions'], 'permessage-deflate; client_max_window_bits');
    // A compressed (RSV1) masked frame: the proxy must not interpret or alter it.
    const frame = Buffer.from([0xc1, 0x85, 1, 2, 3, 4, 9, 8, 7, 6, 5]);
    c.socket.write(frame);
    const got = await readUntil(c.socket, c.rest, (b) => b.length >= 5 + frame.length);
    assert.deepStrictEqual(got.subarray(5), frame);
    assert.strictEqual(got.subarray(0, 5).toString(), 'site:');
    c.socket.destroy();
  });

  it('forwards bytes sent along with the handshake', async () => {
    const c = await connect(ws(siteUrl, '/chat'), {}, { early: Buffer.from('early') });
    const got = await readUntil(c.socket, c.rest, (b) => b.includes('site:early'));
    assert.ok(got.includes('site:early'));
    c.socket.destroy();
  });

  it('sends the session cookies and keeps cookies set by the handshake', async () => {
    const first = await httpGet(`/p/${siteUrl}/set`);
    const psid = first.headers['set-cookie'].find((s) => s.startsWith('__psid=')).split(';')[0];
    const c = await connect(ws(siteUrl, '/chat'), { Cookie: psid });
    assert.strictEqual(c.status, 101);
    assert.strictEqual(handshakes.at(-1).headers.cookie, 'ws=1');
    c.socket.destroy();
    const echo = JSON.parse((await httpGet(`/p/${siteUrl}/echo`, { cookie: psid })).body);
    assert.strictEqual(echo.cookie, 'ws=1; fromws=1');
  });

  it('sends the page origin when it can tell, and the socket origin otherwise', async () => {
    const plain = await connect(ws(siteUrl, '/chat'));
    assert.strictEqual(handshakes.at(-1).headers.origin, siteUrl);
    plain.socket.destroy();
    const sameSitePage = `http://127.0.0.1:1`;
    const viaLast = await connect(ws(siteUrl, '/chat'), { Cookie: `__plast=${encodeURIComponent(sameSitePage)}` });
    assert.strictEqual(handshakes.at(-1).headers.origin, sameSitePage, 'the last page on the same site');
    viaLast.socket.destroy();
    const crossLast = await connect(ws(siteUrl, '/chat'), { Cookie: `__plast=${encodeURIComponent(otherUrl)}` });
    assert.strictEqual(handshakes.at(-1).headers.origin, siteUrl, 'never another site\'s origin');
    crossLast.socket.destroy();
    const withRef = await connect(ws(otherUrl, '/chat'), { Referer: `${proxyUrl}/p/${siteUrl}/page` });
    assert.strictEqual(handshakes.at(-1).headers.origin, siteUrl);
    withRef.socket.destroy();
  });

  it('relays a refused upgrade with its status and body', async () => {
    const first = await httpGet(`/p/${siteUrl}/set`);
    const psid = first.headers['set-cookie'].find((s) => s.startsWith('__psid=')).split(';')[0];
    const c = await connect(ws(siteUrl, '/refuse'), { Cookie: psid });
    assert.strictEqual(c.status, 403);
    assert.strictEqual(c.headers['content-type'], 'text/plain');
    const body = await readUntil(c.socket, c.rest, (b) => b.length >= 4);
    assert.strictEqual(body.toString(), 'nope');
    c.socket.destroy();
    const echo = JSON.parse((await httpGet(`/p/${siteUrl}/echo`, { cookie: psid })).body);
    assert.match(echo.cookie, /wsdeny=1/);
  });

  it('cleans up both sides when the browser half-closes', async () => {
    events.length = 0;
    const c = await connect(ws(siteUrl, '/chat'));
    c.socket.write('bye');
    await readUntil(c.socket, c.rest, (b) => b.includes('site:bye'));
    let clientClosed = false;
    c.socket.on('close', () => { clientClosed = true; });
    c.socket.resume();
    c.socket.end();
    // The FIN reaches the server, and after a short grace period for the closing handshake both
    // connections are gone even though the server never closed its half.
    await waitFor(() => events.includes('site:end') && events.includes('site:close') && clientClosed);
  });

  it('closes the browser side when the server finishes', async () => {
    const c = await connect(ws(siteUrl, '/hello-bye'));
    let ended = false;
    c.socket.on('end', () => { ended = true; });
    const got = await readUntil(c.socket, c.rest, (b) => b.includes('hello'));
    assert.ok(got.includes('hello'));
    await waitFor(() => ended || c.socket.destroyed);
    c.socket.destroy();
  });

  it('refuses sockets opened by pages outside the proxy', async () => {
    const evil = await connect(ws(siteUrl, '/chat'), { Origin: 'https://evil.example' });
    assert.strictEqual(evil.status, 403);
    evil.socket.destroy();
    assert.strictEqual(handshakes.length, 0);
    const own = await connect(ws(siteUrl, '/chat'), { Origin: proxyUrl });
    assert.strictEqual(own.status, 101);
    own.socket.destroy();
    const sandboxed = await connect(ws(siteUrl, '/chat'), { Origin: 'null' });
    assert.strictEqual(sandboxed.status, 101);
    sandboxed.socket.destroy();
  });

  it('routes stray socket URLs to the last visited site', async () => {
    const c = await connect('/socket.io/?EIO=4', { Cookie: `__plast=${encodeURIComponent(siteUrl)}` });
    assert.strictEqual(c.status, 101);
    assert.strictEqual(handshakes.at(-1).path, '/socket.io/');
    c.socket.destroy();
    const lost = await connect('/socket.io/?EIO=4');
    assert.strictEqual(lost.status, 400);
    lost.socket.destroy();
  });

  it('rejects other upgrades, blocked targets and dead origins', async () => {
    const h2c = await connect(ws(siteUrl, '/chat'), { Upgrade: 'h2c' });
    assert.strictEqual(h2c.status, 400);
    h2c.socket.destroy();
    config.allowPrivate = false;
    const blocked = await connect(ws(siteUrl, '/chat'));
    assert.strictEqual(blocked.status, 403);
    blocked.socket.destroy();
    config.allowPrivate = true;
    const dead = await connect('/p/ws://127.0.0.1:1/chat');
    assert.strictEqual(dead.status, 502);
    dead.socket.destroy();
  });
});
