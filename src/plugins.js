'use strict';

/**
 * Plugin system. A plugin is a folder under PLUGINS_DIR:
 *
 *   plugins/<id>/plugin.json   manifest: name, version, description, main, client, settings,
 *                              toolbar, sites, allFrames
 *   plugins/<id>/index.js      module.exports = (x70) => ({ ...hooks })  (or a plain object)
 *   plugins/<id>/client.js     optional, runs in proxied pages as (function (x70) { ... })
 *
 * Server hooks (all optional; any may be async unless noted):
 *   onRequest(ctx)          before a request goes upstream. Return { block }, { redirect }
 *                           or { url } to stop, redirect or retarget it; ctx.setHeader() and
 *                           ctx.removeHeader() edit the upstream request headers.
 *   onResponseHeaders(ctx)  synchronous; edit ctx.headers (sent to the browser) in place.
 *   transformHtml / transformCss / transformJs (text, ctx) -> string
 *                           runs on the site's original text, before the proxy rewrites it,
 *                           so URLs a plugin adds are proxied like the site's own.
 *   route(req, res, ctx)    answers /__proxy/x/<id>/<path>.
 *   onEnable() / onDisable() / onSettings(settings)
 *
 * Plugins are trusted code running in the proxy process: a hook that throws or times out is
 * contained and counted, and a plugin that keeps failing is switched off, but nothing stops a
 * plugin from doing what any Node module can. Only install plugins you have read.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SETTING_TYPES = new Set(['string', 'text', 'number', 'boolean', 'select', 'color']);
const HOOKS = ['onRequest', 'onResponseHeaders', 'transformHtml', 'transformCss', 'transformJs', 'route'];
const TRANSFORM_HOOK = { html: 'transformHtml', css: 'transformCss', js: 'transformJs' };

function timeout(ms, what) {
  let timer;
  const p = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`${what} timed out after ${ms}ms`), { code: 'EPLUGINTIMEOUT' })), ms);
  });
  p.cancel = () => clearTimeout(timer);
  return p;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/** Site patterns: "*" (everything), "example.com" (it and its subdomains), "!pattern" (exclude). */
function normaliseSites(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const raw of list) {
    let s = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!s) continue;
    const neg = s.startsWith('!');
    if (neg) s = s.slice(1).trim();
    s = s.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
    if (s !== '*' && !/^[a-z0-9.-]+$/.test(s)) continue;
    out.push((neg ? '!' : '') + s);
  }
  return [...new Set(out)];
}

function hostMatches(host, pattern) {
  return pattern === '*' || host === pattern || host.endsWith('.' + pattern);
}

function siteAllowed(sites, url) {
  let host;
  try { host = (typeof url === 'string' ? new URL(url) : url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  let ok = false;
  for (const p of sites) {
    if (p.startsWith('!')) { if (hostMatches(host, p.slice(1))) return false; } else if (hostMatches(host, p)) ok = true;
  }
  return ok;
}

/** Coerce one setting value to its declared type; returns undefined when it cannot be. */
function coerceSetting(spec, v) {
  switch (spec.type) {
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'on' || v === 1 || v === '1') return true;
      if (v === 'false' || v === 'off' || v === 0 || v === '0' || v === '') return false;
      return undefined;
    case 'number': {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
      if (!Number.isFinite(n)) return undefined;
      if (typeof spec.min === 'number' && n < spec.min) return spec.min;
      if (typeof spec.max === 'number' && n > spec.max) return spec.max;
      return n;
    }
    case 'select': {
      const opts = (spec.options || []).map((o) => (typeof o === 'object' && o ? o.value : o));
      return opts.some((o) => String(o) === String(v)) ? opts.find((o) => String(o) === String(v)) : undefined;
    }
    case 'color':
      return typeof v === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(v) ? v.toLowerCase() : undefined;
    default:
      if (v == null) return undefined;
      return String(v).slice(0, spec.maxLength || 10000);
  }
}

function defaultsOf(schema) {
  const out = {};
  for (const [k, spec] of Object.entries(schema)) {
    const d = spec.default !== undefined ? coerceSetting(spec, spec.default) : undefined;
    out[k] = d !== undefined ? d : ({ boolean: false, number: 0, select: (spec.options || [])[0] } [spec.type] ?? '');
    if (spec.type === 'select' && out[k] && typeof out[k] === 'object') out[k] = out[k].value;
  }
  return out;
}

function validateManifest(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must be a JSON object');
  const m = {
    id,
    name: String(raw.name || id).slice(0, 80),
    version: String(raw.version || '0.0.0').slice(0, 32),
    description: String(raw.description || '').slice(0, 500),
    author: raw.author ? String(raw.author).slice(0, 80) : '',
    main: raw.main === null ? null : String(raw.main || 'index.js'),
    client: raw.client ? String(raw.client) : null,
    allFrames: Boolean(raw.allFrames),
    sites: normaliseSites(raw.sites) || ['*'],
    settings: {},
    toolbar: [],
  };
  for (const f of [m.main, m.client]) {
    if (f && (path.isAbsolute(f) || f.split(/[\\/]/).includes('..'))) throw new Error(`file "${f}" must stay inside the plugin folder`);
  }
  if (raw.settings && typeof raw.settings === 'object') {
    for (const [k, s] of Object.entries(raw.settings)) {
      if (!/^[A-Za-z_][\w-]{0,63}$/.test(k) || !s || typeof s !== 'object') throw new Error(`invalid setting "${k}"`);
      const type = s.type || 'string';
      if (!SETTING_TYPES.has(type)) throw new Error(`setting "${k}": unknown type "${type}"`);
      if (type === 'select' && !(Array.isArray(s.options) && s.options.length)) throw new Error(`setting "${k}": select needs options`);
      m.settings[k] = {
        type,
        label: String(s.label || k).slice(0, 120),
        description: s.description ? String(s.description).slice(0, 300) : '',
        default: s.default,
        options: type === 'select' ? s.options : undefined,
        min: typeof s.min === 'number' ? s.min : undefined,
        max: typeof s.max === 'number' ? s.max : undefined,
        step: typeof s.step === 'number' ? s.step : undefined,
        maxLength: typeof s.maxLength === 'number' ? s.maxLength : undefined,
        // Public settings are handed to the plugin's client script (visible to proxied pages).
        public: Boolean(s.public),
        secret: Boolean(s.secret),
      };
    }
  }
  if (Array.isArray(raw.toolbar)) {
    for (const b of raw.toolbar.slice(0, 8)) {
      if (!b || typeof b !== 'object') continue;
      const action = String(b.id || b.action || '').slice(0, 64);
      if (!/^[\w-]+$/.test(action)) throw new Error('toolbar buttons need an id of letters, digits, - or _');
      let href = b.href ? String(b.href) : '';
      // Buttons may only navigate within the proxy (a plugin page) or to a proxied site.
      if (href && !/^\/__proxy\//.test(href) && !/^https?:\/\//i.test(href)) throw new Error(`toolbar "${action}": href must start with /__proxy/ or http(s)://`);
      m.toolbar.push({ action, label: String(b.label || action).slice(0, 4), title: String(b.title || b.label || action).slice(0, 80), href });
    }
  }
  return m;
}

/** Per-plugin key/value storage persisted as a JSON file. */
class PluginStorage {
  constructor(file, persist) {
    this.file = file;
    this.persist = persist;
    this.data = persist ? readJson(file, {}) : {};
    if (!this.data || typeof this.data !== 'object' || Array.isArray(this.data)) this.data = {};
    this.timer = null;
    this.dirty = false;
  }
  get(key, fallback) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback; }
  set(key, value) {
    if (value === undefined) return this.delete(key);
    this.data[key] = JSON.parse(JSON.stringify(value));
    this.schedule();
    return value;
  }
  delete(key) { const had = key in this.data; delete this.data[key]; if (had) this.schedule(); return had; }
  keys() { return Object.keys(this.data); }
  all() { return JSON.parse(JSON.stringify(this.data)); }
  clear() { this.data = {}; this.schedule(); }
  schedule() {
    this.dirty = true;
    if (!this.persist || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 250);
    this.timer.unref?.();
  }
  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.persist || !this.dirty) return;
    this.dirty = false;
    try { writeJsonAtomic(this.file, this.data); } catch (e) { console.error('[plugins] could not save storage', this.file, e.message); }
  }
}

class PluginManager {
  /**
   * @param {object} o
   * @param {string} o.dir          folder holding one sub-folder per plugin
   * @param {string} o.dataDir      where state (plugins.json) and per-plugin storage live
   * @param {boolean} [o.persist]   save state and storage to disk
   * @param {string[]} [o.enable]   plugin ids to switch on at startup
   * @param {number} [o.hookTimeoutMs]
   * @param {number} [o.maxErrors]  consecutive hook failures before a plugin is switched off
   */
  constructor(o = {}) {
    this.dir = o.dir;
    this.dataDir = o.dataDir;
    this.persist = o.persist !== false;
    this.enableOnStart = new Set(o.enable || []);
    this.hookTimeoutMs = o.hookTimeoutMs || 3000;
    this.maxErrors = o.maxErrors || 5;
    this.disabled = Boolean(o.disabled);
    this.stateFile = this.dataDir ? path.join(this.dataDir, 'plugins.json') : null;
    this.plugins = new Map();
    this.state = { plugins: {} };
    this.revision = 0;
    this.logger = o.logger || console;
  }

  // ---- loading ----------------------------------------------------------------------------

  load() {
    this.state = (this.persist && this.stateFile && readJson(this.stateFile, null)) || { plugins: {} };
    if (!this.state.plugins || typeof this.state.plugins !== 'object') this.state.plugins = {};
    for (const id of this.enableOnStart) {
      this.state.plugins[id] = { ...(this.state.plugins[id] || {}), enabled: true };
    }
    this.scan();
    return this;
  }

  /** (Re)read every plugin folder. Running plugins are stopped first and started again after. */
  scan() {
    for (const p of this.plugins.values()) this.stop(p);
    this.plugins.clear();
    if (this.disabled || !this.dir) { this.bump(); return; }
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch (e) {
      if (e.code !== 'ENOENT') this.logger.error('[plugins] cannot read', this.dir, e.message);
    }
    for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!ent.isDirectory() || ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
      if (!ID_RE.test(ent.name)) {
        this.logger.error(`[plugins] skipping "${ent.name}": folder names must be lowercase letters, digits, - or _`);
        continue;
      }
      this.plugins.set(ent.name, this.loadOne(ent.name));
    }
    for (const p of this.plugins.values()) if (this.entry(p.id).enabled && !p.error) this.start(p);
    this.bump();
  }

  loadOne(id) {
    const dir = path.join(this.dir, id);
    const p = {
      id, dir, manifest: null, impl: null, error: null, errors: 0, lastError: null,
      running: false, storage: null, clientSource: null, hooks: new Set(),
    };
    try {
      const file = path.join(dir, 'plugin.json');
      if (!fs.existsSync(file)) throw new Error('missing plugin.json');
      let raw;
      try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`plugin.json: ${e.message}`); }
      p.manifest = validateManifest(raw, id);
      p.storage = new PluginStorage(path.join(this.dataDir || dir, 'plugins', `${id}.json`), this.persist && Boolean(this.dataDir));
      if (p.manifest.client) {
        const cf = path.join(dir, p.manifest.client);
        if (!fs.existsSync(cf)) throw new Error(`client script "${p.manifest.client}" not found`);
        p.clientSource = fs.readFileSync(cf, 'utf8');
      }
      if (p.manifest.main) {
        const mainFile = require.resolve(path.join(dir, p.manifest.main));
        // Fresh code on every scan: drop this plugin's modules from the require cache.
        for (const k of Object.keys(require.cache)) if (k.startsWith(dir + path.sep)) delete require.cache[k];
        let mod = require(mainFile);
        if (mod && mod.__esModule && mod.default) mod = mod.default;
        const impl = typeof mod === 'function' ? mod(this.api(p)) : mod;
        if (!impl || typeof impl !== 'object') throw new Error('main module must export an object or a function returning one');
        p.impl = impl;
        for (const h of HOOKS) if (typeof impl[h] === 'function') p.hooks.add(h);
      } else {
        p.impl = {};
      }
    } catch (e) {
      p.error = e.message;
      this.logger.error(`[plugins] ${id}: ${e.message}`);
    }
    return p;
  }

  /** The object a plugin's factory receives. */
  api(p) {
    const mgr = this;
    return {
      id: p.id,
      dir: p.dir,
      get manifest() { return p.manifest; },
      get settings() { return mgr.settingsOf(p); },
      get storage() { return p.storage; },
      matches: (url) => siteAllowed(mgr.sitesOf(p), url),
      log: (...a) => mgr.logger.log(`[plugin:${p.id}]`, ...a),
      error: (...a) => mgr.logger.error(`[plugin:${p.id}]`, ...a),
    };
  }

  start(p) {
    if (p.running || p.error) return;
    p.running = true;
    p.errors = 0;
    this.callLifecycle(p, 'onEnable');
  }

  stop(p) {
    if (!p.running) return;
    p.running = false;
    this.callLifecycle(p, 'onDisable');
    p.storage?.flush();
  }

  callLifecycle(p, name, ...args) {
    const fn = p.impl && p.impl[name];
    if (typeof fn !== 'function') return;
    try {
      const r = fn.apply(p.impl, args);
      if (r && typeof r.then === 'function') r.catch((e) => this.fail(p, name, e));
    } catch (e) { this.fail(p, name, e); }
  }

  // ---- state ------------------------------------------------------------------------------

  entry(id) {
    return this.state.plugins[id] || {};
  }

  settingsOf(p) {
    const schema = p.manifest ? p.manifest.settings : {};
    const saved = this.entry(p.id).settings || {};
    const out = defaultsOf(schema);
    for (const [k, spec] of Object.entries(schema)) {
      if (saved[k] === undefined) continue;
      const v = coerceSetting(spec, saved[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  sitesOf(p) {
    const s = this.entry(p.id).sites;
    return Array.isArray(s) ? s : (p.manifest ? p.manifest.sites : ['*']);
  }

  bump() {
    this.revision++;
    const h = crypto.createHash('sha1');
    for (const p of this.plugins.values()) {
      if (!p.running) continue;
      h.update(p.id + '\0' + (p.manifest?.version || '') + '\0' + JSON.stringify(this.settingsOf(p)) + '\0' + this.sitesOf(p).join(',') + '\0');
      if (p.clientSource) h.update(p.clientSource);
    }
    this.stateHash = this.anyRunning() ? h.digest('hex').slice(0, 8) : '';
  }

  anyRunning() {
    for (const p of this.plugins.values()) if (p.running) return true;
    return false;
  }

  /** Mixes the plugin state into a rewriter version tag, so caches drop stale transformed bodies. */
  tag(base) {
    if (!this.stateHash) return base;
    return crypto.createHash('sha1').update(base + ':' + this.stateHash).digest('hex').slice(0, 8);
  }

  save() {
    this.dirty = false;
    if (!this.persist || !this.stateFile) return;
    try { writeJsonAtomic(this.stateFile, this.state); } catch (e) { this.logger.error('[plugins] could not save state:', e.message); }
  }

  flush() {
    if (this.dirty) this.save();
    for (const p of this.plugins.values()) p.storage?.flush();
  }

  /**
   * Change a plugin: { enabled, settings, sites }. Unknown settings are rejected. Returns the
   * plugin's public description.
   */
  update(id, change = {}) {
    const p = this.plugins.get(id);
    if (!p) throw Object.assign(new Error(`No plugin "${id}"`), { status: 404 });
    const cur = { ...this.entry(id) };
    let settingsChanged = false;
    if (change.settings !== undefined) {
      if (!change.settings || typeof change.settings !== 'object' || Array.isArray(change.settings)) {
        throw Object.assign(new Error('settings must be an object'), { status: 400 });
      }
      const schema = p.manifest ? p.manifest.settings : {};
      const next = { ...(cur.settings || {}) };
      for (const [k, v] of Object.entries(change.settings)) {
        const spec = schema[k];
        if (!spec) throw Object.assign(new Error(`Unknown setting "${k}"`), { status: 400 });
        // A blank secret in a form means "keep the stored one".
        if (spec.secret && v === '') continue;
        const c = coerceSetting(spec, v);
        if (c === undefined) throw Object.assign(new Error(`Invalid value for "${spec.label}"`), { status: 400 });
        next[k] = c;
      }
      cur.settings = next;
      settingsChanged = true;
    }
    if (change.sites !== undefined) {
      const s = normaliseSites(typeof change.sites === 'string' ? change.sites.split(/[\s,]+/) : change.sites);
      if (!s) throw Object.assign(new Error('sites must be a list'), { status: 400 });
      cur.sites = s;
    }
    if (change.enabled !== undefined) {
      cur.enabled = Boolean(change.enabled);
      if (cur.enabled && p.error) throw Object.assign(new Error(`Cannot enable "${id}": ${p.error}`), { status: 409 });
    }
    this.state.plugins[id] = cur;
    if (cur.enabled && !p.running) this.start(p);
    else if (!cur.enabled && p.running) this.stop(p);
    else if (settingsChanged && p.running) this.callLifecycle(p, 'onSettings', this.settingsOf(p));
    if (change.enabled === true) p.lastError = null;
    this.save();
    this.bump();
    return this.describe(p);
  }

  /** Reload one plugin (or all of them) from disk. */
  reload(id) {
    if (!id) { this.scan(); return this.list(); }
    const old = this.plugins.get(id);
    if (old) this.stop(old);
    if (!fs.existsSync(path.join(this.dir, id, 'plugin.json'))) {
      this.plugins.delete(id);
      this.bump();
      throw Object.assign(new Error(`No plugin "${id}"`), { status: 404 });
    }
    const p = this.loadOne(id);
    this.plugins.set(id, p);
    if (this.entry(id).enabled && !p.error) this.start(p);
    this.bump();
    return this.describe(p);
  }

  describe(p) {
    const m = p.manifest;
    const settings = this.settingsOf(p);
    for (const [k, spec] of Object.entries(m ? m.settings : {})) {
      if (spec.secret) settings[k] = '';
    }
    return {
      id: p.id,
      name: m ? m.name : p.id,
      version: m ? m.version : '',
      description: m ? m.description : '',
      author: m ? m.author : '',
      enabled: Boolean(this.entry(p.id).enabled),
      running: p.running,
      error: p.error,
      lastError: p.lastError,
      hooks: [...p.hooks],
      client: Boolean(p.clientSource),
      toolbar: m ? m.toolbar : [],
      sites: this.sitesOf(p),
      schema: m ? Object.fromEntries(Object.entries(m.settings).map(([k, s]) => [k, { ...s, default: undefined, hasValue: s.secret ? Boolean(this.settingsOf(p)[k]) : undefined }])) : {},
      settings,
    };
  }

  list() {
    return [...this.plugins.values()].map((p) => this.describe(p));
  }

  // ---- running hooks ----------------------------------------------------------------------

  fail(p, hook, err) {
    p.errors++;
    p.lastError = { hook, message: String(err && err.message || err), at: new Date().toISOString() };
    this.logger.error(`[plugin:${p.id}] ${hook} failed:`, err && err.stack || err);
    if (p.errors >= this.maxErrors && p.running) {
      this.logger.error(`[plugin:${p.id}] switched off after ${p.errors} failures in a row`);
      this.state.plugins[p.id] = { ...this.entry(p.id), enabled: false };
      p.lastError.disabled = true;
      this.stop(p);
      this.save();
      this.bump();
    }
  }

  /** Running plugins with the given hook that apply to this URL, in load order. */
  active(hook, url) {
    const out = [];
    if (!this.stateHash) return out;
    for (const p of this.plugins.values()) {
      if (!p.running) continue;
      if (hook && !p.hooks.has(hook)) continue;
      if (url && !siteAllowed(this.sitesOf(p), url)) continue;
      out.push(p);
    }
    return out;
  }

  wants(hook, url) {
    return this.active(hook, url).length > 0;
  }

  async call(p, hook, args) {
    const t = timeout(this.hookTimeoutMs, `${hook}`);
    try {
      const r = await Promise.race([Promise.resolve().then(() => p.impl[hook](...args)), t]);
      p.errors = 0;
      return { ok: true, value: r };
    } catch (e) {
      this.fail(p, hook, e);
      return { ok: false };
    } finally {
      t.cancel();
    }
  }

  /**
   * Run onRequest hooks. Returns { block, redirect, url, setHeaders, removeHeaders, touched }.
   * The first plugin that blocks or redirects wins; a { url } retargets the request and later
   * plugins see the new URL.
   */
  async runRequest(info) {
    const result = { setHeaders: {}, removeHeaders: new Set(), url: info.url, touched: false };
    for (const p of this.active('onRequest', info.url)) {
      if (!siteAllowed(this.sitesOf(p), result.url)) continue;
      const ctx = {
        ...info,
        url: result.url,
        settings: this.settingsOf(p),
        setHeader(name, value) { const k = String(name).toLowerCase(); result.removeHeaders.delete(k); result.setHeaders[k] = String(value); },
        removeHeader(name) { const k = String(name).toLowerCase(); delete result.setHeaders[k]; result.removeHeaders.add(k); },
      };
      const r = await this.call(p, 'onRequest', [ctx]);
      if (!r.ok || !r.value || typeof r.value !== 'object') continue;
      const v = r.value;
      if (v.block) {
        const b = typeof v.block === 'object' ? v.block : {};
        result.block = {
          plugin: p.manifest.name,
          status: Number.isInteger(b.status) && b.status >= 200 && b.status <= 599 ? b.status : 403,
          body: b.body !== undefined ? String(b.body) : null,
          contentType: b.contentType ? String(b.contentType) : 'text/plain; charset=utf-8',
          reason: b.reason ? String(b.reason) : '',
        };
        return result;
      }
      if (v.redirect) {
        try { result.redirect = new URL(String(v.redirect), result.url).href; return result; } catch { /* ignore a bad URL */ }
      }
      if (v.url) {
        try {
          const u = new URL(String(v.url), result.url);
          if (/^https?:$/.test(u.protocol)) { result.url = u.href; result.touched = true; }
        } catch { /* ignore */ }
      }
    }
    if (Object.keys(result.setHeaders).length || result.removeHeaders.size) result.touched = true;
    return result;
  }

  /** onResponseHeaders hooks (synchronous). Returns true if any plugin ran. */
  runResponseHeaders(info) {
    const list = this.active('onResponseHeaders', info.url);
    for (const p of list) {
      try {
        const r = p.impl.onResponseHeaders({ ...info, settings: this.settingsOf(p) });
        if (r && typeof r.then === 'function') {
          r.catch(() => {});
          throw new Error('onResponseHeaders must be synchronous');
        }
        p.errors = 0;
      } catch (e) { this.fail(p, 'onResponseHeaders', e); }
    }
    return list.length > 0;
  }

  /** Run transformHtml/Css/Js. Returns { text, touched }. */
  async transform(kind, text, info) {
    const hook = TRANSFORM_HOOK[kind];
    if (!hook) return { text, touched: false };
    let touched = false;
    for (const p of this.active(hook, info.url)) {
      if (kind === 'html' && info.dest && info.dest !== 'document' && !p.manifest.allFrames) continue;
      const r = await this.call(p, hook, [text, { ...info, kind, settings: this.settingsOf(p) }]);
      if (r.ok && typeof r.value === 'string' && r.value !== text) { text = r.value; touched = true; }
    }
    return { text, touched };
  }

  /** What a proxied page needs: toolbar buttons and the client scripts to load. */
  pageInfo(url, { topLevel, origin }) {
    const toolbar = [];
    const scripts = [];
    for (const p of this.active(null, url)) {
      if (topLevel) for (const b of p.manifest.toolbar) toolbar.push({ plugin: p.id, ...b });
      if (p.clientSource && (topLevel || p.manifest.allFrames)) scripts.push(`${origin}/__proxy/x/${p.id}/client.js?v=${this.stateHash}`);
    }
    return { toolbar, scripts };
  }

  /** The plugin's client.js wrapped with its x70 helper object. */
  clientScript(id, origin) {
    const p = this.plugins.get(id);
    if (!p || !p.running || !p.clientSource) return null;
    const pub = {};
    const settings = this.settingsOf(p);
    for (const [k, spec] of Object.entries(p.manifest.settings)) if (spec.public && !spec.secret) pub[k] = settings[k];
    const meta = JSON.stringify({ id: p.id, name: p.manifest.name, version: p.manifest.version, base: `${origin}/__proxy/x/${p.id}/`, settings: pub })
      .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return `;(function (x70) {\n${p.clientSource}\n})((function (m) {
  var G = window;
  m.url = function () { try { return G.__proxy ? G.__proxy.currentUrl() : G.location.href; } catch (e) { return G.location.href; } };
  m.endpoint = function (p) { return m.base + String(p || '').replace(/^\\/+/, ''); };
  m.fetch = function (p, o) { return G.fetch(m.endpoint(p), Object.assign({ credentials: 'same-origin' }, o || {})); };
  m.onToolbar = function (action, fn) {
    if (typeof action === 'function') { fn = action; action = null; }
    G.addEventListener('x70:toolbar', function (e) {
      var d = e.detail || {};
      if (d.plugin === m.id && (!action || d.action === action)) fn(d.action, e);
    });
  };
  m.storage = {
    get: function (k, d) { try { var v = G.localStorage.getItem('__x70p:' + m.id + ':' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { G.localStorage.setItem('__x70p:' + m.id + ':' + k, JSON.stringify(v)); } catch (e) {} }
  };
  return m;
})(${meta}));
`;
  }

  /** A plugin's own route. Returns false when nothing answered. */
  async route(id, req, res, ctx) {
    const p = this.plugins.get(id);
    if (!p || !p.running || !p.hooks.has('route')) return false;
    const r = await this.call(p, 'route', [req, res, { ...ctx, settings: this.settingsOf(p), storage: p.storage }]);
    if (!r.ok && !res.headersSent && !res.destroyed) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Plugin "${id}" failed`);
    }
    return true;
  }
}

module.exports = { PluginManager, normaliseSites, siteAllowed, coerceSetting, validateManifest, ID_RE };
