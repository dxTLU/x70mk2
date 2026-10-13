'use strict';

/*
 * Server-side cookie jar (one per proxy session) following RFC 6265bis: cookie-date parsing,
 * Max-Age precedence and the 400-day cap, domain/path matching, public-suffix rejection,
 * Secure / HttpOnly / SameSite / Partitioned attributes, __Secure- and __Host- prefixes,
 * secure-cookie overlay protection and per-domain/total limits. Site comparisons for SameSite
 * use a compact built-in public suffix list.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { domainToASCII } = require('url');

const MAX_NAME_VALUE = 4096; // bytes of name + value
const MAX_ATTR_VALUE = 1024; // longer attribute values are ignored
const MAX_PER_DOMAIN = 180; // per registrable domain (Chromium's limit)
const MAX_COOKIES_PER_JAR = 3000;
const MAX_LIFETIME_MS = 400 * 24 * 3600 * 1000;
// Chromium's "Lax-allowing-unsafe": cookies that never chose a SameSite value still ride along
// on cross-site top-level POSTs (SSO form_post callbacks) during their first two minutes.
const LAX_UNSAFE_WINDOW_MS = 2 * 60 * 1000;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'TRACE']);

// ---- public suffixes ---------------------------------------------------------------------
// Every single-label name is a public suffix (the PSL's implicit "*" rule). Below are the
// multi-label suffixes that matter most in practice: country second levels and hosting
// platforms where each subdomain belongs to a different owner. "*.x" marks every child of x.

const PUBLIC_SUFFIXES = new Set(`
co.uk org.uk me.uk ltd.uk plc.uk net.uk sch.uk ac.uk gov.uk nhs.uk police.uk mod.uk
com.au net.au org.au edu.au gov.au asn.au id.au
co.nz net.nz org.nz govt.nz ac.nz school.nz geek.nz gen.nz kiwi.nz maori.nz health.nz
co.jp ne.jp or.jp ac.jp ad.jp ed.jp go.jp gr.jp lg.jp
co.kr ne.kr or.kr re.kr pe.kr go.kr ac.kr
com.cn net.cn org.cn gov.cn edu.cn ac.cn
com.hk net.hk org.hk edu.hk gov.hk idv.hk
com.tw net.tw org.tw edu.tw gov.tw idv.tw
co.in net.in org.in firm.in gen.in ind.in ac.in edu.in gov.in res.in
com.br net.br org.br gov.br edu.br art.br blog.br eco.br emp.br eng.br ind.br inf.br nom.br app.br dev.br
com.mx net.mx org.mx gob.mx edu.mx
com.ar net.ar org.ar gob.ar edu.ar int.ar
com.co net.co org.co gov.co edu.co nom.co
co.za org.za gov.za ac.za net.za web.za edu.za
co.il org.il net.il ac.il gov.il muni.il k12.il
co.id or.id ac.id go.id web.id my.id net.id sch.id biz.id
co.th in.th ac.th go.th or.th net.th
com.sg net.sg org.sg edu.sg gov.sg per.sg
com.my net.my org.my edu.my gov.my name.my
com.ph net.ph org.ph gov.ph edu.ph
com.pk net.pk org.pk edu.pk gov.pk
com.vn net.vn org.vn edu.vn gov.vn
com.tr net.tr org.tr edu.tr gov.tr gen.tr biz.tr info.tr k12.tr web.tr
com.ua net.ua org.ua edu.ua gov.ua in.ua
com.pl net.pl org.pl edu.pl gov.pl info.pl biz.pl
com.es nom.es org.es gob.es edu.es
asso.fr com.fr gouv.fr nom.fr prd.fr tm.fr
co.at or.at gv.at ac.at
com.gr net.gr org.gr edu.gr gov.gr
com.cy net.cy org.cy ac.cy gov.cy
com.eg net.eg org.eg edu.eg gov.eg
com.sa net.sa org.sa edu.sa gov.sa
co.ae net.ae org.ae ac.ae gov.ae
com.ng net.ng org.ng edu.ng gov.ng
co.ke or.ke ne.ke ac.ke go.ke
com.pe net.pe org.pe edu.pe gob.pe
com.ve net.ve org.ve co.ve web.ve gob.ve
co.cl gob.cl
com.uy net.uy org.uy edu.uy gub.uy
com.ec net.ec org.ec edu.ec gob.ec
com.lk net.lk org.lk edu.lk gov.lk
com.qa net.qa org.qa edu.qa gov.qa
com.kw net.kw org.kw edu.kw gov.kw
com.bh net.bh org.bh edu.bh gov.bh
com.om net.om org.om edu.om gov.om co.om
com.jo net.jo org.jo edu.jo gov.jo
com.lb net.lb org.lb edu.lb gov.lb
co.tz ac.tz go.tz or.tz ne.tz
co.ug ac.ug go.ug or.ug ne.ug
com.gh org.gh edu.gh gov.gh
co.ma net.ma org.ma ac.ma gov.ma
co.hu org.hu info.hu
com.ro org.ro info.ro nom.ro
co.rs org.rs edu.rs ac.rs gov.rs in.rs
com.hr from.hr name.hr
com.ee org.ee edu.ee gov.ee pri.ee med.ee
ab.ca bc.ca mb.ca nb.ca nf.ca nl.ca ns.ca nt.ca nu.ca on.ca pe.ca qc.ca sk.ca yk.ca gc.ca
ac.ru edu.ru gov.ru int.ru mil.ru
com.by gov.by com.kz edu.kz gov.kz org.kz net.kz co.uz com.uz
co.ir ac.ir gov.ir org.ir net.ir
*.bd *.np *.ck *.kh *.mm *.er *.fk *.jm *.pg
github.io githubusercontent.com gitlab.io bitbucket.io codeberg.page
herokuapp.com appspot.com r.appspot.com blogspot.com googleapis.com cloudfunctions.net run.app
web.app firebaseapp.com cloudfront.net s3.amazonaws.com elasticbeanstalk.com
azurewebsites.net azurestaticapps.net cloudapp.net web.core.windows.net
netlify.app vercel.app now.sh pages.dev workers.dev fly.dev onrender.com deno.dev
glitch.me repl.co ngrok.io ngrok.app ngrok-free.app trycloudflare.com surge.sh
readthedocs.io pythonanywhere.com myshopify.com gitpod.io stackblitz.io
`.trim().split(/\s+/));

function isIp(host) {
  return net.isIP(host) !== 0;
}

function canonicalHost(h) {
  return String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** The public suffix ("effective TLD") of a canonical host name, or null for IP addresses. */
function publicSuffix(host) {
  host = canonicalHost(host);
  if (!host || isIp(host)) return null;
  const labels = host.split('.');
  for (let i = 0; i < labels.length; i++) {
    const candidate = labels.slice(i).join('.');
    if (PUBLIC_SUFFIXES.has(candidate)) return candidate;
    if (i + 1 < labels.length && PUBLIC_SUFFIXES.has('*.' + labels.slice(i + 1).join('.'))) return candidate;
  }
  return labels[labels.length - 1];
}

function isPublicSuffix(host) {
  host = canonicalHost(host);
  return Boolean(host) && publicSuffix(host) === host;
}

// Jar limits look this up for every stored cookie on every Set-Cookie, so remember answers.
const siteCache = new Map();

/** eTLD+1, e.g. "www.example.co.uk" -> "example.co.uk"; the host itself for IPs and suffixes. */
function registrableDomain(host) {
  const key = String(host || '');
  let out = siteCache.get(key);
  if (out !== undefined) return out;
  const h = canonicalHost(key);
  const suffix = publicSuffix(h);
  if (!suffix || suffix === h) out = h;
  else {
    const rest = h.slice(0, h.length - suffix.length - 1);
    out = rest.slice(rest.lastIndexOf('.') + 1) + '.' + suffix;
  }
  if (siteCache.size >= 20000) siteCache.clear();
  siteCache.set(key, out);
  return out;
}

/** Schemeful site of a URL ("https://example.com"), as used for SameSite decisions. */
function siteOf(url) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const scheme = u.protocol === 'wss:' || u.protocol === 'https:' ? 'https' : 'http';
  return scheme + '://' + registrableDomain(u.hostname);
}

function sameSite(a, b) {
  return siteOf(a) === siteOf(b);
}

// ---- parsing -----------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE_DELIMS = /[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/;

/** RFC 6265 §5.1.1 cookie-date parser. Returns a timestamp, or null when the date is invalid. */
function parseCookieDate(str) {
  let time = null, day = null, month = null, year = null;
  for (const token of String(str).split(DATE_DELIMS)) {
    if (!token) continue;
    let m;
    if (time === null && (m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D|$)/.exec(token))) {
      time = [+m[1], +m[2], +m[3]];
    } else if (day === null && (m = /^(\d{1,2})(?:\D|$)/.exec(token))) {
      day = +m[1];
    } else if (month === null && token.length >= 3 && MONTHS.includes(token.slice(0, 3).toLowerCase())) {
      month = MONTHS.indexOf(token.slice(0, 3).toLowerCase());
    } else if (year === null && (m = /^(\d{2,4})(?:\D|$)/.exec(token))) {
      year = +m[1];
    }
  }
  if (time === null || day === null || month === null || year === null) return null;
  if (year >= 70 && year <= 99) year += 1900;
  else if (year >= 0 && year <= 69) year += 2000;
  const [h, mi, s] = time;
  if (day < 1 || day > 31 || year < 1601 || h > 23 || mi > 59 || s > 59) return null;
  const t = Date.UTC(year, month, day, h, mi, s);
  if (new Date(t).getUTCDate() !== day) return null; // e.g. 31 Feb
  return t;
}

const trimWsp = (s) => s.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * Parse a Set-Cookie value into its raw parts (RFC 6265bis §5.6). The last occurrence of each
 * attribute wins; Max-Age beats Expires whatever the order. Returns null if it must be ignored.
 */
function parseSetCookieString(str) {
  str = String(str == null ? '' : str);
  // Control characters other than HTAB make the whole line invalid.
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(str)) return null;
  const semi = str.indexOf(';');
  const pair = semi === -1 ? str : str.slice(0, semi);
  const eq = pair.indexOf('=');
  const name = eq === -1 ? '' : trimWsp(pair.slice(0, eq));
  const value = trimWsp(eq === -1 ? pair : pair.slice(eq + 1));
  if (!name && !value) return null;
  if (Buffer.byteLength(name) + Buffer.byteLength(value) > MAX_NAME_VALUE) return null;
  const attrs = {};
  if (semi !== -1) {
    for (const av of str.slice(semi + 1).split(';')) {
      const i = av.indexOf('=');
      const key = trimWsp(i === -1 ? av : av.slice(0, i)).toLowerCase();
      const val = i === -1 ? '' : trimWsp(av.slice(i + 1));
      if (!key || val.length > MAX_ATTR_VALUE) continue;
      switch (key) {
        case 'expires': {
          const t = parseCookieDate(val);
          if (t !== null) attrs.expires = t;
          break;
        }
        case 'max-age':
          if (/^-?\d+$/.test(val)) attrs.maxAge = Number(val);
          break;
        case 'domain':
          if (val) attrs.domain = val; // an empty Domain is ignored, leaving a host-only cookie
          break;
        case 'path':
          attrs.path = val;
          break;
        case 'secure': attrs.secure = true; break;
        case 'httponly': attrs.httpOnly = true; break;
        case 'partitioned': attrs.partitioned = true; break;
        case 'samesite': {
          const v = val.toLowerCase();
          attrs.sameSite = v === 'none' || v === 'lax' || v === 'strict' ? v : 'default';
          break;
        }
        default: break;
      }
    }
  }
  return { name, value, attrs };
}

/** Whether cookies set or read on this URL count as coming from a secure context. */
function isSecureUrl(url) {
  if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
  const h = canonicalHost(url.hostname);
  // Browsers treat loopback as potentially trustworthy, so Secure cookies work on http://localhost.
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1';
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

/**
 * Turn a Set-Cookie value received for `url` into a cookie record (RFC 6265bis §5.7 steps that
 * do not depend on the store). Returns null when the cookie must be ignored.
 */
function parseSetCookie(str, url, now = Date.now()) {
  const parsed = parseSetCookieString(str);
  if (!parsed) return null;
  const { name, value, attrs } = parsed;
  const host = canonicalHost(url.hostname);
  const secureUrl = isSecureUrl(url);

  let expires = null;
  if (attrs.maxAge !== undefined) expires = attrs.maxAge <= 0 ? 0 : now + Math.min(attrs.maxAge * 1000, MAX_LIFETIME_MS);
  else if (attrs.expires !== undefined) expires = Math.min(attrs.expires, now + MAX_LIFETIME_MS);

  let domain = host;
  let hostOnly = true;
  if (attrs.domain !== undefined) {
    let d = attrs.domain.replace(/^\./, '').toLowerCase().replace(/\.$/, '');
    if (!isIp(d.replace(/^\[|\]$/g, ''))) d = domainToASCII(d);
    d = canonicalHost(d);
    if (!d) return null;
    if (isIp(host) || isIp(d)) {
      if (d !== host) return null; // IP hosts only accept their own exact address
    } else if (isPublicSuffix(d)) {
      if (d !== host) return null; // Domain=co.uk and friends
    } else {
      if (!domainMatch(host, d)) return null;
      domain = d;
      hostOnly = false;
    }
  }

  const cookiePath = attrs.path && attrs.path[0] === '/' ? attrs.path : defaultPath(url.pathname);
  const secure = Boolean(attrs.secure);
  if (secure && !secureUrl) return null;

  const lname = name.toLowerCase();
  if (lname.startsWith('__secure-') && !secure) return null;
  if (lname.startsWith('__host-') && !(secure && hostOnly && attrs.domain === undefined && attrs.path === '/')) return null;
  if (!name && /^__(secure|host)-/i.test(value)) return null;

  const sameSiteAttr = attrs.sameSite || 'default';
  // Browsers reject SameSite=None and Partitioned cookies that are not Secure.
  if ((sameSiteAttr === 'none' || attrs.partitioned) && !secure) return null;

  return {
    name, value, domain, hostOnly, path: cookiePath, expires, secure,
    httpOnly: Boolean(attrs.httpOnly), sameSite: sameSiteAttr,
    partitioned: Boolean(attrs.partitioned), created: now, lastAccess: now,
  };
}

/**
 * Whether a cookie may be sent in a request context:
 *   'same-site'  the request comes from the same site as the target (or the user typed it);
 *   'top-nav'    a cross-site top-level navigation;
 *   'cross-site' any other cross-site request (subresources, iframes, fetch).
 */
function sameSiteAllows(c, context, method, now) {
  if (context === 'same-site' || c.sameSite === 'none') return true;
  if (context !== 'top-nav' || c.sameSite === 'strict') return false;
  if (SAFE_METHODS.has(method)) return true;
  return c.sameSite === 'default' && now - c.created < LAX_UNSAFE_WINDOW_MS;
}

class Jar {
  constructor(data, onChange) {
    this.cookies = new Map();
    this.lastUsed = Date.now();
    this.onChange = onChange || null;
    if (data && Array.isArray(data.cookies)) {
      for (const c of data.cookies) {
        if (!c || typeof c.name !== 'string' || typeof c.domain !== 'string') continue;
        const rec = { sameSite: 'default', lastAccess: c.created || 0, partitioned: false, ...c };
        this.cookies.set(Jar.key(rec), rec);
      }
      this.lastUsed = data.lastUsed || this.lastUsed;
    }
  }

  static key(c) { return c.name + '\u0000' + c.domain + '\u0000' + (c.hostOnly ? 1 : 0) + '\u0000' + c.path; }

  get size() { return this.cookies.size; }

  /**
   * Store a Set-Cookie value received for `url`.
   * @param {object} [opts]
   * @param {boolean} [opts.fromScript] set through document.cookie (cannot touch HttpOnly cookies)
   * @param {string} [opts.context] 'same-site' | 'top-nav' | 'cross-site' (see sameSiteAllows);
   *   cross-site responses may only set SameSite=None cookies
   * @returns {boolean} whether the jar accepted it
   */
  set(str, url, { fromScript = false, context = 'same-site' } = {}) {
    const now = Date.now();
    const c = parseSetCookie(str, url, now);
    if (!c) return false;
    if (fromScript && c.httpOnly) return false;
    if (context === 'cross-site' && c.sameSite !== 'none') return false;

    // A non-secure origin may not shadow a Secure cookie (RFC 6265bis §5.7 step 16).
    if (!c.secure && !isSecureUrl(url)) {
      for (const old of this.cookies.values()) {
        if (old.name === c.name && old.secure && (domainMatch(old.domain, c.domain) || domainMatch(c.domain, old.domain)) &&
            pathMatch(c.path, old.path)) return false;
      }
    }

    const key = Jar.key(c);
    const old = this.cookies.get(key);
    if (old) {
      if (fromScript && old.httpOnly) return false;
      c.created = old.created;
    }
    if (c.expires !== null && c.expires <= now) {
      if (old) { this.cookies.delete(key); this.changed(); }
      return true;
    }
    this.cookies.set(key, c);
    this.enforceLimits(c, now);
    this.changed();
    return true;
  }

  changed() {
    this.lastUsed = Date.now();
    if (this.onChange) this.onChange(this);
  }

  /** Drop expired cookies, then the least recently used ones beyond the per-domain and total caps. */
  enforceLimits(added, now) {
    const site = registrableDomain(added.domain);
    const sameDomain = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) { this.cookies.delete(k); continue; }
      if (registrableDomain(c.domain) === site) sameDomain.push([k, c]);
    }
    const lru = (a, b) => a[1].lastAccess - b[1].lastAccess || a[1].created - b[1].created;
    if (sameDomain.length > MAX_PER_DOMAIN) {
      // Prefer evicting non-secure cookies, as Chromium does, and never the one just stored.
      sameDomain.sort((a, b) => (a[1].secure - b[1].secure) || lru(a, b));
      let excess = sameDomain.length - MAX_PER_DOMAIN;
      for (const [k, c] of sameDomain) {
        if (excess <= 0) break;
        if (c === added) continue;
        this.cookies.delete(k);
        excess--;
      }
    }
    if (this.cookies.size > MAX_COOKIES_PER_JAR) {
      const all = [...this.cookies.entries()].filter(([, c]) => c !== added).sort(lru);
      for (const [k] of all.slice(0, this.cookies.size - MAX_COOKIES_PER_JAR)) this.cookies.delete(k);
    }
  }

  /**
   * Cookies to send for a request to `url`, most specific path first.
   * @param {object} [opts]
   * @param {boolean} [opts.includeHttpOnly] false for the document.cookie view
   * @param {string} [opts.context] SameSite context, see sameSiteAllows
   * @param {string} [opts.method] request method (Lax cookies need a safe one cross-site)
   */
  match(url, { includeHttpOnly = true, context = 'same-site', method = 'GET' } = {}) {
    const now = Date.now();
    const host = canonicalHost(url.hostname);
    const secure = isSecureUrl(url);
    const reqPath = url.pathname || '/';
    const res = [];
    for (const [k, c] of this.cookies) {
      if (c.expires !== null && c.expires <= now) { this.cookies.delete(k); continue; }
      if (c.hostOnly ? host !== c.domain : !domainMatch(host, c.domain)) continue;
      if (!pathMatch(reqPath, c.path)) continue;
      if (c.secure && !secure) continue;
      if (!includeHttpOnly && c.httpOnly) continue;
      if (!sameSiteAllows(c, context, String(method).toUpperCase(), now)) continue;
      res.push(c);
    }
    res.sort((a, b) => b.path.length - a.path.length || a.created - b.created);
    for (const c of res) c.lastAccess = now;
    this.lastUsed = now;
    return res;
  }

  header(url, opts) {
    return this.match(url, opts).map((c) => (c.name ? c.name + '=' + c.value : c.value)).join('; ');
  }

  clear() {
    this.cookies.clear();
    this.changed();
  }

  /** Forget every cookie belonging to the site of `host` (Clear-Site-Data: "cookies"). */
  clearSite(host) {
    const site = registrableDomain(host);
    let n = 0;
    for (const [k, c] of this.cookies) {
      if (registrableDomain(c.domain) === site) { this.cookies.delete(k); n++; }
    }
    if (n) this.changed();
    return n;
  }

  toJSON() {
    const now = Date.now();
    const cookies = [...this.cookies.values()].filter((c) => c.expires === null || c.expires > now);
    return { lastUsed: this.lastUsed, cookies };
  }
}

/**
 * Cookie jars keyed by proxy session id. Jars that never receive a cookie (crawlers, health
 * checks, one-off visits) are dropped after a few idle minutes instead of living for the whole
 * session TTL. Session cookies are persisted too: the proxy is the "browser" here, and a restart
 * should not sign everyone out.
 */
const EMPTY_JAR_TTL_MS = 10 * 60 * 1000;

class SessionStore {
  constructor({ file, persist, ttlMs }) {
    this.file = file;
    this.persist = persist;
    this.ttlMs = ttlMs;
    this.jars = new Map();
    this.dirty = false;
    this.markDirty = () => { this.dirty = true; };
    if (persist) this.load();
  }

  static newId() { return crypto.randomBytes(18).toString('base64url'); }

  get(id) {
    let jar = this.jars.get(id);
    if (!jar) {
      jar = new Jar(null, this.markDirty);
      this.jars.set(id, jar);
    }
    jar.lastUsed = Date.now();
    this.dirty = true;
    return jar;
  }

  delete(id) {
    if (this.jars.delete(id)) this.dirty = true;
  }

  sweep(now = Date.now()) {
    const cutoff = now - this.ttlMs;
    const emptyCutoff = now - EMPTY_JAR_TTL_MS;
    for (const [id, jar] of this.jars) {
      if (jar.lastUsed < cutoff || (jar.size === 0 && jar.lastUsed < emptyCutoff)) this.jars.delete(id);
    }
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[proxy] could not load sessions:', e.message);
      return;
    }
    if (!data || typeof data !== 'object') return;
    for (const [id, j] of Object.entries(data)) {
      const jar = new Jar(j, this.markDirty);
      if (jar.size) this.jars.set(id, jar);
    }
    this.sweep();
    this.dirty = false;
  }

  /** Periodic upkeep: forget idle jars, then persist. */
  maintain() {
    this.sweep();
    return this.save();
  }

  /** Write all jars atomically to the data file, readable only by the proxy's user (0600). */
  save() {
    if (!this.persist || !this.dirty) return true;
    this.sweep();
    const obj = {};
    for (const [id, jar] of this.jars) {
      const j = jar.toJSON();
      if (j.cookies.length) obj[id] = j;
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.fchmodSync(fd, 0o600); // the mode argument only applies to newly created files
        fs.writeSync(fd, JSON.stringify(obj));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (e) {
      console.error('[proxy] could not save sessions:', e.message);
      try { fs.unlinkSync(tmp); } catch { /* already gone */ }
      return false;
    }
  }
}

module.exports = {
  Jar, SessionStore, parseSetCookie, parseSetCookieString, parseCookieDate,
  publicSuffix, isPublicSuffix, registrableDomain, siteOf, sameSite, isSecureUrl,
  domainMatch, pathMatch, defaultPath,
  MAX_PER_DOMAIN, MAX_COOKIES_PER_JAR, MAX_LIFETIME_MS,
};
