'use strict';

/*
 * Server-side browser engine (optional).
 *
 * The static rewriter handles most of the web, but some pages only assemble themselves after a
 * lot of JavaScript has run (heavy SPAs, infinite-scroll feeds, canvas apps). This module drives a
 * real headless Chromium through Playwright so the server can:
 *   - render a page to final HTML after its scripts run  (render)
 *   - capture a screenshot or PDF                         (screenshot, pdf)
 *   - run a scripted sequence of actions and extractions  (automate)
 *
 * Playwright is an OPTIONAL dependency. If it is not installed the module still loads and every
 * call rejects with a clear ENOBROWSER error, so the rest of the proxy keeps working with zero
 * npm dependencies. Install it with `npm run setup:browser` (see package.json) to switch it on.
 *
 * All outbound traffic goes through the same upstream proxy and SSRF guard as the rest of the
 * server: targets are validated before navigation, and private addresses stay blocked unless
 * ALLOW_PRIVATE is set.
 */

const baseConfig = require('./config');
const upstream = require('./upstream');

// Defaults used when config.js has not (yet) defined a browser key, so this module is self-contained.
const DEFAULTS = {
  browserModule: '',
  browserEngine: 'chromium',
  browserUserAgent: '',
  browserIdleMs: 60000,
  browserMaxPages: 4,
  browserTimeout: 30000,
  browserMaxTimeout: 120000,
  browserMaxSteps: 50,
};
const config = new Proxy(baseConfig, {
  get(target, prop) {
    const v = target[prop];
    if (v === undefined && prop in DEFAULTS) return DEFAULTS[prop];
    return v;
  },
});

class BrowserError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

let playwright = null;
let loadTried = false;
let loadError = null;

/** Locate Playwright in local or global node_modules without making it a hard dependency. */
function loadPlaywright() {
  if (loadTried) {
    if (!playwright) throw new BrowserError(loadError || 'Playwright is not installed. Run: npm run setup:browser', 'ENOBROWSER');
    return playwright;
  }
  loadTried = true;
  const names = [config.browserModule, 'playwright', 'playwright-core'].filter(Boolean);
  for (const name of names) {
    try { playwright = require(name); break; } catch (e) { loadError = e.message; }
  }
  if (!playwright) {
    try {
      const { execSync } = require('child_process');
      const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      playwright = require(require('path').join(root, 'playwright'));
    } catch (e) { loadError = loadError || e.message; }
  }
  if (!playwright) throw new BrowserError('Playwright is not installed. Run: npm run setup:browser', 'ENOBROWSER');
  return playwright;
}

function available() {
  try { loadPlaywright(); return true; } catch { return false; }
}

// --- browser lifecycle ------------------------------------------------------------------

let browserPromise = null;
let activePages = 0;
let idleTimer = null;

function proxyOption() {
  const info = upstream.proxyInfo;
  if (!info) return undefined;
  const server = `${info.secure ? 'https' : 'http'}://${info.host}:${info.port}`;
  const opt = { server };
  if (info.url.username) {
    opt.username = decodeURIComponent(info.url.username);
    opt.password = decodeURIComponent(info.url.password || '');
  }
  if (config.noProxy) opt.bypass = config.noProxy.split(',').map((s) => s.trim()).filter(Boolean).join(',');
  return opt;
}

async function getBrowser() {
  if (browserPromise) return browserPromise;
  const pw = loadPlaywright();
  const engine = pw[config.browserEngine] || pw.chromium;
  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--mute-audio'];
  browserPromise = engine.launch({
    headless: true,
    args: config.browserEngine === 'firefox' || config.browserEngine === 'webkit' ? undefined : args,
    proxy: proxyOption(),
  }).then((browser) => {
    browser.on('disconnected', () => { browserPromise = null; });
    return browser;
  }).catch((e) => {
    browserPromise = null;
    throw new BrowserError('Could not launch the browser engine: ' + e.message, 'EBROWSERLAUNCH');
  });
  return browserPromise;
}

/** Shut the browser down after a spell with no work, so idle servers hold no Chromium. */
function scheduleIdleShutdown() {
  if (idleTimer) clearTimeout(idleTimer);
  if (config.browserIdleMs <= 0) return;
  idleTimer = setTimeout(() => {
    if (activePages === 0 && browserPromise) {
      const p = browserPromise;
      browserPromise = null;
      p.then((b) => b.close()).catch(() => {});
    }
  }, config.browserIdleMs);
  idleTimer.unref();
}

async function close() {
  if (idleTimer) clearTimeout(idleTimer);
  const p = browserPromise;
  browserPromise = null;
  if (p) await p.then((b) => b.close()).catch(() => {});
}

/** Validate a target the same way the proxying path does (scheme + SSRF guard). */
function resolveTarget(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new BrowserError('Invalid URL', 'EBADURL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserError('Only http(s) URLs can be rendered', 'EBADURL');
  upstream.checkHostAllowed(url.hostname); // throws EBLOCKED for private hosts unless ALLOW_PRIVATE
  return url;
}

function clampTimeout(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return config.browserTimeout;
  return Math.min(n, config.browserMaxTimeout);
}

/**
 * Run `fn` with a fresh page, enforcing the page cap and feeding the server-side cookie jar in and
 * out so a browser render shares the user's logged-in session.
 * @param {object} opts { jar, target, extraHeaders, timeout }
 */
async function withPage(opts, fn) {
  if (activePages >= config.browserMaxPages) throw new BrowserError('The browser is busy; too many pages open', 'EBUSY');
  const browser = await getBrowser();
  activePages++;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let context;
  try {
    context = await browser.newContext({
      userAgent: opts.userAgent || config.browserUserAgent || undefined,
      locale: opts.locale || undefined,
      viewport: opts.viewport || { width: 1280, height: 800 },
      deviceScaleFactor: opts.deviceScaleFactor || 1,
      ignoreHTTPSErrors: false,
      bypassCSP: true,
      javaScriptEnabled: opts.javaScriptEnabled !== false,
    });
    context.setDefaultNavigationTimeout(clampTimeout(opts.timeout));
    context.setDefaultTimeout(clampTimeout(opts.timeout));
    if (opts.extraHeaders) await context.setExtraHTTPHeaders(opts.extraHeaders);
    if (opts.jar && opts.target) {
      const cookies = cookiesForContext(opts.jar, opts.target);
      if (cookies.length) await context.addCookies(cookies).catch(() => {});
    }
    const page = await context.newPage();
    const result = await fn(page, context);
    if (opts.jar && opts.target) await saveContextCookies(context, opts.jar, opts.target).catch(() => {});
    return result;
  } finally {
    if (context) await context.close().catch(() => {});
    activePages--;
    if (activePages === 0) scheduleIdleShutdown();
  }
}

// --- cookie jar bridge ------------------------------------------------------------------

function cookiesForContext(jar, target) {
  const list = [];
  for (const c of jar.cookies.values()) {
    if (c.expires !== null && c.expires <= Date.now()) continue;
    list.push({
      name: c.name,
      value: c.value,
      domain: c.hostOnly ? c.domain : '.' + c.domain,
      path: c.path,
      expires: c.expires ? Math.floor(c.expires / 1000) : -1,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite === 'none' ? 'None' : c.sameSite === 'strict' ? 'Strict' : 'Lax',
    });
  }
  return list;
}

async function saveContextCookies(context, jar, target) {
  const cookies = await context.cookies();
  for (const c of cookies) {
    const domain = c.domain.replace(/^\./, '');
    const attrs = [`${c.name}=${c.value}`, `Domain=${domain}`, `Path=${c.path || '/'}`];
    if (c.expires && c.expires > 0) attrs.push(`Expires=${new Date(c.expires * 1000).toUTCString()}`);
    if (c.httpOnly) attrs.push('HttpOnly');
    if (c.secure) attrs.push('Secure');
    if (c.sameSite) attrs.push(`SameSite=${c.sameSite}`);
    try { jar.set(attrs.join('; '), new URL((c.secure ? 'https://' : 'http://') + domain + (c.path || '/'))); } catch { /* ignore */ }
  }
}

// --- high-level operations --------------------------------------------------------------

const WAIT_UNTIL = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);

async function gotoTarget(page, url, opts) {
  const waitUntil = WAIT_UNTIL.has(opts.waitUntil) ? opts.waitUntil : 'networkidle';
  const resp = await page.goto(url.href, { waitUntil, referer: opts.referer }).catch(async (e) => {
    // networkidle can time out on pages that poll forever; fall back to a looser condition.
    if (waitUntil === 'networkidle' && /Timeout/i.test(e.message)) {
      return page.goto(url.href, { waitUntil: 'domcontentloaded' });
    }
    throw new BrowserError('Navigation failed: ' + e.message, 'ENAV');
  });
  if (opts.waitFor) {
    if (/^\d+$/.test(String(opts.waitFor))) await page.waitForTimeout(clampTimeout(opts.waitFor));
    else await page.waitForSelector(String(opts.waitFor)).catch(() => {});
  }
  return resp;
}

/** Render a page after its scripts run; returns { url, status, html }. */
async function render(rawUrl, opts = {}) {
  const url = resolveTarget(rawUrl);
  return withPage({ ...opts, target: url }, async (page) => {
    const resp = await gotoTarget(page, url, opts);
    const html = await page.content();
    return { url: page.url(), status: resp ? resp.status() : 0, html };
  });
}

/** Screenshot a page; returns { buffer, type, url }. */
async function screenshot(rawUrl, opts = {}) {
  const url = resolveTarget(rawUrl);
  return withPage({ ...opts, target: url }, async (page) => {
    await gotoTarget(page, url, opts);
    const type = opts.type === 'jpeg' ? 'jpeg' : 'png';
    const buffer = await page.screenshot({
      type,
      fullPage: opts.fullPage !== false,
      quality: type === 'jpeg' ? Math.min(100, Math.max(1, opts.quality || 80)) : undefined,
    });
    return { buffer, type, url: page.url() };
  });
}

/** Print a page to PDF (Chromium only); returns { buffer, url }. */
async function pdf(rawUrl, opts = {}) {
  const url = resolveTarget(rawUrl);
  return withPage({ ...opts, target: url }, async (page) => {
    await gotoTarget(page, url, opts);
    await page.emulateMedia({ media: 'screen' }).catch(() => {});
    const buffer = await page.pdf({
      format: opts.format || 'A4',
      printBackground: opts.printBackground !== false,
      landscape: Boolean(opts.landscape),
    });
    return { buffer, url: page.url() };
  });
}

// A deliberately small, safe automation vocabulary — no arbitrary code runs in the page.
const ACTIONS = {
  goto: (page, s) => page.goto(resolveTarget(s.url).href, { waitUntil: WAIT_UNTIL.has(s.waitUntil) ? s.waitUntil : 'load' }),
  click: (page, s) => page.click(s.selector, { button: s.button || 'left', clickCount: s.clickCount || 1 }),
  dblclick: (page, s) => page.dblclick(s.selector),
  fill: (page, s) => page.fill(s.selector, String(s.value == null ? '' : s.value)),
  type: (page, s) => page.type(s.selector, String(s.value == null ? '' : s.value), { delay: Math.min(s.delay || 0, 200) }),
  press: (page, s) => page.press(s.selector || 'body', String(s.key || 'Enter')),
  select: (page, s) => page.selectOption(s.selector, s.value),
  check: (page, s) => page.check(s.selector),
  uncheck: (page, s) => page.uncheck(s.selector),
  hover: (page, s) => page.hover(s.selector),
  scroll: (page, s) => page.evaluate(([x, y]) => window.scrollTo(x, y), [s.x || 0, s.y || 0]),
  waitForSelector: (page, s) => page.waitForSelector(s.selector, { state: s.state || 'visible' }),
  waitForTimeout: (page, s) => page.waitForTimeout(Math.min(Number(s.ms) || 0, 30000)),
  waitForNavigation: (page, s) => page.waitForLoadState(WAIT_UNTIL.has(s.waitUntil) ? s.waitUntil : 'load'),
  text: async (page, s) => ({ text: await page.textContent(s.selector) }),
  attr: async (page, s) => ({ value: await page.getAttribute(s.selector, s.name) }),
  html: async (page, s) => ({ html: s.selector ? await page.innerHTML(s.selector) : await page.content() }),
  count: async (page, s) => ({ count: await page.locator(s.selector).count() }),
  title: async (page) => ({ title: await page.title() }),
  url: async (page) => ({ url: page.url() }),
  screenshot: async (page, s) => ({ screenshot: (await page.screenshot({ fullPage: Boolean(s.fullPage), type: 'png' })).toString('base64'), encoding: 'base64' }),
};

/**
 * Run a scripted sequence of actions in one page and collect the results of every read step.
 * Steps are plain data ({action, selector, value, ...}); no page-side eval is exposed.
 * @param {Array} steps
 * @param {object} opts
 */
async function automate(steps, opts = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new BrowserError('No steps given', 'EBADSTEPS');
  if (steps.length > config.browserMaxSteps) throw new BrowserError(`Too many steps (max ${config.browserMaxSteps})`, 'EBADSTEPS');
  const first = steps[0];
  const startTarget = first && first.action === 'goto' && first.url ? resolveTarget(first.url) : (opts.url ? resolveTarget(opts.url) : null);
  return withPage({ ...opts, target: startTarget }, async (page) => {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] || {};
      const fn = ACTIONS[step.action];
      if (!fn) { results.push({ step: i, action: step.action, error: 'unknown action' }); if (opts.stopOnError !== false) break; continue; }
      try {
        const out = await fn(page, step);
        results.push({ step: i, action: step.action, ok: true, ...(out && typeof out === 'object' ? out : {}) });
      } catch (e) {
        results.push({ step: i, action: step.action, ok: false, error: e.message });
        if (opts.stopOnError !== false) break;
      }
    }
    return { url: page.url(), results };
  });
}

module.exports = {
  available, render, screenshot, pdf, automate, close, resolveTarget,
  BrowserError, ACTIONS, get activePages() { return activePages; },
};
