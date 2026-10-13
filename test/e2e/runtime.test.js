'use strict';

// Browser tests for public/client.js: a local fixture site (two origins) is browsed through the
// proxy in headless Chromium. Skipped when Playwright is not available.

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
process.env.LOG_REQUESTS = '0';
for (const k of ['UPSTREAM_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) process.env[k] = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { createSite } = require('./fixtures/site');

function loadPlaywright() {
  const candidates = ['playwright'];
  try {
    candidates.push(path.join(execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 }).toString().trim(), 'playwright'));
  } catch { /* npm missing */ }
  for (const c of candidates) {
    try { return require(c); } catch { /* try next */ }
  }
  return null;
}

const playwright = loadPlaywright();

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

describe('client runtime in Chromium', { skip: playwright ? false : 'Playwright is not installed' }, () => {
  const ctx = { A: '', B: '' };
  let siteA, siteB, proxy, browser, launchError;
  let P = ''; // proxy origin
  const proxyLog = [];

  before(async () => {
    siteA = createSite(ctx);
    siteB = createSite(ctx);
    ctx.A = 'http://127.0.0.1:' + await listen(siteA);
    // A different loopback address, so B is another host (cookies ignore ports).
    ctx.B = 'http://127.0.0.2:' + await listen(siteB, '127.0.0.2');
    const { createServer } = require('../../server');
    proxy = createServer();
    proxy.prependListener('request', (req) => proxyLog.push(req.url));
    P = 'http://127.0.0.1:' + await listen(proxy);
    try {
      browser = await playwright.chromium.launch({ args: ['--no-proxy-server'] });
    } catch (e) {
      launchError = e;
    }
  });

  after(async () => {
    if (browser) await browser.close();
    for (const s of [proxy, siteA, siteB]) {
      if (!s) continue;
      s.closeAllConnections?.();
      await new Promise((r) => s.close(r));
    }
  });

  const px = (origin, p) => P + '/p/' + origin + p;

  /**
   * Fresh browser context with error collection. Requests that reach a fixture origin directly
   * (instead of through the proxy) are recorded and aborted.
   */
  async function session(t) {
    if (!browser) { t.skip('Chromium could not be launched: ' + (launchError && launchError.message)); return null; }
    const context = await browser.newContext();
    const s = { context, errors: [], escaped: [], logStart: proxyLog.length };
    const direct = new Set([new URL(ctx.A).host, new URL(ctx.B).host]);
    await context.route((u) => direct.has(u.host), (route) => {
      s.escaped.push(route.request().url());
      route.abort();
    });
    const watch = (page) => {
      page.on('pageerror', (e) => s.errors.push('pageerror: ' + (e.stack || e.message)));
      page.on('console', (m) => { if (m.type() === 'error') s.errors.push('console: ' + m.text() + ' @ ' + page.url()); });
    };
    context.on('page', watch);
    s.open = async (origin, p, { wait = true } = {}) => {
      const page = await context.newPage();
      await page.goto(px(origin, p));
      if (wait) await page.waitForFunction(() => window.__done === true, null, { timeout: 15000 });
      return page;
    };
    s.results = (page) => page.evaluate(() => window.__results);
    // Serve the runtime the way the server does once it bundles the isomorphic JS rewriter.
    s.bundle = async () => {
      if (await servesRewriter()) return;
      await context.route((u) => u.pathname === '/__proxy/client.js', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: bundle() }));
    };
    t.after(() => context.close());
    return s;
  }

  let rewriterServed = null;
  async function servesRewriter() {
    if (rewriterServed === null) {
      const body = await (await fetch(P + '/__proxy/client.js')).text();
      rewriterServed = body.includes('__proxyRewriteJs') && body.includes('function rewriteJs');
    }
    return rewriterServed;
  }
  function bundle() {
    const root = path.join(__dirname, '..', '..');
    return fs.readFileSync(path.join(root, 'src', 'rewrite-js.js'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'public', 'client.js'), 'utf8');
  }

  /** Common assertions: no runtime/page errors, nothing bypassed the proxy. */
  function clean(s, { allowErrors = [] } = {}) {
    const errors = s.errors.filter((e) => !allowErrors.some((re) => re.test(e)));
    assert.deepStrictEqual(errors, [], 'page/console errors');
    assert.deepStrictEqual(s.escaped, [], 'requests that bypassed the proxy');
    const stray = proxyLog.slice(s.logStart).filter((u) => !u.startsWith('/p/') && !u.startsWith('/__proxy/'));
    assert.deepStrictEqual(stray, [], 'root-relative requests that escaped rewriting');
  }

  it('History-API router: pushState/replaceState, back/forward, reload of a deep route', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/spa/start?x=1#h', { wait: false });
    const view = async () => JSON.parse(await page.textContent('#view'));
    assert.deepStrictEqual(await view(), { path: '/spa/start', search: '?x=1', hash: '#h', href: A + '/spa/start?x=1#h', state: null });

    await page.click('#to-about');
    assert.strictEqual(page.url(), px(A, '/spa/about?tab=2#sec'));
    assert.deepStrictEqual(await view(), { path: '/spa/about', search: '?tab=2', hash: '#sec', href: A + '/spa/about?tab=2#sec', state: { page: 'to-about' } });

    await page.click('#to-user');
    await page.evaluate(() => window.replaceRoute());
    assert.strictEqual(page.url(), px(A, '/spa/users/42?replaced=1'));
    assert.deepStrictEqual((await view()).state, { replaced: true });

    await page.goBack();
    assert.deepStrictEqual(await view(), { path: '/spa/about', search: '?tab=2', hash: '#sec', href: A + '/spa/about?tab=2#sec', state: { page: 'to-about' } });
    await page.goForward();
    assert.deepStrictEqual(await view(), { path: '/spa/users/42', search: '?replaced=1', hash: '', href: A + '/spa/users/42?replaced=1', state: { replaced: true } });

    await page.reload();
    assert.deepStrictEqual(await view(), { path: '/spa/users/42', search: '?replaced=1', hash: '', href: A + '/spa/users/42?replaced=1', state: { replaced: true } });
    assert.strictEqual(page.url(), px(A, '/spa/users/42?replaced=1'));

    await page.evaluate(() => window.pushUrlObject());
    assert.strictEqual(page.url(), px(A, '/spa/obj?o=1'));
    assert.deepStrictEqual((await view()).state, { obj: true });

    // Cross-origin pushState is a SecurityError, exactly like without the proxy.
    const err = await page.evaluate((b) => { try { history.pushState(null, '', b + '/x'); return 'no error'; } catch (e) { return e.name; } }, B);
    assert.strictEqual(err, 'SecurityError');
    clean(s);
  });

  it('elements inserted via innerHTML, insertAdjacentHTML, setAttribute, properties and templates load through the proxy', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/dom');
    const r = await s.results(page);
    const pre = '/p/' + A;
    assert.deepStrictEqual(r.raw, {
      i1: pre + '/img/inner.png', a1: pre + '/target/inner', a2: '/p/' + B + '/target/other', i3: pre + '/img/setattr.png',
      i4: pre + '/img/prop.png', i6: pre + '/img/srcset1.png 1x, ' + pre + '/img/srcset2.png 2x', f1: pre + '/frame/adjacent',
      f2: pre + '/frame/prop', l1: pre + '/css/inner.css',
      tpl: [pre + '/img/tpl.png', pre + '/target/tpl', pre + '/img/tpl.png', pre + '/target/tpl'], svg: pre + '/img/svg.png',
    });
    assert.deepStrictEqual(r.attr, {
      i1: '/img/inner.png', a1: '/target/inner', a2: B + '/target/other', i3: '/img/setattr.png', i4: '/img/prop.png',
      i6: '/img/srcset1.png 1x, /img/srcset2.png 2x', a3: '/target/prop',
    });
    assert.deepStrictEqual(r.props, {
      i1: A + '/img/inner.png', a1: A + '/target/inner', a3: A + '/target/prop', i6: '/img/srcset1.png 1x, /img/srcset2.png 2x',
      f2: A + '/frame/prop', script: A + '/js/dyn.js',
    });
    assert.deepStrictEqual(r.loaded, [], 'images that failed to load');
    assert.strictEqual(r.dyn, true, 'dynamically inserted script ran');
    assert.strictEqual(r.never, false, 'scripts inserted through innerHTML do not run');
    assert.deepStrictEqual(r.frames, ['frame:/frame/adjacent', 'frame:/frame/prop']);
    assert.strictEqual(r.cssColor, 'rgb(10, 20, 30)');
    assert.strictEqual(r.cssPropColor, 'rgb(40, 50, 60)');
    assert.strictEqual(r.cssParsed, 'rgb(70, 80, 90)', 'stylesheet adopted from a DOMParser document');
    const fetched = siteA.log.map((e) => e.path);
    for (const p of ['/img/inner.png', '/css/inner.css', '/img/svg.png', '/img/outer.png', '/img/range.png', '/img/tpl2.png', '/css/parsed.css', '/img/parsed.png', '/img/adopted.png']) {
      assert.ok(fetched.includes(p), p + ' was fetched');
    }
    assert.ok(!fetched.includes('/js/never.js'));
    clean(s);
  });

  it('fetch, Request, XMLHttpRequest and sendBeacon with every URL form', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/net/index.html');
    const r = await s.results(page);
    assert.ok(!r.error, r.error);
    const check = (k, p, url = A + p) => {
      assert.strictEqual(r[k].body.path, p, k + ' path');
      assert.strictEqual(r[k].url, url, k + ' response url');
    };
    check('rootRel', '/api/echo?t=root');
    check('rel', '/net/api/echo?t=rel');
    check('abs', '/api/echo?t=abs');
    check('urlObj', '/api/echo?t=urlobj');
    check('originStr', '/api/echo?t=originstr');
    check('req', '/api/echo?t=req');
    check('post', '/api/echo?t=post');
    check('cross', '/api/echo?t=cross', B + '/api/echo?t=cross');
    check('xhr', '/api/echo?t=xhr');
    check('sync', '/net/api/echo?t=sync');
    assert.strictEqual(r.reqUrl, A + '/api/echo?t=req');
    assert.strictEqual(r.reqInstance, true);
    assert.deepStrictEqual([r.req.body.method, r.req.body.body, r.req.body.test], ['POST', 'hello-body', '1']);
    assert.deepStrictEqual([r.post.body.method, r.post.body.body], ['POST', '{"a":1}']);
    assert.strictEqual(r.req.body.referer, A + '/net/index.html');
    assert.strictEqual(r.beacon, true);
    assert.strictEqual(r.fetchNative, true, 'patched fetch still looks native');
    assert.strictEqual(r.sw, 'SecurityError', 'service workers are refused');
    clean(s);
  });

  it('WebSocket echo and EventSource through the proxy', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/stream');
    const r = await s.results(page);
    assert.ok(!r.error, r.error);
    const wsA = A.replace('http:', 'ws:');
    assert.strictEqual(r.wsUrl, wsA + '/ws?x=1');
    assert.strictEqual(r.wsMsg, 'echo:hi');
    assert.strictEqual(r.wsOrigin, wsA);
    assert.strictEqual(r.relUrl, wsA + '/ws?rel=1');
    assert.strictEqual(r.relMsg, 'echo:rel');
    assert.strictEqual(r.esUrl, A + '/sse');
    assert.deepStrictEqual(r.es, ['one', 'two']);
    assert.strictEqual(r.esOrigin, A);
    clean(s);
  });

  it('workers see the real location and their requests stay in the proxy', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/workers/page');
    const r = await s.results(page);
    if ('fn' in r.classic) assert.strictEqual(r.classic.fn, '/workers/worker.js', 'Function() inside a worker is rewritten');
    delete r.classic.fn;
    assert.deepStrictEqual(r.classic, {
      href: A + '/workers/worker.js', pathname: '/workers/worker.js', origin: A, locOrigin: A, str: A + '/workers/worker.js',
      rel: '/workers/api/echo?w=rel', resUrl: A + '/workers/api/echo?w=rel', root: '/api/echo?w=root', xhr: '/workers/api/echo?w=xhr',
      // Scripts pulled in with importScripts() see the worker's own location.
      helper: '/workers/worker.js', name: 'classic',
    });
    assert.deepStrictEqual(r.module, { href: A + '/workers/module-worker.mjs', dep: '/workers/module-worker.mjs', path: '/workers/api/echo?w=module' });
    assert.deepStrictEqual(r.blob, { path: '/api/echo?t=blob', origin: A });
    assert.strictEqual(r.isWorker, true);
    clean(s);
  });

  it('form submissions: GET, POST, formaction, form.submit() and requestSubmit()', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/forms');
    assert.strictEqual((await s.results(page)).action, A + '/form-result');
    const result = async () => JSON.parse(await page.textContent('#result'));
    const submit = async (action, url) => {
      await Promise.all([page.waitForURL(url), action()]);
      const r = await result();
      await page.goto(px(A, '/forms'));
      return r;
    };
    assert.deepStrictEqual(await submit(() => page.click('#get-btn'), px(A, '/form-result?q=hello+world')),
      { method: 'GET', url: '/form-result?q=hello+world', body: '' });
    assert.deepStrictEqual(await submit(() => page.click('#post-btn'), px(A, '/form-result')),
      { method: 'POST', url: '/form-result', body: 'a=1' });
    assert.deepStrictEqual(await submit(() => page.click('#fa-btn'), px(A, '/form-result?via=formaction')),
      { method: 'POST', url: '/form-result?via=formaction', body: 'a=1' });
    assert.deepStrictEqual(await submit(() => page.evaluate(() => window.jsSubmit()), px(A, '/form-result?via=js')),
      { method: 'POST', url: '/form-result?via=js', body: 'z=9' });
    assert.deepStrictEqual(await submit(() => page.evaluate(() => window.jsRequestSubmit()), px(B, '/form-result?k=v')),
      { method: 'GET', url: '/form-result?k=v', body: '' });
    assert.deepStrictEqual(await submit(() => page.evaluate(() => window.jsFormAction()), px(A, '/form-result?via=jsformaction')),
      { method: 'POST', url: '/form-result?via=jsformaction', body: 'a=1' });
    clean(s);
  });

  it('window.open, named targets and about:blank popups', async (t) => {
    const s = await session(t);
    if (!s) return;
    await s.bundle();
    const { A } = ctx;
    const page = await s.open(A, '/popup-opener');
    const [popup] = await Promise.all([s.context.waitForEvent('page'), page.evaluate(() => window.openPop())]);
    await popup.waitForFunction(() => window.__done === true);
    assert.strictEqual(popup.url(), px(A, '/popup?n=1'));
    await page.waitForFunction(() => window.msgs.length > 0);
    assert.deepStrictEqual(await page.evaluate(() => window.msgs), [{ data: { href: A + '/popup?n=1', openerHref: A + '/popup-opener', name: 'pop' }, origin: A }]);
    assert.deepStrictEqual(await page.evaluate(() => window.popInfo()), { href: A + '/popup?n=1', path: '/popup' });

    await Promise.all([popup.waitForURL(px(A, '/popup?n=2')), page.click('#named')]);
    assert.strictEqual(await page.evaluate(() => window.reuse()), true);

    const [blank] = await Promise.all([s.context.waitForEvent('page'), page.evaluate(() => window.blankPopup())]);
    assert.ok(blank);
    // document.open() gives the popup the URL of the document that opened it.
    assert.deepStrictEqual(await page.evaluate(() => window.blankInfo), { href: A + '/popup-opener', openerHref: A + '/popup-opener', origin: A });
    clean(s);
  });

  it('location.href / assign / replace / hash / search / pathname and document.location assignments', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/loc/start?a=1#top');
    const info = async () => JSON.parse(await page.textContent('#info'));
    assert.deepStrictEqual(await info(), {
      href: A + '/loc/start?a=1#top', path: '/loc/start', search: '?a=1', hash: '#top', origin: A, host: new URL(A).host,
      docLoc: A + '/loc/start?a=1#top', winLoc: '/loc/start', str: A + '/loc/start?a=1#top', tmpl: A + '/loc/start?a=1#top',
      isLoc: true, same: true,
    });
    const go = async (fn, arg, expected) => {
      await Promise.all([page.waitForURL(expected), page.evaluate(([f, a]) => window.nav[f](a), [fn, arg])]);
      await page.waitForFunction(() => window.__done === true);
    };
    await go('href', '/loc/href', px(A, '/loc/href'));
    assert.strictEqual((await info()).path, '/loc/href');
    await go('assign', 'assigned?x=1', px(A, '/loc/assigned?x=1'));
    await go('replace', '/loc/replaced', px(A, '/loc/replaced'));
    await page.goBack();
    assert.strictEqual(page.url(), px(A, '/loc/href'), 'replace() did not add a history entry');
    await page.waitForFunction(() => window.__done === true);

    await page.evaluate(() => window.nav.hash('section'));
    await page.waitForFunction(() => window.hashChanged === '#section');
    assert.strictEqual(page.url(), px(A, '/loc/href#section'));

    // Like the native setters, search/pathname keep the fragment.
    await go('search', '?q=2', px(A, '/loc/href?q=2#section'));
    await go('path', '/loc/pathed', px(A, '/loc/pathed?q=2#section'));
    await go('doc', '/loc/doc', px(A, '/loc/doc'));
    await go('bare', '/loc/bare', px(A, '/loc/bare'));
    await go('win', '/loc/win', px(A, '/loc/win'));
    await go('href', B + '/loc/other?y=1', px(B, '/loc/other?y=1'));
    assert.strictEqual((await info()).origin, B);
    clean(s);
  });

  it('document.cookie: write, read, expiry deletion, paths, HttpOnly, per-origin jar and cookieStore', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/cookies/a/page');
    const set = (v) => page.evaluate((x) => { document.cookie = x; return document.cookie; }, v);
    const jar = (v) => v.split('; ').filter(Boolean).sort();
    assert.deepStrictEqual(jar(await set('one=1; path=/')), ['one=1']);
    assert.deepStrictEqual(jar(await set('dp=1')), ['dp=1', 'one=1'], 'default path is /cookies/a');
    assert.deepStrictEqual(jar(await set('pb=2; path=/cookies/b')), ['dp=1', 'one=1']);
    await set('gone=x; max-age=3600');
    assert.deepStrictEqual(jar(await set('gone=; expires=Thu, 01 Jan 1970 00:00:00 GMT')), ['dp=1', 'one=1']);
    await set('age0=1');
    assert.deepStrictEqual(jar(await set('age0=1; max-age=0')), ['dp=1', 'one=1']);
    const echo = await page.evaluate(async () => {
      await fetch('/api/set-cookie');
      return { cookie: document.cookie, sent: (await (await fetch('/api/echo')).json()).cookie };
    });
    assert.deepStrictEqual(jar(echo.cookie), ['dp=1', 'one=1', 'srv=1']);
    assert.deepStrictEqual(jar(echo.sent), ['hidden=1', 'one=1', 'srv=1']);

    const cs = await page.evaluate(async () => {
      if (!window.cookieStore) return null;
      await cookieStore.set('cs', 'v');
      const got = await cookieStore.get('cs');
      const doc = document.cookie;
      await cookieStore.delete('cs');
      return { value: got && got.value, doc, after: document.cookie, all: (await cookieStore.getAll()).map((c) => c.name).sort() };
    });
    if (cs) {
      assert.strictEqual(cs.value, 'v');
      assert.ok(cs.doc.includes('cs=v'));
      assert.ok(!cs.after.includes('cs='));
      assert.deepStrictEqual(cs.all, ['dp', 'one', 'srv']);
    }

    await page.goto(px(A, '/cookies/b/page'));
    await page.waitForFunction(() => window.__done === true);
    assert.deepStrictEqual(jar((await s.results(page)).cookie), ['one=1', 'pb=2', 'srv=1']);

    await page.goto(px(B, '/cookies/a/page'));
    await page.waitForFunction(() => window.__done === true);
    assert.deepStrictEqual(jar((await s.results(page)).cookie), [], 'another origin sees none of them');

    const browserCookies = (await s.context.cookies()).map((c) => c.name).sort();
    assert.deepStrictEqual(browserCookies.filter((n) => !n.startsWith('__p')), [], 'site cookies live in the proxy jar, not the browser');
    clean(s);
  });

  it('localStorage, sessionStorage, IndexedDB, CacheStorage, BroadcastChannel and Web Locks are isolated per real origin', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const a = await s.open(A, '/storage');
    const b = await s.open(B, '/storage');

    await a.evaluate(() => { localStorage.clear(); localStorage.setItem('shared', 'A'); localStorage.setItem('onlyA', '1'); localStorage.foo = 'bar'; });
    const rb = await b.evaluate(() => {
      localStorage.clear();
      localStorage.setItem('shared', 'B');
      return {
        onlyA: localStorage.getItem('onlyA'), prop: localStorage.onlyA, inA: 'onlyA' in localStorage, length: localStorage.length,
        keys: Object.keys(localStorage), json: JSON.stringify(localStorage), key0: localStorage.key(0), key1: localStorage.key(1),
      };
    });
    assert.deepStrictEqual(rb, { onlyA: null, prop: undefined, inA: false, length: 1, keys: ['shared'], json: '{"shared":"B"}', key0: 'shared', key1: null });
    const ra = await a.evaluate(() => {
      const r = {
        shared: localStorage.getItem('shared'), length: localStorage.length, keys: Object.keys(localStorage).sort(),
        json: JSON.parse(JSON.stringify(localStorage)), own: localStorage.hasOwnProperty('onlyA'),
        protoCall: Storage.prototype.getItem.call(localStorage, 'onlyA'), isStorage: localStorage instanceof Storage,
        tag: Object.prototype.toString.call(localStorage), getItemFn: typeof localStorage.getItem,
        spread: Object.assign({}, localStorage).foo,
      };
      delete localStorage.foo;
      r.afterDelete = localStorage.getItem('foo');
      localStorage.setItem('getItem', 'shadow');
      r.methodNotShadowed = typeof localStorage.getItem;
      localStorage.removeItem('getItem');
      return r;
    });
    assert.deepStrictEqual(ra, {
      shared: 'A', length: 3, keys: ['foo', 'onlyA', 'shared'], json: { shared: 'A', onlyA: '1', foo: 'bar' }, own: true,
      protoCall: '1', isStorage: true, tag: '[object Storage]', getItemFn: 'function', spread: 'bar', afterDelete: null,
      methodNotShadowed: 'function',
    });
    await a.evaluate(() => localStorage.clear());
    assert.strictEqual(await b.evaluate(() => localStorage.getItem('shared')), 'B', 'clear() only clears this origin');

    // sessionStorage is shared by the frames of one tab: a cross-origin child must not see ours.
    const host = await s.open(A, '/storage-host');
    const frames = { same: host.frames()[1], other: host.frames()[2] };
    await host.evaluate(() => sessionStorage.setItem('s', 'A'));
    assert.strictEqual(await frames.other.evaluate(() => sessionStorage.getItem('s')), null);
    assert.strictEqual(await frames.same.evaluate(() => sessionStorage.getItem('s')), 'A');
    await frames.other.evaluate(() => sessionStorage.setItem('s', 'B'));
    assert.strictEqual(await host.evaluate(() => sessionStorage.getItem('s')), 'A');

    // storage events: only for this origin's keys, with the page's own key names.
    await frames.same.evaluate(() => localStorage.setItem('evt', 'x'));
    await frames.other.evaluate(() => localStorage.setItem('evtB', 'y'));
    await host.waitForFunction(() => window.storageEvents.length > 0);
    await host.waitForTimeout(100);
    assert.deepStrictEqual(await host.evaluate(() => window.storageEvents), [{ key: 'evt', newValue: 'x' }]);

    // BroadcastChannel: the same-origin frame hears the host, the other origin does not.
    await host.evaluate(() => new BroadcastChannel('chan').postMessage('hello'));
    await frames.same.waitForFunction(() => window.bcGot.length > 0);
    await host.waitForTimeout(100);
    assert.deepStrictEqual(await frames.same.evaluate(() => window.bcGot), ['hello']);
    assert.deepStrictEqual(await frames.other.evaluate(() => window.bcGot), []);
    assert.strictEqual(await frames.same.evaluate(() => window.bc.name), 'chan');

    // IndexedDB
    const idbA = await a.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('db1', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('s');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve) => { const tx = db.transaction('s', 'readwrite'); tx.objectStore('s').put('va', 'k'); tx.oncomplete = resolve; });
      const name = db.name;
      db.close();
      return { name, list: (await indexedDB.databases()).map((d) => d.name) };
    });
    assert.deepStrictEqual(idbA, { name: 'db1', list: ['db1'] });
    const idbB = await b.evaluate(async () => {
      const before = (await indexedDB.databases()).map((d) => d.name);
      const db = await new Promise((resolve) => { const req = indexedDB.open('db1', 1); req.onsuccess = () => resolve(req.result); });
      const stores = db.objectStoreNames.length;
      db.close();
      await new Promise((resolve) => { const req = indexedDB.deleteDatabase('db1'); req.onsuccess = resolve; });
      return { before, stores };
    });
    assert.deepStrictEqual(idbB, { before: [], stores: 0 });
    assert.deepStrictEqual(await a.evaluate(async () => (await indexedDB.databases()).map((d) => d.name)), ['db1']);

    // CacheStorage
    const cacheA = await a.evaluate(async () => {
      const c = await caches.open('c1');
      await c.put('/api/echo?c=1', new Response('cached-a'));
      const hit = await caches.match('/api/echo?c=1');
      return { keys: await caches.keys(), has: await caches.has('c1'), hit: hit && await hit.text(), url: (await c.keys())[0].url };
    });
    assert.deepStrictEqual(cacheA, { keys: ['c1'], has: true, hit: 'cached-a', url: A + '/api/echo?c=1' });
    const cacheB = await b.evaluate(async () => ({ keys: await caches.keys(), has: await caches.has('c1'), hit: (await caches.match('/api/echo?c=1')) || null }));
    assert.deepStrictEqual(cacheB, { keys: [], has: false, hit: null });

    // Web Locks: a lock held by A does not block the same name on B.
    await a.evaluate(() => { navigator.locks.request('L', () => new Promise(() => {})); });
    await a.waitForFunction(async () => (await navigator.locks.query()).held.length === 1);
    assert.strictEqual(await b.evaluate(() => navigator.locks.request('L', { ifAvailable: true }, (l) => !!l)), true);
    assert.strictEqual(await a.evaluate(() => navigator.locks.request('L', { ifAvailable: true }, (l) => !!l)), false);
    assert.deepStrictEqual(await a.evaluate(async () => (await navigator.locks.query()).held.map((l) => l.name)), ['L']);
    clean(s);
  });

  it('same-origin about:blank, srcdoc and frames[] children run with the runtime', async (t) => {
    const s = await session(t);
    if (!s) return;
    await s.bundle();
    const { A, B } = ctx;
    const page = await s.open(A, '/blank');
    const r = await s.results(page);
    await page.waitForFunction(() => window.childFetch && window.srcdocInfo && window.frameInfo);
    const g = await page.evaluate(() => ({ childInfo: window.childInfo, childFetch: window.childFetch, framesInfo: window.framesInfo, srcdocInfo: window.srcdocInfo, frameInfo: window.frameInfo }));
    // document.open() gives the child the URL of the document that called it.
    assert.deepStrictEqual(g.childInfo, {
      href: A + '/blank', parentHref: A + '/blank', topPath: '/blank', origin: A, docUrl: A + '/blank', ls: 'parent-value',
      base: A + '/blank', cookie: 'string',
    });
    assert.strictEqual(g.childFetch, '/api/echo?t=blank');
    assert.deepStrictEqual(g.framesInfo, { parentPath: '/blank', ls: 'parent-value' });
    assert.deepStrictEqual(g.srcdocInfo, { href: 'about:srcdoc', parentPath: '/blank', runtime: true, base: A + '/blank' });
    assert.strictEqual(r.childImg, true);
    assert.strictEqual(r.childImgRaw, '/p/' + A + '/img/blank-child.png');
    assert.strictEqual(r.early, 'about:blank');
    // An iframe touched before it loaded keeps working once its proxied document replaces about:blank.
    assert.deepStrictEqual(g.frameInfo, {
      data: { frameInfo: true, href: B + '/frame-info', origin: B, ls: null, fi: 'B', imgRaw: '/p/' + B + '/img/frame-info.png', imgOk: true, cfgUrl: B + '/frame-info' },
      origin: B,
    });
    assert.ok(siteA.log.some((e) => e.path === '/img/srcdoc.png'));
    clean(s);
  });

  it('postMessage between proxied parent and child honours targetOrigin and reports real origins', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/pm-parent');
    const child = page.frames()[1];
    await child.waitForFunction(() => window.__done === true);
    await page.waitForFunction(() => window.got.length >= 3);
    await child.waitForFunction(() => window.got.length >= 1);
    await page.evaluate(() => { window.sendWrong(); window.sendRight(); });
    await child.waitForFunction(() => window.got.length >= 2);
    await page.waitForTimeout(100);
    assert.deepStrictEqual(await page.evaluate(() => window.got), [
      { data: 'to-parent-explicit', origin: B, sourceOk: true },
      { data: 'to-parent-star', origin: B, sourceOk: true },
      { data: 'to-parent-opts', origin: B, sourceOk: true },
    ]);
    assert.deepStrictEqual(await child.evaluate(() => window.got), [
      { data: { reply: 'to-parent-explicit' }, origin: A },
      { data: 'right-origin', origin: A },
    ]);
    clean(s);
  });

  it('document.referrer / URL / domain and hyperlink parts describe the real site', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/props-from');
    await Promise.all([page.waitForURL(px(A, '/props?x=1#frag')), page.click('#go')]);
    await page.waitForFunction(() => window.__done === true);
    const r = await s.results(page);
    assert.deepStrictEqual(r, {
      referrer: A + '/props-from', URL: A + '/props?x=1#frag', documentURI: A + '/props?x=1#frag', domain: '127.0.0.1',
      baseURI: A + '/props?x=1#frag', winOrigin: A,
      a: {
        href: 'https://user:pw@other.example:8443/p/a/t/h?query=1#hash', protocol: 'https:', host: 'other.example:8443',
        hostname: 'other.example', port: '8443', pathname: '/p/a/t/h', search: '?query=1', hash: '#hash',
        origin: 'https://other.example:8443', username: 'user', str: 'https://user:pw@other.example:8443/p/a/t/h?query=1#hash',
      },
      rel: { href: A + '/sub/page?x=2#y', hostname: '127.0.0.1', pathname: '/sub/page', origin: A, attr: '/sub/page?x=2#y' },
      changed: A + '/changed?x=2#y', changedRaw: '/p/' + A + '/changed?x=2#y', domainAfterSet: '127.0.0.1',
    });
    // The proxy home page is not a referrer the site should see.
    const direct = await s.open(A, '/props');
    assert.strictEqual((await s.results(direct)).referrer, '');
    clean(s);
  });

  it('CSS set from JS: style properties, cssText, setProperty, style attribute, <style>, constructable sheets, insertRule', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/css');
    const r = await s.results(page);
    for (let i = 1; i <= 9; i++) assert.strictEqual(r['d' + i], `url("${P}/p/${A}/img/css${i}.png")`, 'd' + i);
    assert.strictEqual(r.d4attr, 'background-image:url(/img/css4.png)');
    clean(s);
  });

  it('patched APIs keep native behaviour (subclassing, with-scopes, toString, instanceof)', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A, B } = ctx;
    const page = await s.open(A, '/fidelity?q=1');
    const r = await s.results(page);
    assert.deepStrictEqual(r, {
      fnSubclass: [7, true, true],
      fnCtor: [true, 'Function', 1, 'function'],
      reqSubclass: [true, true, A + '/fid/x'],
      reqCtor: [true, 'Request'],
      wsStatic: [1, 3, 'function'],
      nativeToString: [true, true, true, true, true],
      names: ['fetch', 1, 'setAttribute', 2],
      locKeys: true,
      locJson: '/fidelity',
      locInstance: [true, 'object', true, A + '/fidelity?q=1'],
      withDoc: '/fidelity', withObj: '/fidelity', withOwn: 'own', withArr: '/fidelity',
      plainObj: ['x', '/fidelity', undefined],
      destructure: ['/fidelity', '/fidelity'],
      srvAttr: ['/fid/target?x=1', A + '/fid/target?x=1', '/fid/target?x=1'],
      extAttr: B + '/ext',
      emptyA: ['', '', null],
      storageProto: ['1', 'p', 1],
      urlFromLocation: [A + '/rel', A + '/abs'],
      docLocSame: true,
      topSelf: [true, true],
      origin: [A, A, A],
      setAttrReturn: [undefined, '1', null],
      innerHTMLText: 'plain &amp; <b>bold</b>',
      textContentScript: '{"location":1}',
    });
    clean(s);
  });

  it('frame-busting pages stay inside the proxy', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/bust-parent', { wait: false });
    await page.waitForURL(px(A, '/buster'));
    const page2 = await s.open(A, '/bust-parent2', { wait: false });
    await page2.waitForURL(px(A, '/buster2'));
    const page3 = await s.open(A, '/bust-parent3');
    assert.strictEqual(page3.url(), px(A, '/bust-parent3'), 'same-host check does not bust');
    clean(s);
  });

  it('a page adding 5000 elements stays fast and the observer settles', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/perf');
    const r = await s.results(page);
    t.diagnostic(`append 5000: ${r.appendMs.toFixed(1)}ms, innerHTML 5000 rows: ${r.innerMs.toFixed(1)}ms, 10000 style writes: ${r.styleMs.toFixed(1)}ms`);
    assert.ok(r.appendMs < 1500, 'appendChild loop took ' + r.appendMs);
    assert.ok(r.innerMs < 1500, 'innerHTML took ' + r.innerMs);
    assert.ok(r.styleMs < 1500, 'style writes took ' + r.styleMs);
    assert.ok(r.boxBg.includes('/p/' + A + '/img/anim.png'), r.boxBg);
    assert.strictEqual(r.settled, true, 'mutations keep coming: ' + JSON.stringify(r.late));
    assert.strictEqual(r.last, '/item/4999');
    assert.strictEqual(r.lastRaw, '/p/' + A + '/item/4999');
    assert.strictEqual(r.rowRaw, '/p/' + A + '/row/4999');
    clean(s);
  });

  it('code built at runtime (Function, eval, string timers, script text, handlers) is rewritten', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    await s.bundle();
    const page = await s.open(A, '/eval');
    const r = await s.results(page);
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual(r, {
      hasRewriter: true, fn: '/eval', fn2: 'x', direct: '/eval', indirect: 'object', gen: '/eval', ocAttr: 'window.__oc = location.pathname',
      t: '/eval', s: '/eval', s2: A + '/eval', s3: '/eval', jsl: '/eval', oc: '/eval', dw: '/eval', fnToString: true,
    });
    clean(s);
  });

  it('toolbar: the address bar navigates and hide/show persists across loads', async (t) => {
    const s = await session(t);
    if (!s) return;
    const { A } = ctx;
    const page = await s.open(A, '/plain');
    const bar = page.locator('proxy-toolbar');
    const box = async () => (await bar.boundingBox());
    const wide = await box();
    assert.ok(wide && wide.width > 200, 'toolbar is shown');
    // Toggle sits at the left edge of the bar (closed shadow root: drive it by position).
    await page.mouse.click(wide.x + 18, wide.y + wide.height / 2);
    const narrow = await box();
    assert.ok(narrow.width < 80, 'toolbar collapsed: ' + narrow.width);
    await page.reload();
    await page.waitForFunction(() => window.__done === true);
    assert.ok((await box()).width < 80, 'collapsed state persisted');
    const n = await box();
    await page.mouse.click(n.x + n.width / 2, n.y + n.height / 2);
    const open = await box();
    assert.ok(open.width > 200);
    await page.mouse.click(open.x + open.width / 2, open.y + open.height / 2);
    await page.keyboard.press('Control+A');
    await page.keyboard.type(A + '/plain?via=toolbar');
    await Promise.all([page.waitForURL(px(A, '/plain?via=toolbar')), page.keyboard.press('Enter')]);
    assert.strictEqual(await page.textContent('#q'), '?via=toolbar');
    clean(s);
  });
});
