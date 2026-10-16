'use strict';

// The plugin system: manifest loading, settings, site scopes, persistence and failure handling
// (PluginManager on its own), then every hook end to end through a running proxy, the plugin
// manager API and the plugins shipped in plugins/.

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'x70-plugins-'));
const PLUGIN_DIR = path.join(TMP, 'plugins');

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
process.env.PERSIST_PLUGINS = '0';
process.env.PLUGINS_DIR = PLUGIN_DIR;
process.env.PLUGIN_DATA_DIR = path.join(TMP, 'data');
process.env.PLUGINS = 'tester,scoped';
process.env.PLUGIN_HOOK_TIMEOUT = '300';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { PluginManager, normaliseSites, siteAllowed, coerceSetting } = require('../src/plugins');

function writePlugin(dir, id, manifest, files = {}) {
  const d = path.join(dir, id);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
}

const quiet = { log() {}, error() {} };

// ---- plugins used by the end-to-end tests ----------------------------------------------------

writePlugin(PLUGIN_DIR, 'tester', {
  name: 'Tester',
  version: '1.2.3',
  description: 'Exercises every hook',
  client: 'client.js',
  settings: {
    banner: { type: 'string', label: 'Banner', default: 'hello from tester', public: true },
    apiKey: { type: 'string', label: 'Key', default: 'top-secret', secret: true },
  },
  toolbar: [{ id: 'wave', label: '👋', title: 'Wave' }, { id: 'log', label: 'L', href: '/__proxy/x/tester/hello' }],
}, {
  'index.js': `
module.exports = (x70) => ({
  onRequest(ctx) {
    const u = new URL(ctx.url);
    if (u.pathname === '/blocked') return { block: { status: 451, reason: 'test block' } };
    if (u.pathname === '/blocked-body') return { block: { status: 403, body: 'nope', contentType: 'text/plain' } };
    if (u.pathname === '/go-elsewhere') return { redirect: u.origin + '/landing' };
    if (u.pathname === '/old') return { url: u.origin + '/new' };
    if (u.pathname === '/echo-headers') { ctx.setHeader('x-plugin', 'yes'); ctx.removeHeader('x-drop-me'); }
    if (u.pathname === '/slow-request') return new Promise((r) => setTimeout(r, 5000));
  },
  onResponseHeaders(ctx) {
    ctx.headers['x-tester'] = 'seen';
    if (new URL(ctx.url).pathname === '/no-server') ctx.headers.server = undefined;
  },
  transformHtml(html, ctx) {
    if (ctx.dest && ctx.dest !== 'document') return html;
    return html.replace('</body>', '<p id="tester">' + x70.settings.banner + '</p><a id="added" href="/added">a</a></body>');
  },
  transformCss(css) { return css + '\\n.tester{color:red}'; },
  route(req, res, ctx) {
    if (ctx.path === '/hello') return ctx.json({ hello: true, session: Boolean(ctx.session), fromPage: ctx.fromPage, query: ctx.query });
    if (ctx.path === '/count') { const n = (x70.storage.get('n', 0)) + 1; x70.storage.set('n', n); return ctx.json({ n }); }
    if (ctx.path === '/echo' && req.method === 'POST') return ctx.readJson().then((v) => ctx.json({ got: v }));
    if (ctx.path === '/boom') throw new Error('route exploded');
    ctx.send(404, 'nope');
  },
});
`,
  'client.js': 'window.__testerLoaded = x70.settings;',
});

// Only applies to "localhost": requests to 127.0.0.1 must never see it.
writePlugin(PLUGIN_DIR, 'scoped', { name: 'Scoped', sites: ['localhost'] }, {
  'index.js': `module.exports = { transformHtml: (h) => h.replace('</body>', '<i id="scoped"></i></body>'), onResponseHeaders(c) { c.headers['x-scoped'] = '1'; } };`,
});

// Installed but off.
writePlugin(PLUGIN_DIR, 'idle', { name: 'Idle', settings: { n: { type: 'number', default: 2, min: 1, max: 9 } } }, {
  'index.js': `module.exports = { transformHtml: (h) => h + '<!--idle-->', route: (q, s, c) => c.send(200, 'idle') };`,
});

writePlugin(PLUGIN_DIR, 'broken', '{ not json', {});

const config = require('../src/config');
const proxyMod = require('../src/proxy');
const { createServer } = require('../server');

// ---- PluginManager unit tests ---------------------------------------------------------------

describe('plugin manager', () => {
  const dir = path.join(TMP, 'unit');
  const data = path.join(TMP, 'unit-data');

  before(() => {
    writePlugin(dir, 'good', {
      name: 'Good',
      settings: {
        on: { type: 'boolean', default: true },
        level: { type: 'number', default: 5, min: 1, max: 10 },
        mode: { type: 'select', options: ['a', { value: 'b', label: 'Bee' }], default: 'b' },
        colour: { type: 'color', default: '#ABC' },
        token: { type: 'string', secret: true },
      },
    }, {
      'index.js': `module.exports = (x70) => ({
        onEnable() { x70.storage.set('enabled', (x70.storage.get('enabled', 0)) + 1); },
        onRequest(ctx) { if (ctx.url.includes('throw')) throw new Error('kaboom'); if (ctx.url.includes('hang')) return new Promise(() => {}); },
      });`,
    });
    writePlugin(dir, 'no-manifest-file', {}, {});
    fs.unlinkSync(path.join(dir, 'no-manifest-file', 'plugin.json'));
    writePlugin(dir, 'bad-setting', { settings: { x: { type: 'weird' } } }, { 'index.js': 'module.exports = {}' });
    writePlugin(dir, 'escapes', { main: '../good/index.js' });
    writePlugin(dir, 'throws-on-load', {}, { 'index.js': 'throw new Error("load failed")' });
    writePlugin(dir, 'Bad Name', {}, { 'index.js': 'module.exports = {}' });
    writePlugin(dir, '_disabled-template', {}, { 'index.js': 'module.exports = {}' });
  });

  function manager(o = {}) {
    return new PluginManager({ dir, dataDir: data, persist: false, logger: quiet, hookTimeoutMs: 100, ...o }).load();
  }

  it('loads valid plugins and reports load errors without throwing', () => {
    const m = manager();
    const ids = m.list().map((p) => p.id);
    assert.deepStrictEqual(ids.sort(), ['bad-setting', 'escapes', 'good', 'no-manifest-file', 'throws-on-load']);
    const byId = Object.fromEntries(m.list().map((p) => [p.id, p]));
    assert.strictEqual(byId.good.error, null);
    assert.match(byId['no-manifest-file'].error, /missing plugin\.json/);
    assert.match(byId['bad-setting'].error, /unknown type/);
    assert.match(byId.escapes.error, /inside the plugin folder/);
    assert.match(byId['throws-on-load'].error, /load failed/);
    assert.throws(() => m.update('throws-on-load', { enabled: true }), /Cannot enable/);
    assert.throws(() => m.update('nope', { enabled: true }), (e) => e.status === 404);
  });

  it('applies setting defaults, coercion and validation, and hides secrets', () => {
    const m = manager();
    let d = m.list().find((p) => p.id === 'good');
    assert.deepStrictEqual(d.settings, { on: true, level: 5, mode: 'b', colour: '#abc', token: '' });
    d = m.update('good', { settings: { on: 'false', level: '99', mode: 'a', token: 's3cret' } });
    assert.strictEqual(d.settings.on, false);
    assert.strictEqual(d.settings.level, 10, 'clamped to max');
    assert.strictEqual(d.settings.mode, 'a');
    assert.strictEqual(d.settings.token, '', 'secret never echoed');
    assert.strictEqual(d.schema.token.hasValue, true);
    const p = m.plugins.get('good');
    assert.strictEqual(m.settingsOf(p).token, 's3cret');
    m.update('good', { settings: { token: '' } });
    assert.strictEqual(m.settingsOf(p).token, 's3cret', 'blank secret keeps the stored one');
    assert.throws(() => m.update('good', { settings: { mode: 'c' } }), /Invalid value/);
    assert.throws(() => m.update('good', { settings: { unknown: 1 } }), /Unknown setting/);
    assert.throws(() => m.update('good', { settings: [] }), /must be an object/);
  });

  it('matches sites with includes, subdomains and exclusions', () => {
    assert.deepStrictEqual(normaliseSites(['*', ' Example.COM ', 'https://a.b.org/path', '*.wild.net', '!ads.example.com', 'bad host!', '']),
      ['*', 'example.com', 'a.b.org', 'wild.net', '!ads.example.com']);
    const sites = ['example.com', '!ads.example.com'];
    assert.ok(siteAllowed(sites, 'https://example.com/'));
    assert.ok(siteAllowed(sites, 'https://www.example.com/x'));
    assert.ok(!siteAllowed(sites, 'https://ads.example.com/'));
    assert.ok(!siteAllowed(sites, 'https://cdn.ads.example.com/'));
    assert.ok(!siteAllowed(sites, 'https://notexample.com/'));
    assert.ok(siteAllowed(['*', '!bad.org'], 'http://anything.test/'));
    assert.ok(!siteAllowed(['*', '!bad.org'], 'http://bad.org/'));
    assert.ok(!siteAllowed([], 'http://x.org/'));
    assert.strictEqual(coerceSetting({ type: 'color' }, 'red'), undefined);
  });

  it('only runs hooks of enabled plugins on matching sites, and versions the state', () => {
    const m = manager();
    assert.strictEqual(m.wants('onRequest', 'https://x.org/'), false);
    assert.strictEqual(m.tag('abcdef12'), 'abcdef12', 'no plugins running: tag unchanged');
    m.update('good', { enabled: true });
    assert.strictEqual(m.wants('onRequest', 'https://x.org/'), true);
    const t1 = m.tag('abcdef12');
    assert.match(t1, /^[0-9a-f]{8}$/);
    assert.notStrictEqual(t1, 'abcdef12');
    m.update('good', { settings: { level: 3 } });
    const t2 = m.tag('abcdef12');
    assert.notStrictEqual(t2, t1, 'settings change the tag');
    m.update('good', { sites: 'x.org, !y.x.org' });
    assert.strictEqual(m.wants('onRequest', 'https://y.x.org/'), false);
    assert.strictEqual(m.wants('onRequest', 'https://z.org/'), false);
    assert.strictEqual(m.wants('onRequest', 'https://a.x.org/'), true);
    m.update('good', { enabled: false });
    assert.strictEqual(m.wants('onRequest', 'https://x.org/'), false);
  });

  it('contains failing and hanging hooks and switches a plugin off after repeated failures', async () => {
    const m = manager({ maxErrors: 3 });
    m.update('good', { enabled: true });
    let r = await m.runRequest({ url: 'https://x.org/throw' });
    assert.strictEqual(r.block, undefined);
    const p = m.plugins.get('good');
    assert.strictEqual(p.errors, 1);
    assert.match(p.lastError.message, /kaboom/);
    r = await m.runRequest({ url: 'https://x.org/ok' });
    assert.strictEqual(p.errors, 0, 'a success resets the count');
    const started = Date.now();
    await m.runRequest({ url: 'https://x.org/hang' });
    assert.ok(Date.now() - started < 1000, 'hook timed out');
    assert.match(p.lastError.message, /timed out/);
    await m.runRequest({ url: 'https://x.org/throw' });
    await m.runRequest({ url: 'https://x.org/throw' });
    assert.strictEqual(p.running, false);
    assert.strictEqual(m.list().find((d) => d.id === 'good').enabled, false);
    assert.strictEqual(p.lastError.disabled, true);
  });

  it('persists state, settings and storage, and reloads plugins from disk', () => {
    const pdata = path.join(TMP, 'persist-data');
    const m1 = new PluginManager({ dir, dataDir: pdata, persist: true, logger: quiet }).load();
    m1.update('good', { enabled: true, settings: { level: 7 } });
    m1.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(pdata, 'plugins.json'), 'utf8'));
    assert.strictEqual(saved.plugins.good.enabled, true);
    assert.strictEqual(saved.plugins.good.settings.level, 7);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(pdata, 'plugins', 'good.json'), 'utf8')), { enabled: 1 });

    const m2 = new PluginManager({ dir, dataDir: pdata, persist: true, logger: quiet }).load();
    const p = m2.plugins.get('good');
    assert.strictEqual(p.running, true);
    assert.strictEqual(m2.settingsOf(p).level, 7);
    assert.strictEqual(p.storage.get('enabled'), 2, 'storage survived and onEnable ran again');

    // Reload picks up code changes.
    const idx = path.join(dir, 'good', 'index.js');
    const old = fs.readFileSync(idx, 'utf8');
    fs.writeFileSync(idx, 'module.exports = { transformCss: (c) => c };');
    try {
      const d = m2.reload('good');
      assert.deepStrictEqual(d.hooks, ['transformCss']);
      assert.strictEqual(d.running, true);
    } finally {
      fs.writeFileSync(idx, old);
    }
    assert.throws(() => m2.reload('ghost'), (e) => e.status === 404);
    m2.flush();
  });

  it('ignores everything when switched off', () => {
    const m = manager({ disabled: true, enable: ['good'] });
    assert.deepStrictEqual(m.list(), []);
    assert.strictEqual(m.wants('onRequest', 'https://x.org/'), false);
  });
});

// ---- end to end ------------------------------------------------------------------------------

let site, proxy, siteUrl, proxyUrl;
const seen = {};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function request(p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(proxyUrl + p, { method, headers }, (res) => {
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

const DOC = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
const PAGE = '<!doctype html><html><head><title>t</title></head><body><h1>page</h1></body></html>';

function cfgOf(html) {
  const m = /window\.__PROXY_CFG=(\{.*?\});<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

describe('plugins through the proxy', () => {
  before(async () => {
    site = http.createServer((req, res) => {
      seen[req.url] = { headers: req.headers };
      if (req.url === '/style.css') {
        res.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'public, max-age=600' });
        return res.end('body{margin:0}');
      }
      if (req.url === '/etag') {
        res.writeHead(200, { 'content-type': 'text/html', etag: '"v1"' });
        return res.end(PAGE);
      }
      if (req.url === '/image.png') {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=600', server: 'fixture' });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'fixture' });
      res.end(PAGE);
    });
    siteUrl = `http://127.0.0.1:${await listen(site)}`;
    proxy = createServer();
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  });

  after(() => {
    site.close();
    proxy.close();
    proxy.closeAllConnections?.();
    fs.rmSync(TMP, { recursive: true, force: true });
  });

  it('starts the plugins named in PLUGINS and reports the broken one', () => {
    const list = Object.fromEntries(proxyMod.plugins.list().map((p) => [p.id, p]));
    assert.strictEqual(list.tester.running, true);
    assert.strictEqual(list.scoped.running, true);
    assert.strictEqual(list.idle.running, false);
    assert.match(list.broken.error, /plugin\.json/);
  });

  it('transformHtml edits documents before rewriting, so added links are proxied', async () => {
    const r = await request(`/p/${siteUrl}/page`, { headers: DOC });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /<p id="tester">hello from tester<\/p>/);
    assert.ok(r.body.includes(`href="/p/${siteUrl}/added"`), 'plugin-added link went through the rewriter');
    assert.ok(!r.body.includes('id="scoped"'), 'the scoped plugin does not run on 127.0.0.1');
    assert.ok(!r.body.includes('<!--idle-->'), 'disabled plugins do nothing');
    assert.strictEqual(r.headers['x-tester'], 'seen');
    assert.strictEqual(r.headers['x-scoped'], undefined);
    assert.strictEqual(r.headers['x-proxy-private'], '1');
  });

  it('injects client scripts and toolbar buttons into top-level documents only', async () => {
    const r = await request(`/p/${siteUrl}/page`, { headers: DOC });
    const cfg = cfgOf(r.body);
    assert.ok(cfg, 'runtime config present');
    assert.strictEqual(cfg.pluginsPage, '/__proxy/plugins');
    assert.deepStrictEqual(cfg.pluginToolbar.map((b) => [b.plugin, b.action, b.label]), [['tester', 'wave', '👋'], ['tester', 'log', 'L']]);
    assert.strictEqual(cfg.pluginToolbar[1].href, '/__proxy/x/tester/hello');
    const m = /<script src="([^"]*\/__proxy\/x\/tester\/client\.js\?v=[0-9a-f]+)" data-proxy-runtime data-x70-plugin><\/script>/.exec(r.body);
    assert.ok(m, 'client script tag injected');
    assert.ok(r.body.indexOf('/__proxy/client.js') < r.body.indexOf('/__proxy/x/tester/client.js'), 'after the runtime');

    const frame = await request(`/p/${siteUrl}/page`, { headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' } });
    assert.ok(!frame.body.includes('/__proxy/x/tester/client.js'), 'no client script in frames without allFrames');
    assert.strictEqual(cfgOf(frame.body).pluginToolbar, undefined);
    assert.ok(!frame.body.includes('id="tester"'), 'transformHtml told the dest');

    const js = await request(new URL(m[1]).pathname + new URL(m[1]).search);
    assert.strictEqual(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    assert.ok(js.body.includes('window.__testerLoaded = x70.settings;'));
    assert.ok(js.body.includes('"banner":"hello from tester"'), 'public settings handed over');
    assert.ok(!js.body.includes('top-secret'), 'secret settings never reach pages');
    // The wrapper runs as plain JS.
    const g = { location: { href: 'http://p/' }, addEventListener() {}, localStorage: null, fetch() {} };
    new Function('window', js.body)(g);
    assert.deepStrictEqual(g.__testerLoaded, { banner: 'hello from tester' });

    assert.strictEqual((await request('/__proxy/x/idle/client.js')).status, 404);
  });

  it('onRequest can block a page, block a resource with a body, and redirect', async () => {
    let r = await request(`/p/${siteUrl}/blocked`, { headers: DOC });
    assert.strictEqual(r.status, 451);
    assert.match(r.body, /Tester blocked this request: test block/);
    assert.strictEqual(seen['/blocked'], undefined, 'never reached the site');

    r = await request(`/p/${siteUrl}/blocked`, { headers: { 'sec-fetch-dest': 'image' } });
    assert.strictEqual(r.status, 451);
    assert.strictEqual(r.body, 'Blocked by plugin Tester');

    r = await request(`/p/${siteUrl}/blocked-body`, { method: 'POST', body: 'x'.repeat(100000) });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.body, 'nope');

    r = await request(`/p/${siteUrl}/go-elsewhere`, { headers: DOC });
    assert.strictEqual(r.status, 307);
    assert.strictEqual(r.headers.location, `/p/${siteUrl}/landing`);
  });

  it('onRequest can retarget a request and edit its headers', async () => {
    let r = await request(`/p/${siteUrl}/old`, { headers: DOC });
    assert.strictEqual(r.status, 200);
    assert.ok(seen['/new'], 'fetched the new URL');
    assert.strictEqual(seen['/old'], undefined);

    r = await request(`/p/${siteUrl}/echo-headers`, { headers: { 'x-drop-me': '1', 'x-keep': '2' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(seen['/echo-headers'].headers['x-plugin'], 'yes');
    assert.strictEqual(seen['/echo-headers'].headers['x-drop-me'], undefined);
    assert.strictEqual(seen['/echo-headers'].headers['x-keep'], '2');
  });

  it('a first visit gets one session, shared by plugins and the cookie jar', async () => {
    const r = await request(`/p/${siteUrl}/page`, { headers: DOC });
    const sids = [].concat(r.headers['set-cookie'] || []).filter((c) => c.startsWith('__psid='));
    assert.strictEqual(sids.length, 1, sids.join(' | '));
  });

  it('a hanging onRequest times out and the request still goes through', async () => {
    const r = await request(`/p/${siteUrl}/slow-request`, { headers: DOC });
    assert.strictEqual(r.status, 200);
    assert.ok(seen['/slow-request']);
    const t = proxyMod.plugins.plugins.get('tester');
    assert.match(t.lastError.message, /timed out/);
    t.errors = 0;
  });

  it('transformCss runs and keeps the result out of the shared cache', async () => {
    const r = await request(`/p/${siteUrl}/style.css`, { headers: { 'sec-fetch-dest': 'style' } });
    assert.match(r.body, /\.tester\{color:red\}/);
    assert.strictEqual(r.headers['x-proxy-private'], '1');
  });

  it('onResponseHeaders can add and remove headers on streamed responses', async () => {
    const r = await request(`/p/${siteUrl}/image.png`, { headers: { 'sec-fetch-dest': 'image' } });
    assert.strictEqual(r.headers['x-tester'], 'seen');
    assert.strictEqual(r.headers.server, 'fixture');
    const r2 = await request(`/p/${siteUrl}/no-server`, { headers: DOC });
    assert.strictEqual(r2.headers.server, undefined);
  });

  it('serves plugin routes with session, query, JSON bodies and storage', async () => {
    let r = await request('/__proxy/x/tester/hello?a=1');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { hello: true, session: true, fromPage: null, query: { a: '1' } });
    r = await request('/__proxy/x/tester/hello', { headers: { referer: `${proxyUrl}/p/${siteUrl}/page` } });
    assert.strictEqual(JSON.parse(r.body).fromPage, `${siteUrl}/page`);
    r = await request('/__proxy/x/tester/echo', { method: 'POST', body: '{"x":[1,2]}', headers: { 'content-type': 'application/json' } });
    assert.deepStrictEqual(JSON.parse(r.body), { got: { x: [1, 2] } });
    assert.strictEqual(JSON.parse((await request('/__proxy/x/tester/count')).body).n, 1);
    assert.strictEqual(JSON.parse((await request('/__proxy/x/tester/count')).body).n, 2);
    r = await request('/__proxy/x/tester/boom');
    assert.strictEqual(r.status, 500);
    proxyMod.plugins.plugins.get('tester').errors = 0;
    assert.strictEqual((await request('/__proxy/x/idle/anything')).status, 404, 'disabled plugin has no routes');
    assert.strictEqual((await request('/__proxy/x/ghost/')).status, 404);
    assert.strictEqual((await request('/__proxy/x/BAD/')).status, 404);
  });

  describe('manager page and API', () => {
    const ADMIN = { 'content-type': 'application/json', 'x-x70-admin': '1' };

    it('serves the page with framing disabled', async () => {
      const r = await request('/__proxy/plugins');
      assert.strictEqual(r.status, 200);
      assert.match(r.body, /<title>Plugins/);
      assert.strictEqual(r.headers['x-frame-options'], 'DENY');
      assert.match(r.headers['content-security-policy'], /frame-ancestors 'none'/);
    });

    it('lists plugins without leaking secrets', async () => {
      const r = await request('/__proxy/plugins/api');
      const j = JSON.parse(r.body);
      assert.strictEqual(j.writable, true);
      const t = j.plugins.find((p) => p.id === 'tester');
      assert.strictEqual(t.version, '1.2.3');
      assert.deepStrictEqual(t.hooks.sort(), ['onRequest', 'onResponseHeaders', 'route', 'transformCss', 'transformHtml']);
      assert.strictEqual(t.settings.apiKey, '');
      assert.ok(!r.body.includes('top-secret'));
    });

    it('refuses writes without the admin header, from proxied pages, cross-site, or as forms', async () => {
      const body = JSON.stringify({ enabled: true });
      let r = await request('/__proxy/plugins/api/idle', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
      assert.strictEqual(r.status, 403);
      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body, headers: { ...ADMIN, referer: `${proxyUrl}/p/${siteUrl}/page` } });
      assert.strictEqual(r.status, 403);
      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body, headers: { ...ADMIN, 'sec-fetch-site': 'cross-site' } });
      assert.strictEqual(r.status, 403);
      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: 'enabled=1', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-x70-admin': '1' } });
      assert.strictEqual(r.status, 415);
      r = await request('/__proxy/plugins/api/idle', { headers: ADMIN });
      assert.strictEqual(r.status, 405);
      assert.strictEqual(proxyMod.plugins.plugins.get('idle').running, false);
    });

    it('enables, configures and disables a plugin, changing pages and ETags immediately', async () => {
      const before = await request(`/p/${siteUrl}/etag`, { headers: DOC });
      let r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: JSON.stringify({ enabled: true, settings: { n: 4 } }), headers: ADMIN });
      assert.strictEqual(r.status, 200, r.body);
      const p = JSON.parse(r.body).plugin;
      assert.strictEqual(p.running, true);
      assert.strictEqual(p.settings.n, 4);
      const on = await request(`/p/${siteUrl}/etag`, { headers: DOC });
      assert.ok(on.body.includes('<!--idle-->'));
      assert.notStrictEqual(on.headers.etag, before.headers.etag, 'validators change with plugin state');
      // A browser revalidating the old copy must get the new one, not a 304.
      const reval = await request(`/p/${siteUrl}/etag`, { headers: { ...DOC, 'if-none-match': before.headers.etag } });
      assert.strictEqual(reval.status, 200);
      assert.strictEqual((await request('/__proxy/x/idle/x')).body, 'idle');

      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: JSON.stringify({ settings: { n: 'many' } }), headers: ADMIN });
      assert.strictEqual(r.status, 400);
      assert.match(JSON.parse(r.body).error, /Invalid value/);
      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: '[1]', headers: ADMIN });
      assert.strictEqual(r.status, 400);

      r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: JSON.stringify({ enabled: false }), headers: ADMIN });
      assert.strictEqual(JSON.parse(r.body).plugin.running, false);
      const off = await request(`/p/${siteUrl}/etag`, { headers: DOC });
      assert.ok(!off.body.includes('<!--idle-->'));
      assert.strictEqual(off.headers.etag, before.headers.etag);
    });

    it('changes a plugin\'s sites', async () => {
      let r = await request('/__proxy/plugins/api/scoped', { method: 'POST', body: JSON.stringify({ sites: ['127.0.0.1'] }), headers: ADMIN });
      assert.deepStrictEqual(JSON.parse(r.body).plugin.sites, ['127.0.0.1']);
      r = await request(`/p/${siteUrl}/page`, { headers: DOC });
      assert.ok(r.body.includes('id="scoped"'));
      await request('/__proxy/plugins/api/scoped', { method: 'POST', body: JSON.stringify({ sites: ['localhost'] }), headers: ADMIN });
      r = await request(`/p/${siteUrl}/page`, { headers: DOC });
      assert.ok(!r.body.includes('id="scoped"'));
    });

    it('reloads plugins from disk and refuses to enable a broken one', async () => {
      let r = await request('/__proxy/plugins/api/broken', { method: 'POST', body: '{"enabled":true}', headers: ADMIN });
      assert.strictEqual(r.status, 409);
      writePlugin(PLUGIN_DIR, 'late', { name: 'Late' }, { 'index.js': 'module.exports = { route: (q, s, c) => c.send(200, "late") };' });
      r = await request('/__proxy/plugins/api/reload', { method: 'POST', body: '', headers: ADMIN });
      assert.strictEqual(r.status, 200);
      assert.ok(JSON.parse(r.body).plugins.some((p) => p.id === 'late'));
      assert.strictEqual(proxyMod.plugins.plugins.get('tester').running, true, 'running plugins restart after a reload');
      r = await request('/__proxy/plugins/api/late', { method: 'POST', body: '{"enabled":true}', headers: ADMIN });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await request('/__proxy/x/late/')).body, 'late');
      r = await request('/__proxy/plugins/api/late/reload', { method: 'POST', body: '{}', headers: ADMIN });
      assert.strictEqual(JSON.parse(r.body).plugin.running, true);
      r = await request('/__proxy/plugins/api/nobody', { method: 'POST', body: '{}', headers: ADMIN });
      assert.strictEqual(r.status, 404);
    });

    it('is read-only with PLUGIN_ADMIN=0', async () => {
      config.pluginAdmin = false;
      try {
        const r = await request('/__proxy/plugins/api/idle', { method: 'POST', body: '{"enabled":true}', headers: ADMIN });
        assert.strictEqual(r.status, 403);
        assert.match(r.body, /read-only/);
        assert.strictEqual(JSON.parse((await request('/__proxy/plugins/api')).body).writable, false);
      } finally {
        config.pluginAdmin = true;
      }
    });
  });
});

// ---- the plugins shipped in plugins/ ---------------------------------------------------------

describe('bundled plugins', () => {
  const m = new PluginManager({ dir: path.join(__dirname, '..', 'plugins'), persist: false, logger: quiet,
    enable: ['dark-mode', 'request-log', 'site-blocker'] }).load();

  it('all load and start', () => {
    for (const p of m.list()) {
      assert.strictEqual(p.error, null, `${p.id}: ${p.error}`);
      assert.strictEqual(p.running, true, p.id);
    }
    assert.deepStrictEqual(m.list().map((p) => p.id).sort(), ['dark-mode', 'request-log', 'site-blocker']);
  });

  it('site-blocker blocks listed domains and their subdomains only', async () => {
    m.update('site-blocker', { settings: { blocked: 'bad.example\nhttps://worse.org/path' } });
    assert.ok((await m.runRequest({ url: 'https://bad.example/' })).block);
    assert.ok((await m.runRequest({ url: 'https://www.worse.org/x' })).block);
    assert.ok(!(await m.runRequest({ url: 'https://notbad.example/' })).block);
    assert.ok(!(await m.runRequest({ url: 'https://good.org/' })).block);
  });

  it('request-log records per session and serves it', async () => {
    await m.runRequest({ url: 'https://a.org/', method: 'GET', session: 's1', topLevel: true, dest: 'document' });
    await m.runRequest({ url: 'https://b.org/img.png', method: 'GET', session: 's1', dest: 'image' });
    await m.runRequest({ url: 'https://c.org/', method: 'GET', session: 's2', topLevel: true });
    let out;
    const ctx = { path: '/api', session: 's1', json: (v) => { out = v; } };
    await m.route('request-log', {}, {}, ctx);
    assert.deepStrictEqual(out.entries.map((e) => e.url), ['https://a.org/', 'https://b.org/img.png']);
    let html;
    await m.route('request-log', {}, {}, { path: '/', session: 's2', send: (s, b) => { html = b; } });
    assert.match(html, /c\.org/);
    assert.ok(!html.includes('a.org'), 'sessions are kept apart');
  });

  it('dark-mode client script runs and toggles its style', () => {
    const js = m.clientScript('dark-mode', 'http://proxy');
    const listeners = {};
    const store = {};
    const nodes = [];
    const doc = {
      head: { appendChild: (n) => { n.isConnected = true; nodes.push(n); } },
      documentElement: {},
      getElementById: (id) => nodes.find((n) => n.id === id && n.isConnected) || null,
      createElement: () => ({ remove() { this.isConnected = false; } }),
      addEventListener() {},
    };
    const win = {
      location: { href: 'http://proxy/p/https://example.com/' },
      __proxy: { currentUrl: () => 'https://example.com/' },
      localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } },
      addEventListener: (t, fn) => { listeners[t] = fn; },
    };
    new Function('window', 'document', js)(win, doc);
    assert.ok(doc.getElementById('x70-dark-mode'), 'dark by default');
    assert.match(doc.getElementById('x70-dark-mode').textContent, /brightness\(0\.9\)/);
    listeners['x70:toolbar']({ detail: { plugin: 'dark-mode', action: 'toggle' } });
    assert.strictEqual(doc.getElementById('x70-dark-mode'), null, 'toggled off');
    assert.strictEqual(store['__x70p:dark-mode:site:example.com'], 'false');
    listeners['x70:toolbar']({ detail: { plugin: 'other', action: 'toggle' } });
    assert.strictEqual(doc.getElementById('x70-dark-mode'), null, 'other plugins\' buttons are ignored');
  });
});
