'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_COOKIES_PER_JAR = 3000;
const MAX_COOKIE_SIZE = 8192;

function canonicalHost(h) {
  return String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function isIp(h) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

function domainMatch(host, domain) {
  if (host === domain) return true;
  return !isIp(host) && host.endsWith('.' + domain);
}

function defaultPath(urlPath) {
  if (!urlPath || urlPath[0] !== '/') return '/';
  const idx = urlPath.lastIndexOf('/');
  return idx <= 0 ? '/' : urlPath.slice(0, idx);
}

function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  if (!reqPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
}

/** Parse one Set-Cookie header value relative to the URL that set it. */
function parseSetCookie(str, url, now = Date.now()) {
  if (!str || str.length > MAX_COOKIE_SIZE) return null;
  const parts = str.split(';');
  const first = parts.shift();
  const eq = first.indexOf('=');
  let name, value;
  if (eq === -1) { name = ''; value = first.trim(); } else { name = first.slice(0, eq).trim(); value = first.slice(eq + 1).trim(); }
  if (!name && !value) return null;
  const host = canonicalHost(url.hostname);
  const c = {
    name, value,
    domain: host, hostOnly: true,
    path: defaultPath(url.pathname),
    expires: null, secure: false, httpOnly: false, sameSite: 'lax',
    created: now,
  };
  let maxAgeSeen = false;
  for (const p of parts) {
    const i = p.indexOf('=');
    const key = (i === -1 ? p : p.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : p.slice(i + 1).trim();
    switch (key) {
      case 'expires': {
        if (maxAgeSeen) break;
        const t = Date.parse(val);
        if (!Number.isNaN(t)) c.expires = t;
        break;
      }
      case 'max-age': {
        if (!/^-?\d+$/.test(val)) break;
        const s = parseInt(val, 10);
        c.expires = s <= 0 ? 0 : now + s * 1000;
        maxAgeSeen = true;
        break;
      }
      case 'domain': {
        const d = canonicalHost(val.replace(/^\./, ''));
        if (!d) break;
        if (!domainMatch(host, d)) return null; // foreign domain: reject
        if (!d.includes('.') && d !== host) return null; // public-suffix-ish ("com")
        c.domain = d;
        c.hostOnly = false;
        break;
      }
      case 'path':
        if (val.startsWith('/')) c.path = val;
        break;
      case 'secure': c.secure = true; break;
      case 'httponly': c.httpOnly = true; break;
      case 'samesite': c.sameSite = val.toLowerCase() || 'lax'; break;
      default: break;
    }
  }
  if (name.startsWith('__Secure-') && !c.secure) return null;
  if (name.startsWith('__Host-') && (!c.secure || !c.hostOnly || c.path !== '/')) return null;
  return c;
}

class Jar {
  constructor(data) {
    this.cookies = new Map();
    this.lastUsed = Date.now();
    if (data && Array.isArray(data.cookies)) {
      for (const c of data.cookies) this.cookies.set(Jar.key(c), c);
      this.lastUsed = data.lastUsed || this.lastUsed;
    }
  }

  static key(c) { return c.name + '\u0000' + c.domain + '\u0000' + c.path; }

  /** Store a Set-Cookie string. `fromScript` emulates document.cookie semantics. */
  set(str, url, { fromScript = false } = {}) {
    const now = Date.now();
    const c = parseSetCookie(str, url, now);
    if (!c) return false;
    if (fromScript && c.httpOnly) return false;
    const key = Jar.key(c);
    const old = this.cookies.get(key);
    if (old) {
      if (fromScript && old.httpOnly) return false;
      c.created = old.created;
    }
    if (c.expires !== null && c.expires <= now) {
      this.cookies.delete(key);
      return true;
    }
    this.cookies.set(key, c);
    if (this.cookies.size > MAX_COOKIES_PER_JAR) this.evict();
    return true;
  }

  evict() {
    const sorted = [...this.cookies.entries()].sort((a, b) => a[1].created - b[1].created);
    for (const [k] of sorted.slice(0, this.cookies.size - MAX_COOKIES_PER_JAR)) this.cookies.delete(k);
  }

  /** Cookies that should be sent for a request to `url`. */
  match(url, { includeHttpOnly = true } = {}) {
    const now = Date.now();
    const host = canonicalHost(url.hostname);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    const reqPath = url.pathname || '/';
    const res = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) { this.cookies.delete(k); continue; }
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(reqPath, c.path)) continue;
      if (c.secure && !secure && host !== 'localhost') continue;
      if (!includeHttpOnly && c.httpOnly) continue;
      res.push(c);
    }
    res.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    this.lastUsed = now;
    return res;
  }

  header(url, opts) {
    return this.match(url, opts).map((c) => (c.name ? c.name + '=' + c.value : c.value)).join('; ');
  }

  clear() { this.cookies.clear(); }

  toJSON() {
    const persistent = [...this.cookies.values()].filter((c) => c.expires !== null);
    return { lastUsed: this.lastUsed, cookies: persistent };
  }
}

class SessionStore {
  constructor({ file, persist, ttlMs }) {
    this.file = file;
    this.persist = persist;
    this.ttlMs = ttlMs;
    this.jars = new Map();
    this.dirty = false;
    if (persist) this.load();
  }

  static newId() { return crypto.randomBytes(18).toString('base64url'); }

  get(id) {
    let jar = this.jars.get(id);
    if (!jar) {
      jar = new Jar();
      this.jars.set(id, jar);
    }
    this.dirty = true;
    return jar;
  }

  delete(id) { this.jars.delete(id); this.dirty = true; }

  sweep() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, jar] of this.jars) if (jar.lastUsed < cutoff) this.jars.delete(id);
  }

  load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const [id, j] of Object.entries(data)) this.jars.set(id, new Jar(j));
      this.sweep();
    } catch { /* first run or unreadable */ }
  }

  save() {
    if (!this.persist || !this.dirty) return;
    this.sweep();
    const obj = {};
    for (const [id, jar] of this.jars) {
      const j = jar.toJSON();
      if (j.cookies.length) obj[id] = j;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) {
      console.error('[proxy] could not save sessions:', e.message);
    }
  }
}

module.exports = { Jar, SessionStore, parseSetCookie };
