'use strict';

// The Varnish front end, for real: varnishd running varnish/default.vcl in front of `node server.js`
// in front of a local fixture site, started the way scripts/start.sh starts them. Skipped when
// varnishd is not installed. Everything listens on ephemeral ports (never 8080/6081) and the VCL
// is a temporary copy pointing at this test's app.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const VCL = path.join(ROOT, 'varnish', 'default.vcl');
const PARAMS = path.join(ROOT, 'varnish', 'varnishd.params');
// Same flags as scripts/start.sh: proxied URLs are long.
const NODE_FLAGS = ['--max-http-header-size=65536'];

function findBinary(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).concat(['/usr/sbin', '/usr/local/sbin', '/sbin']);
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch { /* keep looking */ }
  }
  return null;
}

/** varnish/varnishd.params as [name, value] pairs. */
function readParams() {
  return fs.readFileSync(PARAMS, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]);
}

const VARNISHD = findBinary('varnishd');

// ---- deployment files agree with each other (no varnishd needed) ---------------------------

describe('Varnish deployment configuration', () => {
  it('lists runtime parameters as name=value lines', () => {
    const params = readParams();
    assert.ok(params.length >= 5);
    for (const [k, v] of params) assert.match(`${k}=${v}`, /^[a-z_0-9]+=\S+$/);
    const names = params.map(([k]) => k);
    for (const k of ['http_req_hdr_len', 'http_req_size', 'workspace_client', 'send_timeout', 'pipe_timeout']) {
      assert.ok(names.includes(k), k);
    }
  });

  it('uses the same parameters in the systemd drop-in and docker-compose.yml', () => {
    const files = [path.join(ROOT, 'deploy', 'varnish.service.d', 'override.conf'), path.join(ROOT, 'docker-compose.yml')];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const [k, v] of readParams()) {
        assert.ok(text.includes(`${k}=${v}`), `${path.relative(ROOT, file)} is missing ${k}=${v}`);
      }
      assert.ok(text.includes('default.vcl'), `${path.relative(ROOT, file)} does not load our VCL`);
    }
  });

  it('points the VCL at the app on 127.0.0.1:8080 with a health probe', () => {
    const vcl = fs.readFileSync(VCL, 'utf8');
    assert.match(vcl, /^vcl 4\.1;/m);
    assert.match(vcl, /\.host = "127\.0\.0\.1";/);
    assert.match(vcl, /\.port = "8080";/);
    assert.match(vcl, /\.url = "\/__proxy\/health";/);
  });

  it('ships executable start/stop scripts', () => {
    for (const name of ['start.sh', 'stop.sh', 'start-node-only.sh']) {
      const file = path.join(ROOT, 'scripts', name);
      const st = fs.statSync(file);
      assert.ok(st.mode & 0o111, `${name} is not executable`);
      assert.match(fs.readFileSync(file, 'utf8'), /^#!\/usr\/bin\/env bash\n/);
      if (findBinary('bash')) {
        const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
        assert.strictEqual(r.status, 0, `${name}: ${r.stderr}`);
      }
    }
    for (const name of ['start.ps1', 'start.cmd']) assert.ok(fs.existsSync(path.join(ROOT, 'scripts', name)), name);
  });
});

// ---- the real stack ---------------------------------------------------------------------------

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f1a0c50000000049454e44ae426082', 'hex');
const CLIP = crypto.randomBytes(1 << 20); // a small "video", cacheable
const BIG = 80 * 1024 * 1024; // larger than the cache storage this test gives Varnish
const CHUNK = Buffer.alloc(1 << 20, 0x61);

// Image-like fixtures: path -> extra response headers.
const IMAGES = {
  '/static/logo.png': { 'cache-control': 'public, max-age=600' },
  '/static/plain.png': {},
  '/static/head.png': { 'cache-control': 'max-age=600' },
  '/static/user.png': { 'cache-control': 'max-age=600' },
  '/static/purge.png': { 'cache-control': 'max-age=600' },
  '/static/down.png': { 'cache-control': 'max-age=600' },
  '/static/auth.png': { 'cache-control': 'max-age=600' },
  '/asset': { 'cache-control': 'max-age=600' },
  '/private.png': { 'cache-control': 'private, max-age=600' },
  '/nostore.png': { 'cache-control': 'no-store' },
  '/nocache.png': { 'cache-control': 'no-cache' },
  '/maxage0.png': { 'cache-control': 'max-age=0' },
  '/varycookie.png': { 'cache-control': 'max-age=600', vary: 'Cookie' },
  '/setcookie.png': { 'cache-control': 'max-age=600', 'set-cookie': 'track=1; Path=/' },
  '/attachment.png': { 'cache-control': 'max-age=600', 'content-disposition': 'attachment; filename="x.png"' },
};

describe('Varnish in front of the app', { skip: VARNISHD ? false : 'varnishd is not installed' }, () => {
  const hits = new Map(); // origin path -> requests that reached the origin
  const last = new Map(); // origin path -> last request seen there
  let tmp, origin, originPort, app, appPort, varnish, varnishPort, proxyProtoPort;
  let appLog = '', varnishLog = '';
  let O; // the fixture origin as seen by the proxy, e.g. http://127.0.0.1:1234

  // -- fixture origin ---------------------------------------------------------------------------

  function originHandler(req, res) {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    hits.set(p, (hits.get(p) || 0) + 1);
    last.set(p, { method: req.method, headers: req.headers, url: req.url });
    const cookie = req.headers.cookie || '';

    if (IMAGES[p]) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length, ...IMAGES[p] });
      return res.end(req.method === 'HEAD' ? undefined : PNG);
    }
    switch (p) {
      case '/page': {
        const who = /(?:^|;\s*)user=([^;]*)/.exec(cookie);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=600' });
        return res.end(`<!doctype html><html><head><title>page</title></head><body><p id="who">${who ? who[1] : 'anonymous'}</p></body></html>`);
      }
      case '/login':
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': `user=${u.searchParams.get('name')}; Path=/` });
        return res.end('ok');
      case '/soft404.png':
        res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'max-age=600' });
        return res.end('<p>not an image</p>');
      case '/redirect.png':
        res.writeHead(302, { location: '/static/logo.png', 'cache-control': 'max-age=600' });
        return res.end();
      case '/missing.png':
        res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'max-age=600' });
        return res.end('missing');
      case '/redirect':
        res.writeHead(302, { location: '/landing' });
        return res.end();
      case '/app.css':
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'max-age=600' });
        return res.end(`.logo{background:url(/static/logo.png)}${' '.repeat(2048)}`);
      case '/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'max-age=600' });
        return res.end('var here = location.href;');
      case '/short.css':
        if (req.headers['if-none-match'] === '"v1"') {
          res.writeHead(304, { etag: '"v1"', 'cache-control': 'max-age=1' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/css', etag: '"v1"', 'cache-control': 'max-age=1' });
        return res.end('.short{background:url(/static/logo.png)}');
      case '/static/clip.mp4':
      case '/video.mp4': {
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        const headers = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'max-age=600' };
        if (range) {
          const start = +range[1];
          const end = range[2] ? Math.min(+range[2], CLIP.length - 1) : CLIP.length - 1;
          res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${CLIP.length}`, 'content-length': end - start + 1 });
          return res.end(CLIP.subarray(start, end + 1));
        }
        res.writeHead(200, { ...headers, 'content-length': CLIP.length });
        return res.end(CLIP);
      }
      case '/events':
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('data: one\n\n');
        setTimeout(() => res.end('data: two\n\n'), 1500);
        return;
      case '/download/big.mp4': {
        // Known length, bigger than the cache: the first megabyte, a pause, then the rest.
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': BIG, 'cache-control': 'max-age=600' });
        res.write(CHUNK);
        let sent = CHUNK.length;
        const pump = () => {
          while (sent < BIG) {
            sent += CHUNK.length;
            if (!res.write(CHUNK)) return res.once('drain', pump);
          }
          res.end();
        };
        setTimeout(pump, 500);
        return;
      }
      case '/download/stream.webm': {
        // Unknown length (chunked) media: must stream through, not be stored.
        res.writeHead(200, { 'content-type': 'video/webm', 'cache-control': 'max-age=600' });
        let left = 40;
        const pump = () => {
          while (left-- > 0) if (!res.write(CHUNK)) return res.once('drain', pump);
          res.end();
        };
        pump();
        return;
      }
      case '/echo': {
        const h = crypto.createHash('sha256');
        let length = 0;
        req.on('data', (c) => { h.update(c); length += c.length; });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=600' });
          res.end(JSON.stringify({ method: req.method, length, sha256: h.digest('hex') }));
        });
        return;
      }
      case '/long':
        res.writeHead(200, { 'content-type': 'text/plain' });
        return res.end(String(req.url.length));
      default:
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
    }
  }

  // A minimal WebSocket echo server: unmasked text frames back, prefixed with "echo:".
  function originUpgrade(req, socket) {
    socket.on('error', () => {});
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (let f; (f = readFrame(buf));) {
        buf = f.rest;
        if (f.opcode === 8) return socket.end(Buffer.from([0x88, 0]));
        socket.write(serverFrame('echo:' + f.text));
      }
    });
  }

  // -- helpers -------------------------------------------------------------------------------------

  function freePort() {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.on('error', reject);
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address();
        s.close(() => resolve(port));
      });
    });
  }

  function request(urlPath, { port = varnishPort, method = 'GET', headers = {}, body, createConnection } = {}) {
    return new Promise((resolve, reject) => {
      // Big limit: the app echoes the (long) target URL in X-Proxied-URL.
      const opts = { host: '127.0.0.1', port, path: urlPath, method, headers, maxHeaderSize: 256 * 1024 };
      // createConnection is only used without an agent.
      if (createConnection) opts.createConnection = createConnection; else opts.agent = false;
      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const raw = buf;
          if (res.headers['content-encoding'] === 'gzip' && buf.length) buf = zlib.gunzipSync(buf);
          resolve({ status: res.statusCode, headers: res.headers, body: buf, raw, text: buf.toString('utf8') });
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  /** A request arriving through the PROXY-protocol listener from a remote client address. */
  function remote(urlPath, opts = {}) {
    return request(urlPath, {
      ...opts,
      port: proxyProtoPort,
      createConnection: () => {
        const s = net.connect(proxyProtoPort, '127.0.0.1');
        s.write(`PROXY TCP4 203.0.113.7 127.0.0.1 40000 ${proxyProtoPort}\r\n`);
        return s;
      },
    });
  }

  const p = (pathname) => `/p/${O}${pathname}`;
  const session = () => `__psid=${crypto.randomBytes(18).toString('base64url')}`;
  const IMG = (cookie, extra = {}) => ({ cookie, 'sec-fetch-dest': 'image', 'sec-fetch-mode': 'no-cors', 'sec-fetch-site': 'same-origin', ...extra });
  const DOC = (cookie, extra = {}) => ({ ...(cookie ? { cookie } : {}), 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...extra });
  const count = (pathname) => hits.get(pathname) || 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitHttp(port, pathname, ms, proc, what) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (proc.exitCode !== null || proc.signalCode) return reject(new Error(`${what} exited early:\n${what === 'varnishd' ? varnishLog : appLog}`));
        http.get({ host: '127.0.0.1', port, path: pathname, agent: false }, (res) => {
          res.resume();
          if (res.statusCode === 200) return resolve();
          retry();
        }).on('error', retry);
      };
      const retry = () => {
        if (Date.now() - start > ms) return reject(new Error(`${what} did not become ready:\n${what === 'varnishd' ? varnishLog : appLog}`));
        setTimeout(attempt, 100);
      };
      attempt();
    });
  }

  function stop(proc) {
    return new Promise((resolve) => {
      if (!proc || proc.exitCode !== null || proc.signalCode) return resolve();
      const kill = setTimeout(() => proc.kill('SIGKILL'), 5000);
      proc.once('exit', () => { clearTimeout(kill); resolve(); });
      proc.kill('SIGTERM');
    });
  }

  const killAll = () => {
    for (const proc of [varnish, app]) {
      try { if (proc && proc.exitCode === null) proc.kill('SIGKILL'); } catch { /* gone */ }
    }
  };

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-varnish-test-'));
    process.on('exit', killAll);

    origin = http.createServer(originHandler);
    origin.on('upgrade', originUpgrade);
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    originPort = origin.address().port;
    O = `http://127.0.0.1:${originPort}`;

    appPort = await freePort();
    const env = {
      ...process.env,
      PORT: String(appPort), HOST: '127.0.0.1', PERSIST_SESSIONS: '0', ALLOW_PRIVATE: '1',
      UPSTREAM_PROXY: '', HTTPS_PROXY: '', HTTP_PROXY: '', https_proxy: '', http_proxy: '', NO_PROXY: '', no_proxy: '',
      BASIC_AUTH: '', TLS_CERT: '', TLS_KEY: '', TRUST_PROXY: '1', LOG_REQUESTS: '0', NODE_ENV: 'production',
    };
    app = spawn(process.execPath, [...NODE_FLAGS, path.join(ROOT, 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    app.stdout.on('data', (d) => { appLog += d; });
    app.stderr.on('data', (d) => { appLog += d; });
    await waitHttp(appPort, '/__proxy/health', 15000, app, 'node server.js');

    const vcl = fs.readFileSync(VCL, 'utf8');
    const testVcl = vcl.replace(/(\.port\s*=\s*)"8080"/, `$1"${appPort}"`);
    assert.notStrictEqual(testVcl, vcl, 'backend port not found in the VCL');
    fs.writeFileSync(path.join(tmp, 'test.vcl'), testVcl);

    varnishPort = await freePort();
    proxyProtoPort = await freePort();
    const params = readParams().flatMap(([k, v]) => ['-p', `${k}=${v}`]);
    varnish = spawn(VARNISHD, [
      '-F', '-j', 'none', '-n', path.join(tmp, 'work'),
      '-a', `127.0.0.1:${varnishPort}`, '-a', `proxied=127.0.0.1:${proxyProtoPort},PROXY`,
      '-T', 'none', '-f', path.join(tmp, 'test.vcl'), '-s', 'malloc,64m', ...params,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    varnish.stdout.on('data', (d) => { varnishLog += d; });
    varnish.stderr.on('data', (d) => { varnishLog += d; });
    await waitHttp(varnishPort, '/__proxy/health', 30000, varnish, 'varnishd');
  });

  after(async () => {
    await stop(varnish);
    await stop(app);
    process.removeListener('exit', killAll);
    if (origin) {
      origin.closeAllConnections?.();
      await new Promise((resolve) => origin.close(resolve));
    }
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  // -- documents ---------------------------------------------------------------------------------

  it('never caches documents, even when the origin says public', async () => {
    const a = session();
    const before = count('/page');
    for (let i = 0; i < 2; i++) {
      const r = await request(p('/page'), { headers: DOC(a) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.headers['x-cache'], 'PASS');
      assert.match(r.text, /data-proxy-runtime/);
    }
    // Without fetch metadata (old browsers, curl) a document URL still goes to the app.
    const plain = await request(p('/page'), { headers: { cookie: a } });
    assert.strictEqual(plain.headers['x-cache'], 'PASS');
    assert.strictEqual(count('/page') - before, 3);
    // A navigation to a static-looking URL is still a document.
    const nav = await request(p('/static/logo.png'), { headers: DOC(a) });
    assert.strictEqual(nav.headers['x-cache'], 'PASS');
  });

  it('keeps every session\'s documents and cookies to itself', async () => {
    const alice = session();
    const bob = session();
    const login = await request(p('/login?name=alice'), { headers: DOC(alice) });
    assert.strictEqual(login.status, 200);
    assert.strictEqual(login.headers['set-cookie'], undefined, 'site cookies stay in the server-side jar');
    const a1 = await request(p('/page'), { headers: DOC(alice) });
    const b1 = await request(p('/page'), { headers: DOC(bob) });
    const a2 = await request(p('/page'), { headers: DOC(alice) });
    assert.match(a1.text, /<p id="who">alice<\/p>/);
    assert.match(b1.text, /<p id="who">anonymous<\/p>/);
    assert.match(a2.text, /<p id="who">alice<\/p>/);
    assert.doesNotMatch(b1.text, /alice/);
  });

  it('serves the home page and proxy endpoints fresh from the app', async () => {
    for (const url of ['/', '/__proxy/home', '/__proxy/health', '/__proxy/client.js']) {
      const r = await request(url);
      assert.strictEqual(r.status, 200, url);
      assert.strictEqual(r.headers['x-cache'], 'PASS', url);
    }
    // document.cookie sync: written and read back through Varnish, never cached.
    const s = session();
    const target = encodeURIComponent(`${O}/page`);
    const headers = { cookie: s, referer: `http://127.0.0.1:${varnishPort}${p('/page')}`, 'sec-fetch-site': 'same-origin' };
    const set = await request(`/__proxy/cookie?url=${target}`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain' }, body: 'theme=dark; Path=/' });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.headers['x-cache'], 'PASS');
    for (let i = 0; i < 2; i++) {
      const get = await request(`/__proxy/cookie?url=${target}`, { headers });
      assert.strictEqual(get.headers['x-cache'], 'PASS');
      assert.match(get.text, /theme=dark/);
    }
    const other = await request(`/__proxy/cookie?url=${target}`, { headers: { ...headers, cookie: session() } });
    assert.doesNotMatch(other.text, /theme=dark/);
  });

  // -- static assets ------------------------------------------------------------------------------

  it('caches static assets by fetch destination and by extension', async () => {
    const s = session();
    const cases = [
      ['/static/logo.png', IMG(s)],
      ['/static/plain.png', IMG(s)], // no freshness information at all
      ['/asset', IMG(s)], // no extension: the destination says it is an image
      ['/static/logo.png', { cookie: s }], // no fetch metadata: the extension says so
    ];
    for (const [pathname, headers] of cases) {
      const before = count(pathname);
      const r1 = await request(p(pathname), { headers });
      const r2 = await request(p(pathname), { headers: { ...headers, cookie: session() } });
      assert.strictEqual(r1.status, 200);
      assert.ok(r1.body.equals(PNG) && r2.body.equals(PNG), pathname);
      assert.strictEqual(r2.headers['x-cache'], 'HIT', `${pathname} ${JSON.stringify(headers)}`);
      assert.strictEqual(count(pathname) - before, r1.headers['x-cache'] === 'HIT' ? 0 : 1);
      assert.strictEqual(r2.headers['x-proxy-private'], undefined);
      assert.strictEqual(r2.headers['x-url'], undefined);
    }
    // Without a destination or a static extension a URL is not assumed to be static.
    const r = await request(p('/asset'), { headers: { cookie: s } });
    assert.strictEqual(r.headers['x-cache'], 'PASS');
  });

  it('caches rewritten stylesheets and scripts per destination, compressed or not', async () => {
    const s = session();
    const css1 = await request(p('/app.css'), { headers: { cookie: s, 'sec-fetch-dest': 'style', 'accept-encoding': 'gzip' } });
    const css2 = await request(p('/app.css'), { headers: { cookie: s, 'sec-fetch-dest': 'style', 'accept-encoding': 'gzip' } });
    const css3 = await request(p('/app.css'), { headers: { cookie: s, 'sec-fetch-dest': 'style' } });
    assert.strictEqual(css2.headers['x-cache'], 'HIT');
    assert.strictEqual(css3.headers['x-cache'], 'HIT');
    assert.strictEqual(css2.headers['content-encoding'], 'gzip');
    assert.strictEqual(css3.headers['content-encoding'], undefined, 'gunzipped for clients without gzip');
    for (const r of [css1, css2, css3]) assert.match(r.text, new RegExp(`url\\(["']?/p/${O.replace(/[.:/]/g, '\\$&')}/static/logo\\.png`));
    assert.strictEqual(count('/app.css'), 1);

    const js1 = await request(p('/app.js'), { headers: { cookie: s, 'sec-fetch-dest': 'script' } });
    const js2 = await request(p('/app.js'), { headers: { cookie: s, 'sec-fetch-dest': 'script' } });
    assert.strictEqual(js2.headers['x-cache'], 'HIT');
    assert.match(js1.text, /__pLocation/);
    assert.strictEqual(js1.text, js2.text);
    // Another destination is another representation.
    const js3 = await request(p('/app.js'), { headers: { cookie: s, 'sec-fetch-dest': 'empty' } });
    assert.strictEqual(js3.headers['x-cache'], 'MISS');
  });

  it('caches the versioned runtime script but not the unversioned one', async () => {
    const page = await request(p('/page'), { headers: DOC(session()) });
    const src = /<script src="(\/__proxy\/client\.js\?v=[^"]+)"/.exec(page.text);
    assert.ok(src, 'runtime script tag');
    const r1 = await request(src[1], { headers: { 'sec-fetch-dest': 'script', 'accept-encoding': 'gzip' } });
    const r2 = await request(src[1], { headers: { 'sec-fetch-dest': 'script', 'accept-encoding': 'gzip' } });
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.headers['x-cache'], 'HIT');
    assert.ok(r2.text.length > 10000);
    const plain = await request('/__proxy/client.js', { headers: { 'sec-fetch-dest': 'script' } });
    assert.strictEqual(plain.headers['x-cache'], 'PASS');
  });

  async function neverCached(pathname, headers) {
    const before = count(pathname);
    for (let i = 0; i < 3; i++) {
      const r = await request(p(pathname), { headers });
      assert.strictEqual(r.status, 200, pathname);
      assert.notStrictEqual(r.headers['x-cache'], 'HIT', pathname);
    }
    assert.strictEqual(count(pathname) - before, 3, pathname);
  }

  it('never caches private, no-store, no-cache, max-age=0, Vary: Cookie or attachment responses', async () => {
    const s = session();
    for (const pathname of ['/private.png', '/nostore.png', '/nocache.png', '/maxage0.png', '/varycookie.png', '/attachment.png']) {
      await neverCached(pathname, IMG(s));
    }
  });

  // The app keeps site cookies in its server-side jar and strips Set-Cookie, so only the app can
  // tell the cache that the origin set one (X-Proxy-Private). Other sessions served a cached copy
  // would never receive that cookie.
  it('never caches assets whose origin response set a cookie', async () => {
    await neverCached('/setcookie.png', IMG(session()));
  });

  it('never caches HTML, redirects or errors served for asset URLs', async () => {
    const s = session();
    for (const pathname of ['/soft404.png', '/redirect.png', '/missing.png']) {
      const before = count(pathname);
      for (let i = 0; i < 2; i++) {
        const r = await request(p(pathname), { headers: IMG(s) });
        assert.notStrictEqual(r.headers['x-cache'], 'HIT', pathname);
      }
      assert.strictEqual(count(pathname) - before, 2, pathname);
    }
  });

  it('does not share assets fetched with the user\'s cookies (X-Proxy-Private)', async () => {
    const alice = session();
    await request(p('/login?name=carol'), { headers: DOC(alice) });
    const before = count('/static/user.png');
    for (let i = 0; i < 2; i++) {
      const r = await request(p('/static/user.png'), { headers: IMG(alice) });
      assert.strictEqual(r.status, 200);
      assert.notStrictEqual(r.headers['x-cache'], 'HIT');
      assert.strictEqual(r.headers['x-proxy-private'], undefined, 'internal marker is stripped');
    }
    assert.strictEqual(count('/static/user.png') - before, 2);
    assert.match(last.get('/static/user.png').headers.cookie || '', /user=carol/);
  });

  it('keys cached copies on the Authorization header (BASIC_AUTH gate)', async () => {
    const s = session();
    await request(p('/static/auth.png'), { headers: IMG(s) });
    assert.strictEqual((await request(p('/static/auth.png'), { headers: IMG(s) })).headers['x-cache'], 'HIT');
    const other = await request(p('/static/auth.png'), { headers: IMG(s, { authorization: 'Basic dXNlcjpwYXNz' }) });
    assert.strictEqual(other.headers['x-cache'], 'MISS');
  });

  it('refreshes expired assets with conditional requests', async () => {
    const s = session();
    const h = { cookie: s, 'sec-fetch-dest': 'style' };
    const first = await request(p('/short.css'), { headers: h });
    assert.strictEqual(first.status, 200);
    await sleep(1300);
    const stale = await request(p('/short.css'), { headers: h });
    assert.strictEqual(stale.status, 200);
    assert.strictEqual(stale.text, first.text);
    await sleep(300);
    const fresh = await request(p('/short.css'), { headers: h });
    assert.strictEqual(fresh.headers['x-cache'], 'HIT');
    assert.strictEqual(fresh.text, first.text);
    assert.ok(fresh.text.includes(`/p/${O}/static/logo.png`));
    assert.strictEqual(last.get('/short.css').headers['if-none-match'], '"v1"', 'Varnish revalidated through the app');
  });

  it('answers HEAD without downloading the file, and from the cache once it is there', async () => {
    const s = session();
    const head = await request(p('/static/head.png'), { method: 'HEAD', headers: IMG(s) });
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers['x-cache'], 'PASS');
    assert.strictEqual(last.get('/static/head.png').method, 'HEAD');
    await request(p('/static/head.png'), { headers: IMG(s) });
    const cached = await request(p('/static/head.png'), { method: 'HEAD', headers: IMG(s) });
    assert.strictEqual(cached.headers['x-cache'], 'HIT');
    assert.strictEqual(+cached.headers['content-length'], PNG.length);
  });

  // -- streaming -------------------------------------------------------------------------------

  it('passes Range requests to the origin and serves ranges of cached media', async () => {
    const s = session();
    const media = { cookie: s, 'sec-fetch-dest': 'video', 'sec-fetch-mode': 'no-cors' };
    // Seeking in media that is not cached: the origin answers the range.
    const seek = await request(p('/video.mp4'), { headers: { ...media, range: 'bytes=500000-500099' } });
    assert.strictEqual(seek.status, 206);
    assert.strictEqual(seek.headers['content-range'], `bytes 500000-500099/${CLIP.length}`);
    assert.ok(seek.body.equals(CLIP.subarray(500000, 500100)));
    assert.strictEqual(last.get('/video.mp4').headers.range, 'bytes=500000-500099');
    const open = await request(p('/video.mp4'), { headers: { ...media, range: 'bytes=0-' } });
    assert.strictEqual(open.status, 206);
    assert.ok(open.body.equals(CLIP));

    // Once the whole file is cached, Varnish slices it itself.
    const full = await request(p('/static/clip.mp4'), { headers: media });
    assert.ok(full.body.equals(CLIP));
    const before = count('/static/clip.mp4');
    const part = await request(p('/static/clip.mp4'), { headers: { ...media, range: 'bytes=100-199' } });
    assert.strictEqual(part.status, 206);
    assert.strictEqual(part.headers['x-cache'], 'HIT');
    assert.ok(part.body.equals(CLIP.subarray(100, 200)));
    assert.strictEqual(count('/static/clip.mp4'), before);
  });

  for (const accept of ['text/event-stream', null]) {
    it(`streams server-sent events without buffering${accept ? '' : ' (no Accept header)'}`, async () => {
      const headers = { cookie: session(), 'sec-fetch-dest': 'empty' };
      if (accept) headers.accept = accept;
      const events = await new Promise((resolve, reject) => {
        const got = [];
        const started = Date.now();
        http.get({ host: '127.0.0.1', port: varnishPort, path: p('/events'), headers, agent: false }, (res) => {
          assert.strictEqual(res.statusCode, 200);
          assert.match(res.headers['content-type'], /^text\/event-stream/);
          assert.strictEqual(res.headers['content-encoding'], undefined);
          res.setEncoding('utf8');
          res.on('data', (d) => got.push([Date.now() - started, d]));
          res.on('end', () => resolve(got));
        }).on('error', reject);
      });
      const text = events.map((e) => e[1]).join('');
      assert.strictEqual(text, 'data: one\n\ndata: two\n\n');
      // The first event arrived well before the origin sent the second one.
      assert.ok(events[0][1].startsWith('data: one'), JSON.stringify(events));
      assert.ok(events[0][0] < 1000, `first event after ${events[0][0]}ms`);
      assert.ok(events.at(-1)[0] >= 1400, JSON.stringify(events));
    });
  }

  it('streams large downloads without storing them', async () => {
    const s = session();
    for (const [pathname, size] of [['/download/big.mp4', BIG], ['/download/stream.webm', 40 * CHUNK.length]]) {
      const before = count(pathname);
      for (let i = 0; i < 2; i++) {
        const { bytes, firstByteAt, endAt } = await new Promise((resolve, reject) => {
          const started = Date.now();
          let bytes = 0;
          let firstByteAt = null;
          http.get({ host: '127.0.0.1', port: varnishPort, path: p(pathname), headers: { cookie: s }, agent: false }, (res) => {
            assert.strictEqual(res.statusCode, 200);
            res.on('data', (c) => {
              if (firstByteAt === null) firstByteAt = Date.now() - started;
              bytes += c.length;
            });
            res.on('end', () => resolve({ bytes, firstByteAt, endAt: Date.now() - started }));
            res.on('error', reject);
          }).on('error', reject);
        });
        assert.strictEqual(bytes, size, pathname);
        if (pathname === '/download/big.mp4') {
          // The origin pauses for 500ms after the first megabyte: bytes must flow before that.
          assert.ok(firstByteAt < 450 && endAt >= 500, `first byte ${firstByteAt}ms, end ${endAt}ms`);
        }
      }
      assert.strictEqual(count(pathname) - before, 2, `${pathname} is not cached`);
    }
  });

  it('passes POST, PUT, PATCH, DELETE and unusual methods with their bodies', async () => {
    const s = session();
    const body = crypto.randomBytes(3 * 1024 * 1024 + 7);
    const sha256 = crypto.createHash('sha256').update(body).digest('hex');
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const r = await request(p('/echo'), { method, body, headers: { cookie: s, 'content-type': 'application/octet-stream', 'content-length': body.length } });
      assert.strictEqual(r.status, 200, method);
      assert.strictEqual(r.headers['x-cache'], 'PASS');
      assert.deepStrictEqual(JSON.parse(r.text), { method, length: body.length, sha256 });
    }
    for (const method of ['DELETE', 'OPTIONS', 'PROPFIND']) {
      const r = await request(p('/echo'), { method, headers: { cookie: s } });
      assert.strictEqual(r.status, 200, method);
      assert.strictEqual(JSON.parse(r.text).method, method);
    }
    // Not a forward proxy (node's client cannot read a CONNECT answer, so speak HTTP by hand).
    const socket = net.connect(varnishPort, '127.0.0.1');
    socket.write('CONNECT 127.0.0.1:443 HTTP/1.1\r\nHost: 127.0.0.1:443\r\n\r\n');
    const answer = await readUntil(socket, Buffer.alloc(0), (b) => b.includes('\r\n'));
    socket.destroy();
    assert.match(answer.toString('latin1'), /^HTTP\/1\.1 405 /);
  });

  it('accepts long proxied URLs and Referers', async () => {
    const q = 'x'.repeat(24 * 1024);
    const r = await request(p(`/long?q=${q}`), {
      headers: { cookie: session(), referer: `http://127.0.0.1:${varnishPort}${p(`/page?r=${q}`)}`, 'sec-fetch-dest': 'empty' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.text, String(`/long?q=${q}`.length));
  });

  // -- WebSockets ------------------------------------------------------------------------------

  it('tunnels WebSockets end to end', async () => {
    const socket = net.connect(varnishPort, '127.0.0.1');
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const key = crypto.randomBytes(16).toString('base64');
    socket.write(`GET /p/ws://127.0.0.1:${originPort}/chat HTTP/1.1\r\nHost: 127.0.0.1:${varnishPort}\r\n` +
      `Origin: http://127.0.0.1:${varnishPort}\r\nCookie: ${session()}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    let buf = await readUntil(socket, Buffer.alloc(0), (b) => b.includes('\r\n\r\n'));
    const headEnd = buf.indexOf('\r\n\r\n');
    const head = buf.subarray(0, headEnd).toString('latin1');
    assert.match(head, /^HTTP\/1\.1 101 /);
    const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    assert.match(head, new RegExp(`sec-websocket-accept: ${accept.replace(/[+/=]/g, '\\$&')}`, 'i'));
    buf = buf.subarray(headEnd + 4);
    for (const msg of ['hello', 'second message']) {
      socket.write(clientFrame(msg));
      buf = await readUntil(socket, buf, (b) => readFrame(b) !== null);
      const f = readFrame(buf);
      buf = f.rest;
      assert.strictEqual(f.text, 'echo:' + msg);
    }
    socket.destroy();
  });

  // -- forwarded headers -----------------------------------------------------------------------

  it('tells the app the public scheme and host', async () => {
    const cfg = (r) => JSON.parse(/window\.__PROXY_CFG=(\{.*?\});<\/script>/.exec(r.text)[1]);
    const psid = (r) => [].concat(r.headers['set-cookie'] || []).find((c) => c.startsWith('__psid='));

    const plain = await request(p('/page'), { headers: DOC(undefined) });
    assert.strictEqual(cfg(plain).origin, `http://127.0.0.1:${varnishPort}`);
    assert.doesNotMatch(psid(plain), /;\s*Secure/i);

    const named = await request(p('/page'), { headers: DOC(undefined, { host: 'proxy.lan:8000' }) });
    assert.strictEqual(cfg(named).origin, 'http://proxy.lan:8000');

    // A TLS terminator on this machine says the user is on https.
    const tls = await request(p('/page'), { headers: DOC(undefined, { 'x-forwarded-proto': 'https', host: 'proxy.lan' }) });
    assert.strictEqual(cfg(tls).origin, 'https://proxy.lan');
    assert.match(psid(tls), /;\s*Secure/i);

    // A remote client cannot claim https or another host.
    const spoof = await remote(p('/page'), { headers: DOC(undefined, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example', host: 'proxy.lan' }) });
    assert.strictEqual(spoof.status, 200);
    assert.strictEqual(cfg(spoof).origin, 'http://proxy.lan');
    assert.doesNotMatch(psid(spoof), /;\s*Secure/i);

    // Redirects stay inside the proxy, and stray root-relative URLs find their site again.
    const s = session();
    const redirect = await request(p('/redirect'), { headers: DOC(s) });
    assert.strictEqual(redirect.status, 302);
    assert.match(redirect.headers.location, new RegExp(`^(http://127\\.0\\.0\\.1:${varnishPort})?/p/${O.replace(/[.:/]/g, '\\$&')}/landing$`));
    const stray = await request('/landing?x=1', { headers: { cookie: s, referer: `http://127.0.0.1:${varnishPort}${p('/page')}` } });
    assert.strictEqual(stray.status, 307);
    assert.strictEqual(stray.headers.location, p('/landing?x=1'));
    assert.strictEqual(stray.headers['x-cache'], 'PASS');
  });

  // -- purging -----------------------------------------------------------------------------------

  it('purges every cached variant of a URL, from this machine only', async () => {
    const s = session();
    await request(p('/static/purge.png'), { headers: IMG(s) });
    await request(p('/static/purge.png'), { headers: { cookie: s } });
    assert.strictEqual((await request(p('/static/purge.png'), { headers: IMG(s) })).headers['x-cache'], 'HIT');

    const denied = await remote(p('/static/purge.png'), { method: 'PURGE' });
    assert.strictEqual(denied.status, 403);
    assert.strictEqual((await request(p('/static/purge.png'), { headers: IMG(s) })).headers['x-cache'], 'HIT');

    const purged = await request(p('/static/purge.png'), { method: 'PURGE' });
    assert.strictEqual(purged.status, 200);
    assert.strictEqual((await request(p('/static/purge.png'), { headers: IMG(s) })).headers['x-cache'], 'MISS');
    assert.strictEqual((await request(p('/static/purge.png'), { headers: { cookie: s } })).headers['x-cache'], 'MISS');
  });

  // -- the app goes away (keep last: it stops the app) --------------------------------------

  it('shows a friendly page when the app is down, and keeps serving cached assets', async () => {
    const s = session();
    await request(p('/static/down.png'), { headers: IMG(s) });
    await stop(app);
    const r = await request(p('/page'), { headers: DOC(s) });
    assert.strictEqual(r.status, 503);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.match(r.text, /proxy app is not running/i);
    const cached = await request(p('/static/down.png'), { headers: IMG(s) });
    assert.strictEqual(cached.status, 200);
    assert.strictEqual(cached.headers['x-cache'], 'HIT');
  });
});

// ---- WebSocket framing (just enough for the test) -------------------------------------------

function clientFrame(text) {
  const payload = Buffer.from(text);
  const mask = crypto.randomBytes(4);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, payload.map((b, i) => b ^ mask[i % 4])]);
}

function serverFrame(text) {
  const payload = Buffer.from(text);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

/** One complete frame (payload < 126 bytes) from the start of buf, or null. */
function readFrame(buf) {
  if (buf.length < 2) return null;
  const masked = buf[1] & 0x80;
  const len = buf[1] & 0x7f;
  const start = 2 + (masked ? 4 : 0);
  if (buf.length < start + len) return null;
  let payload = buf.subarray(start, start + len);
  if (masked) {
    const mask = buf.subarray(2, 6);
    payload = payload.map((b, i) => b ^ mask[i % 4]);
  }
  return { opcode: buf[0] & 0x0f, text: Buffer.from(payload).toString('utf8'), rest: buf.subarray(start + len) };
}

function readUntil(socket, initial, predicate, ms = 3000) {
  return new Promise((resolve, reject) => {
    let buf = initial;
    if (predicate(buf)) return resolve(buf);
    const timer = setTimeout(() => { socket.removeListener('data', onData); reject(new Error('timed out: ' + JSON.stringify(buf.toString('latin1')))); }, ms);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      if (predicate(buf)) {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        resolve(buf);
      }
    };
    socket.on('data', onData);
  });
}
