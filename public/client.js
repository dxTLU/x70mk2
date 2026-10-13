/*
 * Proxy browser runtime: keeps every URL a page builds at runtime inside the proxy and makes the
 * page see the real site (its URL, origin, cookies and storage) instead of the proxy.
 *
 * The same function boots in three kinds of realm:
 *  - documents served through the proxy (the server injects it after window.__PROXY_CFG);
 *  - same-origin child windows that never load a proxied URL (about:blank and srcdoc iframes,
 *    window.open('')): the parent evaluates this function's own source inside them;
 *  - dedicated workers, which start from a blob bootstrap that boots the runtime and then loads
 *    the real worker script, so self.location and relative URLs describe the real site.
 * Chromium keeps a window's JS realm when its initial about:blank document is replaced by a
 * same-origin one, so patches are applied once per realm and per-document setup re-runs when a
 * new document shows up in an already patched realm.
 */
(function proxyRuntime(bootCfg) {
  'use strict';
  var G = typeof globalThis === 'object' ? globalThis : self;
  if (G.__PROXY_RUNTIME__) {
    try { G.__PROXY_RUNTIME__.initDocument(); } catch (e) {}
    return;
  }
  var IS_WIN = typeof Window === 'function' && G instanceof Window;
  var cfg = bootCfg || G.__PROXY_CFG || {};

  // --- natives captured before anything is patched -------------------------------------------

  var O = Object, defineProp = O.defineProperty, getDesc = O.getOwnPropertyDescriptor;
  var hasOwn = O.prototype.hasOwnProperty, objToString = O.prototype.toString;
  var slice = Array.prototype.slice;
  var fnToString = Function.prototype.toString;
  var SRC = fnToString.call(proxyRuntime);
  var NativeURL = G.URL, NativeBlob = G.Blob;
  var nCreateObjectURL = NativeURL.createObjectURL, nRevokeObjectURL = NativeURL.revokeObjectURL;
  var NativeRequest = G.Request, NativeFetch = G.fetch;
  var reqUrl = NativeRequest && getDesc(NativeRequest.prototype, 'url');
  var XHR = G.XMLHttpRequest;
  var xhrOpen = XHR && XHR.prototype.open, xhrSend = XHR && XHR.prototype.send;
  var StorageProto = G.Storage && G.Storage.prototype;
  var stGet = StorageProto && StorageProto.getItem, stSet = StorageProto && StorageProto.setItem;
  var stRemove = StorageProto && StorageProto.removeItem, stKey = StorageProto && StorageProto.key;
  var stLength = StorageProto && getDesc(StorageProto, 'length').get;
  var ElementProto = IS_WIN ? Element.prototype : null;
  var nGetAttr = ElementProto && ElementProto.getAttribute, nSetAttr = ElementProto && ElementProto.setAttribute;
  var nRemoveAttr = ElementProto && ElementProto.removeAttribute, nHasAttr = ElementProto && ElementProto.hasAttribute;
  var nQSA = ElementProto && ElementProto.querySelectorAll;
  var nBaseURI = IS_WIN ? getDesc(Node.prototype, 'baseURI').get : null;
  var nContentWindow = IS_WIN && G.HTMLIFrameElement ? getDesc(HTMLIFrameElement.prototype, 'contentWindow').get : null;
  var nTextSet = IS_WIN ? getDesc(Node.prototype, 'textContent').set : null;

  var SELF = G.location.origin !== 'null' ? G.location.origin : (cfg.origin || '');
  var WS_SELF = SELF.replace(/^http/, 'ws');
  var PREFIX = cfg.prefix || '/p/';
  // Workers may run from a blob: URL, against which a root-relative URL cannot be resolved.
  var OUT_PREFIX = (IS_WIN ? '' : SELF) + PREFIX;
  var CLIENT_URL = cfg.clientUrl ||
    (IS_WIN && document.currentScript && document.currentScript.src) || SELF + '/__proxy/client.js';

  // --- helpers for patching ------------------------------------------------------------------

  // Patched functions report the native source so feature detection (isNative checks) still passes.
  var masked = new WeakMap();
  function mask(fn, native) {
    try {
      masked.set(fn, native);
      defineProp(fn, 'name', { value: native.name, configurable: true });
      defineProp(fn, 'length', { value: native.length, configurable: true });
    } catch (e) {}
    return fn;
  }
  try {
    Function.prototype.toString = mask(function toString() {
      return fnToString.call(masked.has(this) ? masked.get(this) : this);
    }, fnToString);
  } catch (e) {}

  // Members of the global object can live on its prototype chain (WorkerGlobalScope.prototype).
  function owner(obj, name) {
    if (obj !== G) return obj;
    for (var o = obj; o; o = O.getPrototypeOf(o)) if (hasOwn.call(o, name)) return o;
    return obj;
  }

  /** Replace obj[name] (a method) with make(native). */
  function hook(obj, name, make) {
    try {
      obj = owner(obj, name);
      var d = obj && getDesc(obj, name);
      if (!d || typeof d.value !== 'function') return;
      var fn = mask(make(d.value), d.value);
      defineProp(obj, name, { value: fn, writable: d.writable, enumerable: d.enumerable, configurable: d.configurable });
    } catch (e) {}
  }

  /** Wrap an accessor. get/set receive the native function and return the replacement. */
  function hookAccessor(obj, name, get, set) {
    try {
      obj = owner(obj, name);
      var d = obj && getDesc(obj, name);
      if (!d || !d.configurable || (!d.get && !d.set)) return;
      var nd = { configurable: true, enumerable: d.enumerable, get: d.get, set: d.set };
      if (get && d.get) nd.get = mask(get(d.get), d.get);
      if (set && d.set) nd.set = mask(set(d.set), d.set);
      defineProp(obj, name, nd);
    } catch (e) {}
  }

  function mapGetter(obj, name, map) {
    hookAccessor(obj, name, function (g) { return function () { return map(g.call(this)); }; });
  }

  /** Wrap a constructor so its arguments can be rewritten, keeping instanceof and subclassing. */
  function wrapCtor(owner, name, mapArgs) {
    var Native = owner[name];
    if (typeof Native !== 'function') return;
    var Wrapped = function () {
      if (!new.target) return Native.apply(this, arguments);
      var args = slice.call(arguments);
      try { args = mapArgs(args) || args; } catch (e) {}
      return Reflect.construct(Native, args, new.target === Wrapped ? Native : new.target);
    };
    mask(Wrapped, Native);
    Wrapped.prototype = Native.prototype;
    try { O.setPrototypeOf(Wrapped, Native); } catch (e) {}
    try { defineProp(Native.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true }); } catch (e) {}
    try { defineProp(owner, name, { value: Wrapped, writable: true, configurable: true, enumerable: false }); } catch (e) { owner[name] = Wrapped; }
  }

  function isA(v, type) { return v != null && typeof v === 'object' && objToString.call(v) === '[object ' + type + ']'; }
  function str(v) { return typeof v === 'string' ? v : String(v); }

  // --- URL helpers ---------------------------------------------------------------------------

  var SKIP = /^(?:data|blob|about|mailto|tel|sms|chrome|chrome-extension|moz-extension|intent|vbscript|filesystem|urn|magnet|javascript):/i;
  var JS_URL = /^javascript:/i;
  var PROXIED_REL = new RegExp('^' + PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:https?|wss?):\\/\\/?', 'i');
  var HTTP = /^(?:https?|wss?):$/;

  var decodeCache = new Map();
  /** Real URL encoded in a proxied URL (absolute or root-relative), or null. */
  function decode(u) {
    if (typeof u !== 'string') return null;
    var hit = decodeCache.get(u);
    if (hit !== undefined) return hit;
    var rest = null, out = null;
    if (u.lastIndexOf(SELF + PREFIX, 0) === 0) rest = u.slice(SELF.length + PREFIX.length);
    else if (u.lastIndexOf(WS_SELF + PREFIX, 0) === 0) rest = u.slice(WS_SELF.length + PREFIX.length);
    else if (u.lastIndexOf(PREFIX, 0) === 0) rest = u.slice(PREFIX.length);
    if (rest !== null && /^(?:https?|wss?):/i.test(rest)) {
      try { out = new NativeURL(rest.replace(/^(https?|wss?):\/(?!\/)/i, '$1://')).href; } catch (e) {}
    }
    if (decodeCache.size > 2000) decodeCache.clear();
    decodeCache.set(u, out);
    return out;
  }

  function originOf(u) {
    try { var o = new NativeURL(u).origin; return o && o !== 'null' ? o : null; } catch (e) { return null; }
  }

  var curRaw = null, curVal = null, tgtFor = null, tgtOrigin = SELF, baseRaw = null, baseVal = null;
  function resetCaches() { curRaw = null; baseRaw = null; tgtFor = null; }

  /** Real URL of this realm's document (about:blank children inherit their creator's URL). */
  function currentUrl() {
    var href;
    try { href = G.location.href; } catch (e) { return cfg.url; }
    if (href !== curRaw) { curRaw = href; curVal = decode(href) || cfg.url || href; }
    return curVal;
  }

  function targetOrigin() {
    var u = currentUrl();
    if (u !== tgtFor) { tgtFor = u; tgtOrigin = originOf(u) || SELF; }
    return tgtOrigin;
  }

  /** Base URL for resolving relative URLs, as the real site would see it. */
  function docBase() {
    if (!IS_WIN) return cfg.url || currentUrl();
    var raw;
    try { raw = nBaseURI.call(document); } catch (e) { return currentUrl(); }
    if (raw !== baseRaw) { baseRaw = raw; baseVal = decode(raw) || currentUrl(); }
    return baseVal;
  }

  function isProxied(s) {
    if (PROXIED_REL.test(s)) return true;
    return (s.lastIndexOf(SELF + PREFIX, 0) === 0 || s.lastIndexOf(WS_SELF + PREFIX, 0) === 0) && decode(s) !== null;
  }

  /** Rewrite any URL so it goes through the proxy. */
  function rw(u, base) {
    if (u == null) return u;
    var s = str(u), t = s.trim();
    if (!t || t.charCodeAt(0) === 35) return s;
    if (JS_URL.test(t)) return rwJsUrl(s, t);
    if (SKIP.test(t) || isProxied(t)) return s;
    var abs;
    try { abs = new NativeURL(t, base || docBase()); } catch (e) { return s; }
    if (!HTTP.test(abs.protocol)) return s;
    if (abs.origin === SELF || abs.origin === WS_SELF) {
      // On our own origin but outside the prefix, e.g. built from the raw location.
      if (PROXIED_REL.test(abs.pathname) || abs.pathname.lastIndexOf('/__proxy/', 0) === 0) return abs.href;
      try { abs = new NativeURL(abs.pathname + abs.search + abs.hash, targetOrigin()); } catch (e) { return s; }
    }
    return OUT_PREFIX + abs.href;
  }

  function absProxied(u) {
    var r = rw(u);
    try { return new NativeURL(r, SELF + '/').href; } catch (e) { return r; }
  }

  function rwWs(u) {
    var s = str(u), abs;
    try { abs = new NativeURL(s, docBase()); } catch (e) { return s; }
    if (abs.origin === SELF || abs.origin === WS_SELF) {
      if (PROXIED_REL.test(abs.pathname)) return WS_SELF + abs.pathname + abs.search;
      try { abs = new NativeURL(abs.pathname + abs.search, targetOrigin()); } catch (e) { return s; }
    }
    if (abs.protocol === 'http:') abs.protocol = 'ws:';
    else if (abs.protocol === 'https:') abs.protocol = 'wss:';
    if (abs.protocol !== 'ws:' && abs.protocol !== 'wss:') return s;
    abs.hash = '';
    return WS_SELF + PREFIX + abs.href;
  }

  function unrw(v) { return typeof v === 'string' ? decode(v) || v : v; }

  /** What a page most likely wrote for an attribute the proxy rewrote. */
  function displayUrl(raw) {
    var d = decode(raw);
    if (!d) return raw;
    var o = targetOrigin();
    return d.lastIndexOf(o + '/', 0) === 0 ? d.slice(o.length) : d;
  }

  function mapSrcset(v, fn) {
    if (v == null) return v;
    v = str(v);
    var out = [], i = 0, n = v.length, changed = false;
    while (i < n) {
      while (i < n && /[\s,]/.test(v.charAt(i))) i++;
      if (i >= n) break;
      var st = i;
      while (i < n && !/\s/.test(v.charAt(i))) i++;
      var url = v.slice(st, i), desc = '';
      if (/,$/.test(url)) url = url.replace(/,+$/, '');
      else {
        st = i;
        var depth = 0;
        while (i < n && (v.charAt(i) !== ',' || depth > 0)) {
          if (v.charAt(i) === '(') depth++; else if (v.charAt(i) === ')') depth--;
          i++;
        }
        desc = v.slice(st, i).trim();
      }
      var nu = fn(url);
      if (nu !== url) changed = true;
      out.push(nu + (desc ? ' ' + desc : ''));
    }
    return changed ? out.join(', ') : v;
  }
  function rwSrcset(v) { return mapSrcset(v, function (u) { return rw(u); }); }
  function unrwSrcset(v) { return mapSrcset(v, displayUrl); }

  var CSS_HINT = /url\(|@import|image-set\(/i;
  function rwCss(css, base) {
    if (typeof css !== 'string' || !CSS_HINT.test(css)) return css;
    return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s]*))\s*\)/gi, function (m, a, b, c) {
      var u = a !== undefined ? a : b !== undefined ? b : c;
      if (!u) return m;
      var r = rw(u, base);
      return r === u ? m : 'url("' + r.replace(/["\\\n]/g, '\\$&') + '")';
    }).replace(/(@import\s+|image-set\(\s*)(["'])([^"']+)\2/gi, function (m, pre, q, u) {
      var r = rw(u, base);
      return r === u ? m : pre + q + r + q;
    });
  }

  // --- JavaScript rewriting (when the isomorphic rewriter is loaded next to this runtime) ----

  function rwJs(code) {
    var R = G.__proxyRewriteJs;
    if (!R || typeof code !== 'string') return code;
    try { return R.rewriteJs(code); } catch (e) { return code; }
  }

  function rwJsUrl(s, t) {
    if (!G.__proxyRewriteJs) return s;
    var code;
    try { code = decodeURIComponent(t.slice(11)); } catch (e) { return s; }
    var out = rwJs(code);
    return out === code ? s : 'javascript:' + out.replace(/[%\t\n\r]/g, encodeURIComponent);
  }

  function isJsType(t) {
    if (t == null) return true;
    t = String(t).trim().toLowerCase();
    return t === '' || t === 'module' || /^(?:text|application)\/(?:x-)?(?:java|ecma)script$|^text\/(?:j|live)script$/.test(t);
  }

  // --- HTML string rewriting (innerHTML, document.write, srcdoc...) ---------------------------
  // Markup is rewritten before the browser parses it because some elements (stylesheets,
  // objects, frames) start loading the moment they are inserted.

  var ATTR_KIND = {
    src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1, lowsrc: 1, 'xlink:href': 1,
    srcset: 2, imagesrcset: 2, style: 3, ping: 4, srcdoc: 5, integrity: 6, referrerpolicy: 6,
  };
  var HTML_HINT = /<(?:script|style|iframe|meta)|[\s"'/](?:src|href|action|formaction|poster|background|lowsrc|data|srcset|imagesrcset|style|srcdoc|integrity|ping|on[a-z]+)\s*=/i;
  var RAW_TEXT = { script: 1, style: 1, textarea: 2, title: 2, xmp: 2, iframe: 2, noembed: 2, noframes: 2, noscript: 2 };
  var ENT = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]+))(;?)/g, function (m, d, h, name, semi, at) {
      if (name) {
        // In attributes, "&lt=" and "&ampx" stay literal (historical quirk).
        if (!semi && /[=A-Za-z0-9]/.test(s.charAt(at + m.length))) return m;
        return hasOwn.call(ENT, name) ? ENT[name] : m;
      }
      var cp = d ? parseInt(d, 10) : parseInt(h, 16);
      try { return String.fromCodePoint(cp === 0 || cp > 0x10ffff ? 0xfffd : cp); } catch (e) { return m; }
    });
  }
  function escAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }

  var closeRes = {};
  function findClose(html, name, from) {
    var re = closeRes[name] || (closeRes[name] = new RegExp('</' + name + '[\\s/>]', 'ig'));
    re.lastIndex = from;
    var m = re.exec(html);
    return m ? m.index : html.length;
  }

  function isWs(c) { return c === 32 || c === 9 || c === 10 || c === 12 || c === 13; }

  function rwRefresh(v) {
    return v.replace(/^(\s*[\d.]*\s*[;,]?\s*(?:url\s*=\s*)?)(["']?)(.*?)\2(\s*)$/i, function (m, pre, q, u, post) {
      return u ? pre + q + rw(u) + q + post : m;
    });
  }

  function injectMarkup() {
    var c = JSON.stringify({ url: currentUrl(), prefix: PREFIX, toolbar: false, origin: SELF }).replace(/</g, '\\u003c');
    return '<script data-proxy-runtime>window.__PROXY_CFG=' + c + ';</script><script src="' + escAttr(CLIENT_URL) + '" data-proxy-runtime></script>';
  }

  /** Rewrite the URL-bearing parts of an HTML string. inject: prepend the runtime (srcdoc). */
  function rwHtml(html, inject) {
    if (typeof html !== 'string') return html;
    var edits = [];
    if (inject) {
      var dt = /^\s*<!doctype[^>]*>/i.exec(html);
      edits.push([dt ? dt[0].length : 0, dt ? dt[0].length : 0, injectMarkup()]);
    }
    if (html.indexOf('<') >= 0 && HTML_HINT.test(html)) tokenize(html, edits);
    if (!edits.length) return html;
    var out = '', last = 0;
    for (var k = 0; k < edits.length; k++) {
      out += html.slice(last, edits[k][0]) + edits[k][2];
      last = edits[k][1];
    }
    return out + html.slice(last);
  }

  function tokenize(html, edits) {
    var n = html.length, i = 0, e;
    while (i < n) {
      var lt = html.indexOf('<', i);
      if (lt < 0 || lt + 1 >= n) return;
      var c = html.charCodeAt(lt + 1);
      if (c === 33) { // comment, doctype, CDATA
        if (html.startsWith('<!--', lt)) { e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; }
        else { e = html.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; }
        continue;
      }
      if (c === 47 || c === 63) { e = html.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) { i = lt + 1; continue; }
      var j = lt + 1;
      while (j < n) { c = html.charCodeAt(j); if (isWs(c) || c === 47 || c === 62) break; j++; }
      var tag = html.slice(lt + 1, j).toLowerCase();
      var attrs = [];
      for (;;) {
        while (j < n && (isWs(html.charCodeAt(j)) || html.charCodeAt(j) === 47)) j++;
        if (j >= n || html.charCodeAt(j) === 62) break;
        var ns = j++;
        while (j < n) { c = html.charCodeAt(j); if (isWs(c) || c === 47 || c === 62 || c === 61) break; j++; }
        var name = html.slice(ns, j).toLowerCase(), k = j;
        while (k < n && isWs(html.charCodeAt(k))) k++;
        if (html.charCodeAt(k) !== 61) { attrs.push([name, -1, -1, 0]); continue; }
        k++;
        while (k < n && isWs(html.charCodeAt(k))) k++;
        var q = html.charCodeAt(k);
        if (q === 34 || q === 39) {
          var ve = html.indexOf(q === 34 ? '"' : "'", k + 1);
          if (ve < 0) ve = n;
          attrs.push([name, k + 1, ve, q]);
          j = ve + 1;
        } else {
          var vs = k;
          while (k < n && !isWs(html.charCodeAt(k)) && html.charCodeAt(k) !== 62) k++;
          attrs.push([name, vs, k, 0]);
          j = k;
        }
      }
      i = j >= n ? n : j + 1;
      var info = rwTagAttrs(tag, attrs, html, edits);
      var raw = RAW_TEXT[tag];
      if (raw) {
        var close = findClose(html, tag, i);
        if (raw === 1 && close > i) {
          var body = html.slice(i, close), nb = body;
          if (tag === 'style') nb = rwCss(body);
          else if (!info.src && isJsType(info.type)) nb = rwJs(body);
          if (nb !== body) edits.push([i, close, nb]);
        }
        i = close;
      } else if (tag === 'plaintext') return;
    }
  }

  function rwTagAttrs(tag, attrs, html, edits) {
    var info = { type: null, src: false, refresh: false };
    var k, a;
    for (k = 0; k < attrs.length; k++) {
      a = attrs[k];
      if (a[1] < 0) continue;
      if (a[0] === 'type') info.type = decodeEntities(html.slice(a[1], a[2]));
      else if (a[0] === 'src') info.src = true;
      else if (a[0] === 'http-equiv' && /^\s*refresh\s*$/i.test(html.slice(a[1], a[2]))) info.refresh = true;
    }
    for (k = 0; k < attrs.length; k++) {
      a = attrs[k];
      if (a[1] < 0) continue;
      var name = a[0], val = decodeEntities(html.slice(a[1], a[2])), nv = val;
      var kind = ATTR_KIND[name];
      if (kind === 1 || (name === 'data' && tag === 'object')) nv = rw(val);
      else if (kind === 2) nv = rwSrcset(val);
      else if (kind === 3) nv = rwCss(val);
      else if (kind === 4) nv = val.replace(/\S+/g, function (u) { return rw(u); });
      else if (kind === 5) { if (tag === 'iframe') nv = rwHtml(val, true); }
      else if (kind === 6) nv = '';
      else if (name.length > 2 && name.charCodeAt(0) === 111 && name.charCodeAt(1) === 110) nv = rwJs(val);
      else if (tag === 'meta') {
        if (name === 'http-equiv' && /^\s*content-security-policy/i.test(val)) nv = 'x-proxy-blocked-csp';
        else if (name === 'name' && /^\s*referrer\s*$/i.test(val)) nv = 'x-proxy-blocked-referrer';
        else if (name === 'content' && info.refresh) nv = rwRefresh(val);
      }
      if (nv !== val) {
        var quoted = a[3] !== 0;
        edits.push([quoted ? a[1] - 1 : a[1], quoted ? Math.min(a[2] + 1, html.length) : a[2], '"' + escAttr(nv) + '"']);
      }
    }
    return info;
  }

  // --- runtime API ---------------------------------------------------------------------------

  var api = {
    rewrite: rw, decode: unrw, currentUrl: currentUrl, origin: targetOrigin,
    rewriteHtml: rwHtml, rewriteCss: rwCss,
  };
  var runtime = { initDocument: function () { initDocument(); } };
  try {
    defineProp(G, '__proxy', { value: api, configurable: true });
    defineProp(G, '__PROXY_RUNTIME__', { value: runtime, configurable: true });
    // Target of `eval(__pRewriteJs(code))`, which the JS rewriter emits for direct eval.
    defineProp(G, '__pRewriteJs', {
      configurable: true, writable: true,
      value: function __pRewriteJs(code) { return typeof code === 'string' ? rwJs(code) : code; },
    });
    // For dynamic import(): only absolute URLs need help, relative specifiers resolve against
    // the (already proxied) importing module.
    defineProp(G, '__pRewriteUrl', {
      configurable: true, writable: true,
      value: function __pRewriteUrl(u) {
        var s = typeof u === 'string' ? u : isA(u, 'URL') ? u.href : null;
        return s !== null && /^(?:https?:)?\/\//i.test(s.trim()) ? absProxied(s) : u;
      },
    });
  } catch (e) {}

  // --- virtual location ----------------------------------------------------------------------
  // The server renames `location` to `__pLocation`; this makes that name resolve to a
  // Location-like object describing the real site for windows and documents, and to the
  // ordinary `.location` property for every other object.

  var fakeLocations = new WeakMap();
  var LOC_PARTS = ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];

  function ownHref() {
    var raw = '';
    try { raw = G.location.href; } catch (e) {}
    if (/^about:/i.test(raw)) return raw;
    if (!IS_WIN && cfg.href) return cfg.href;
    return currentUrl();
  }

  function fakeLocation(win) {
    var f = fakeLocations.get(win);
    if (f) return f;
    var own = win === G;
    var hrefOf = own ? ownHref : function () {
      var raw = win.location.href;
      if (/^about:/i.test(raw)) return raw;
      try { if (win.__proxy) return win.__proxy.currentUrl(); } catch (e) {}
      return decode(raw) || raw;
    };
    var lastHref = null, lastUrl = null;
    var parsed = function () {
      var h = hrefOf();
      if (h !== lastHref) {
        lastHref = h;
        try { lastUrl = new NativeURL(h); } catch (e) { lastUrl = new NativeURL('about:blank'); }
      }
      return lastUrl;
    };
    var go = function (url, replace) {
      var target = rw(url);
      if (replace) win.location.replace(target); else win.location.assign(target);
    };
    var proto = IS_WIN ? G.Location && G.Location.prototype : G.WorkerLocation && G.WorkerLocation.prototype;
    f = O.create(proto || O.prototype);
    LOC_PARTS.forEach(function (p) {
      var d = { enumerable: true, configurable: false };
      d.get = function () {
        var u = parsed();
        if (p === 'origin') return u.protocol === 'about:' ? (own ? targetOrigin() : (originOf(win.__proxy && win.__proxy.currentUrl()) || 'null')) : u.origin;
        return u[p];
      };
      if (IS_WIN && p !== 'origin') {
        d.set = function (v) {
          if (p === 'href') return go(str(v));
          if (p === 'hash') { win.location.hash = v; return; }
          var u = new NativeURL(parsed().href);
          u[p] = v;
          go(u.href);
        };
      }
      defineProp(f, p, d);
    });
    var method = function (name, fn) {
      defineProp(f, name, { value: fn, enumerable: true, configurable: false, writable: false });
    };
    if (IS_WIN) {
      method('assign', function assign(url) { go(str(url)); });
      method('replace', function replace(url) { go(str(url), true); });
      method('reload', function reload() { win.location.reload(); });
      defineProp(f, 'ancestorOrigins', {
        enumerable: true,
        get: function () {
          var list = [];
          try {
            for (var w = win; w !== w.parent; w = w.parent) {
              var o;
              try { o = w.parent.__proxy.origin(); } catch (e) { o = 'null'; }
              list.push(o);
            }
          } catch (e) {}
          list.item = function (i) { return list[i] === undefined ? null : list[i]; };
          list.contains = function (o) { return list.indexOf(o) >= 0; };
          return list;
        },
      });
    }
    method('toString', function toString() { return hrefOf(); });
    method('valueOf', function valueOf() { return f; });
    fakeLocations.set(win, f);
    return f;
  }

  var DocumentCtor = IS_WIN ? G.Document : null;
  function locationOf(obj) {
    if (obj === G) return fakeLocation(G);
    if (DocumentCtor && obj instanceof DocumentCtor) return obj.defaultView ? fakeLocation(obj.defaultView) : obj.location;
    if (IS_WIN && obj instanceof G.Window) return fakeLocation(obj);
    return obj.location;
  }
  var pLocation = {
    configurable: true, enumerable: false,
    get: function () { return locationOf(this); },
    set: function (v) {
      if (this === G || (DocumentCtor && this instanceof DocumentCtor && this.defaultView) || (IS_WIN && this instanceof G.Window)) {
        locationOf(this).href = v;
        return;
      }
      this.location = v;
    },
  };
  try { defineProp(O.prototype, '__pLocation', pLocation); } catch (e) {}
  // Keep `with (obj)` scopes from capturing __pLocation (every object inherits it) unless obj
  // really has a location, matching the guard the JS rewriter prepends to external scripts.
  try {
    if (typeof Symbol === 'function' && Symbol.unscopables && !hasOwn.call(O.prototype, Symbol.unscopables)) {
      defineProp(O.prototype, Symbol.unscopables, {
        configurable: true,
        get: function () { var o = this; return { get __pLocation() { return !('location' in o); } }; },
      });
    }
    // DOM prototypes and arrays carry their own @@unscopables, which shadow the one above; inline
    // event handlers run with the element in scope, so these must not capture the name either.
    [G.Array, G.Element, G.CharacterData, G.DocumentType, G.DocumentFragment].forEach(function (C) {
      var u = C && hasOwn.call(C.prototype, Symbol.unscopables) && C.prototype[Symbol.unscopables];
      if (u && !hasOwn.call(u, '__pLocation')) defineProp(u, '__pLocation', { value: true, configurable: true });
    });
  } catch (e) {}

  /** Light fallback for a child window we could not boot: just make __pLocation resolve. */
  function lightInstall(win) {
    try {
      var OP = win.Object.prototype;
      var d = getDesc(OP, '__pLocation');
      if (d && (d.get === pLocation.get || win.__PROXY_RUNTIME__)) return;
      defineProp(OP, '__pLocation', {
        configurable: true,
        get: function () { return this === win || this === win.document ? fakeLocation(win) : this.location; },
        set: function (v) { if (this === win || this === win.document) fakeLocation(win).href = v; else this.location = v; },
      });
    } catch (e) {}
  }

  /** Boot the runtime inside a same-origin child window showing about:blank / about:srcdoc. */
  function bootChild(win) {
    if (!win || win === G) return;
    try {
      var rt = win.__PROXY_RUNTIME__;
      if (rt) { rt.initDocument(); return; }
      if (!/^about:/i.test(win.location.href)) return;
      if (G.__proxyRewriteJs && !win.__proxyRewriteJs) {
        defineProp(win, '__proxyRewriteJs', { value: G.__proxyRewriteJs, configurable: true, writable: true });
      }
      win.Function('c', 'return (' + SRC + ')(c)')({
        url: currentUrl(), prefix: PREFIX, toolbar: false, origin: SELF, clientUrl: CLIENT_URL, child: true,
      });
    } catch (e) {
      lightInstall(win);
    }
  }

  // --- network APIs --------------------------------------------------------------------------

  var cookieCache = typeof cfg.cookies === 'string' ? cfg.cookies : null;
  var cookieAt = cookieCache !== null ? Date.now() : 0;
  function invalidateCookies() { cookieCache = null; }

  function rwRequest(input) {
    // A Request built before the runtime (or in another realm) may still carry a raw URL.
    var raw = reqUrl.get.call(input);
    var nu = rw(raw);
    if (nu === raw || SELF + nu === raw) return input;
    var init = {
      method: input.method, headers: input.headers, credentials: input.credentials, cache: input.cache,
      redirect: input.redirect, referrerPolicy: input.referrerPolicy, keepalive: input.keepalive,
      signal: input.signal, mode: input.mode === 'navigate' ? 'same-origin' : input.mode,
    };
    if (input.method === 'GET' || input.method === 'HEAD' || !input.body) return new NativeRequest(nu, init);
    return input.clone().arrayBuffer().then(function (buf) {
      init.body = buf;
      return new NativeRequest(nu, init);
    });
  }

  if (NativeFetch) {
    hook(G, 'fetch', function (native) {
      return function fetch(input, init) {
        var args = slice.call(arguments);
        try {
          if (isA(input, 'Request')) {
            var r = rwRequest(input);
            if (r && typeof r.then === 'function') {
              var self = this;
              return r.then(function (req) { args[0] = req; return native.apply(self, args); }).then(function (res) { invalidateCookies(); return res; });
            }
            args[0] = r;
          } else if (args.length) {
            args[0] = rw(input);
          }
        } catch (e) {}
        var p = native.apply(this, args);
        p.then(invalidateCookies, function () {});
        return p;
      };
    });
  }

  if (NativeRequest) {
    wrapCtor(G, 'Request', function (args) {
      if (args.length && !isA(args[0], 'Request')) args[0] = rw(args[0]);
      return args;
    });
    mapGetter(NativeRequest.prototype, 'url', unrw);
  }
  if (G.Response) mapGetter(G.Response.prototype, 'url', unrw);

  if (XHR) {
    hook(XHR.prototype, 'open', function (native) {
      return function open(method, url) {
        var args = slice.call(arguments);
        if (args.length > 1) args[1] = rw(url);
        try { this.addEventListener('loadend', invalidateCookies); } catch (e) {}
        return native.apply(this, args);
      };
    });
    mapGetter(XHR.prototype, 'responseURL', unrw);
  }

  if (G.navigator && navigator.sendBeacon) {
    hook(G.Navigator.prototype, 'sendBeacon', function (native) {
      return function sendBeacon(url) {
        var args = slice.call(arguments);
        if (args.length) args[0] = rw(url);
        return native.apply(this, args);
      };
    });
  }

  wrapCtor(G, 'WebSocket', function (args) { if (args.length) args[0] = rwWs(args[0]); return args; });
  if (G.WebSocket) mapGetter(G.WebSocket.prototype, 'url', unrw);
  wrapCtor(G, 'EventSource', function (args) { if (args.length) args[0] = rw(args[0]); return args; });
  if (G.EventSource) mapGetter(G.EventSource.prototype, 'url', unrw);
  wrapCtor(G, 'SharedWorker', function (args) { if (args.length) args[0] = rw(args[0]); return args; });
  if (IS_WIN) wrapCtor(G, 'Audio', function (args) { if (args.length && args[0] !== undefined) args[0] = rw(args[0]); return args; });
  wrapCtor(G, 'FontFace', function (args) { if (typeof args[1] === 'string') args[1] = rwCss(args[1]); return args; });
  if (G.Worklet) {
    hook(G.Worklet.prototype, 'addModule', function (native) {
      return function addModule(url) { var args = slice.call(arguments); if (args.length) args[0] = rw(url); return native.apply(this, args); };
    });
  }
  if (typeof G.importScripts === 'function') {
    hook(G, 'importScripts', function (native) {
      return function importScripts() { return native.apply(this, slice.call(arguments).map(function (u) { return rw(u); })); };
    });
  }

  // Remember which Blob each blob: URL points at so a worker started from it can be wrapped even
  // after the page revokes the URL (which it usually does right after `new Worker(url)`).
  var blobs = new Map();
  try {
    NativeURL.createObjectURL = mask(function createObjectURL(obj) {
      var u = nCreateObjectURL.apply(NativeURL, arguments);
      if (obj instanceof NativeBlob) blobs.set(u, obj);
      return u;
    }, nCreateObjectURL);
    NativeURL.revokeObjectURL = mask(function revokeObjectURL(u) {
      blobs.delete(String(u));
      return nRevokeObjectURL.apply(NativeURL, arguments);
    }, nRevokeObjectURL);
  } catch (e) {}

  // Workers start from a blob that boots this runtime and then loads the real script, so the
  // worker sees the real self.location and its requests stay inside the proxy.
  wrapCtor(G, 'Worker', function (args) {
    if (!args.length) return args;
    var s = str(args[0]).trim(), opts = args[1];
    if (/^data:/i.test(s)) return args;
    var script, real, href, keep = [];
    if (/^blob:/i.test(s)) {
      var b = blobs.get(s);
      script = b ? nCreateObjectURL.call(NativeURL, b) : s;
      if (b) keep.push(script);
      real = currentUrl();
      href = 'blob:' + targetOrigin() + s.slice(s.lastIndexOf('/'));
    } else {
      script = absProxied(s);
      real = decode(script);
      if (!real) return args;
      href = real;
    }
    var boot = 'self.__PROXY_CFG=' + JSON.stringify({ url: real, href: href, prefix: PREFIX, origin: SELF, clientUrl: CLIENT_URL, worker: true }) + ';';
    // With the JS rewriter bundled in, load that same bundle so code the worker builds at
    // runtime is rewritten too; otherwise embed this runtime's own source.
    var bundled = G.__proxyRewriteJs && CLIENT_URL.indexOf(SELF + '/__proxy/') === 0;
    boot += bundled ? (opts && opts.type === 'module' ? '' : 'importScripts(' + JSON.stringify(CLIENT_URL) + ');') : '(' + SRC + ')();';
    var code;
    if (opts && opts.type === 'module') {
      if (bundled) boot += 'export {};';
      var bootUrl = nCreateObjectURL.call(NativeURL, new NativeBlob([boot], { type: 'text/javascript' }));
      keep.push(bootUrl);
      code = 'import ' + JSON.stringify(bootUrl) + ';' + (bundled ? 'import ' + JSON.stringify(CLIENT_URL) + ';' : '') + 'import ' + JSON.stringify(script) + ';';
    } else {
      code = boot + 'importScripts(' + JSON.stringify(script) + ');';
    }
    args[0] = nCreateObjectURL.call(NativeURL, new NativeBlob([code], { type: 'text/javascript' }));
    keep.push(args[0]);
    // Module workers fetch their imports asynchronously, so revoke only once they surely have.
    setTimeout(function () { keep.forEach(function (u) { nRevokeObjectURL.call(NativeURL, u); }); }, 60000);
    return args;
  });

  // Service workers would intercept requests on the proxy origin without any rewriting.
  if (G.navigator && navigator.serviceWorker && G.ServiceWorkerContainer) {
    hook(G.ServiceWorkerContainer.prototype, 'register', function () {
      return function register() { return Promise.reject(new DOMException('Service workers are disabled by the proxy', 'SecurityError')); };
    });
    if (IS_WIN && !cfg.child) {
      try {
        navigator.serviceWorker.getRegistrations().then(function (regs) { regs.forEach(function (r) { r.unregister(); }); }, function () {});
      } catch (e) {}
    }
  }

  if (G.PerformanceEntry) mapGetter(G.PerformanceEntry.prototype, 'name', unrw);
  if (G.ErrorEvent) mapGetter(G.ErrorEvent.prototype, 'filename', unrw);
  if (G.Performance) {
    hook(G.Performance.prototype, 'getEntriesByName', function (native) {
      return function getEntriesByName(name) {
        var args = slice.call(arguments);
        if (typeof name === 'string' && /^(?:https?|wss?):/i.test(name)) args[0] = absProxied(name);
        return native.apply(this, args);
      };
    });
  }

  // --- storage isolation: every proxied site shares the proxy origin, so namespace by real origin

  function nsPrefix() { return '\u0001' + targetOrigin() + '\u0001'; }
  function stripNs(name) {
    if (typeof name !== 'string') return name;
    var ns = nsPrefix();
    return name.lastIndexOf(ns, 0) === 0 ? name.slice(ns.length) : name;
  }
  function ownNs(name) { return typeof name === 'string' && name.lastIndexOf(nsPrefix(), 0) === 0; }

  var realLocal = null; // the shared, un-namespaced localStorage (toolbar settings live there)
  var storageApi = new WeakMap(); // isolated storage proxy -> api
  var storageProxies = new Map(); // real Storage -> proxy

  function makeStorage(real) {
    var cache = { len: -1, ns: '', keys: null };
    function keys() {
      var ns = nsPrefix(), len = stLength.call(real);
      if (cache.keys && cache.len === len && cache.ns === ns) return cache.keys;
      var out = [];
      for (var i = 0; i < len; i++) {
        var k = stKey.call(real, i);
        if (k !== null && k.lastIndexOf(ns, 0) === 0) out.push(k.slice(ns.length));
      }
      cache.len = len; cache.ns = ns; cache.keys = out;
      return out;
    }
    function dirty() { cache.keys = null; }
    function need(n, args, name) {
      if (args.length < n) throw new TypeError("Failed to execute '" + name + "' on 'Storage': " + n + ' argument' + (n > 1 ? 's' : '') + ' required, but only ' + args.length + ' present.');
    }
    var a = {
      getItem: function (k) { need(1, arguments, 'getItem'); return stGet.call(real, nsPrefix() + k); },
      setItem: function (k, v) { need(2, arguments, 'setItem'); stSet.call(real, nsPrefix() + k, v); dirty(); },
      removeItem: function (k) { need(1, arguments, 'removeItem'); stRemove.call(real, nsPrefix() + k); dirty(); },
      clear: function () {
        var ns = nsPrefix();
        keys().slice().forEach(function (k) { stRemove.call(real, ns + k); });
        dirty();
      },
      key: function (i) { need(1, arguments, 'key'); var ks = keys(); i = i >>> 0; return i < ks.length ? ks[i] : null; },
      length: function () { return keys().length; },
      dirty: dirty,
      has: function (k) { return stGet.call(real, nsPrefix() + k) !== null; },
    };
    var target = O.create(StorageProto);
    var proxy = new Proxy(target, {
      get: function (t, p, receiver) {
        if (typeof p === 'symbol' || p in StorageProto) return Reflect.get(StorageProto, p, receiver);
        var v = stGet.call(real, nsPrefix() + p);
        return v === null ? undefined : v;
      },
      set: function (t, p, v) {
        if (typeof p === 'symbol') return Reflect.set(t, p, v);
        a.setItem(p, v);
        return true;
      },
      has: function (t, p) { return typeof p === 'symbol' || p in StorageProto ? p in StorageProto : a.has(p); },
      deleteProperty: function (t, p) {
        if (typeof p === 'symbol') return Reflect.deleteProperty(t, p);
        a.removeItem(p);
        return true;
      },
      ownKeys: function (t) { return keys().concat(Reflect.ownKeys(t)); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'symbol') return Reflect.getOwnPropertyDescriptor(t, p);
        var v = stGet.call(real, nsPrefix() + p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
      defineProperty: function (t, p, d) {
        if (typeof p === 'symbol') return Reflect.defineProperty(t, p, d);
        if ('value' in d) a.setItem(p, d.value);
        return true;
      },
    });
    storageApi.set(proxy, a);
    storageProxies.set(real, proxy);
    return proxy;
  }

  if (IS_WIN && StorageProto) {
    // Native methods called on an isolated storage (Storage.prototype.getItem.call(localStorage, k)).
    ['getItem', 'setItem', 'removeItem', 'clear', 'key'].forEach(function (m) {
      hook(StorageProto, m, function (native) {
        return function () {
          var a = storageApi.get(this);
          return a ? a[m].apply(a, arguments) : native.apply(this, arguments);
        };
      });
    });
    hookAccessor(StorageProto, 'length', function (g) {
      return function () { var a = storageApi.get(this); return a ? a.length() : g.call(this); };
    });
    ['localStorage', 'sessionStorage'].forEach(function (name) {
      var d = getDesc(G, name);
      if (!d || !d.get) return;
      var real;
      try { real = d.get.call(G); } catch (e) { return; } // storage disabled: keep the native error
      if (!real) return;
      if (name === 'localStorage') realLocal = real;
      var proxy = makeStorage(real);
      try {
        defineProp(G, name, { configurable: true, enumerable: d.enumerable, get: mask(function () { return proxy; }, d.get) });
      } catch (e) {}
    });
    if (G.StorageEvent) {
      mapGetter(StorageEvent.prototype, 'key', stripNs);
      mapGetter(StorageEvent.prototype, 'url', unrw);
      mapGetter(StorageEvent.prototype, 'storageArea', function (s) { return storageProxies.get(s) || s; });
    }
  }

  // IndexedDB, CacheStorage, BroadcastChannel and Web Locks are keyed by name: prefix the names.
  if (G.IDBFactory) {
    ['open', 'deleteDatabase'].forEach(function (m) {
      hook(IDBFactory.prototype, m, function (native) {
        return function (name) {
          var args = slice.call(arguments);
          if (args.length) args[0] = nsPrefix() + str(name);
          return native.apply(this, args);
        };
      });
    });
    hook(IDBFactory.prototype, 'databases', function (native) {
      return function databases() {
        return native.apply(this, arguments).then(function (list) {
          return list.filter(function (d) { return ownNs(d.name); }).map(function (d) {
            return { name: stripNs(d.name), version: d.version };
          });
        });
      };
    });
    if (G.IDBDatabase) mapGetter(IDBDatabase.prototype, 'name', stripNs);
  }

  if (G.CacheStorage) {
    var csOpen = CacheStorage.prototype.open, csKeys = CacheStorage.prototype.keys, csMatch = CacheStorage.prototype.match;
    ['open', 'has', 'delete'].forEach(function (m) {
      hook(CacheStorage.prototype, m, function (native) {
        return function (name) {
          var args = slice.call(arguments);
          if (args.length) args[0] = nsPrefix() + str(name);
          return native.apply(this, args);
        };
      });
    });
    hook(CacheStorage.prototype, 'keys', function (native) {
      return function keys() {
        return native.apply(this, arguments).then(function (names) { return names.filter(ownNs).map(stripNs); });
      };
    });
    hook(CacheStorage.prototype, 'match', function () {
      return function match(request, options) {
        var self = this;
        var req = cacheReq(request);
        if (options && options.cacheName != null) {
          return csMatch.call(self, req, O.assign({}, options, { cacheName: nsPrefix() + options.cacheName }));
        }
        // Without cacheName the native match would search every site's caches.
        return csKeys.call(self).then(function (names) {
          names = names.filter(ownNs);
          var i = 0;
          var next = function () {
            if (i >= names.length) return undefined;
            return csOpen.call(self, names[i++]).then(function (c) { return c.match(req, options); }).then(function (r) { return r || next(); });
          };
          return next();
        });
      };
    });
  }
  function cacheReq(r) {
    if (typeof r === 'string' || isA(r, 'URL')) return rw(r);
    return r;
  }
  if (G.Cache) {
    ['match', 'matchAll', 'add', 'delete', 'keys', 'put'].forEach(function (m) {
      hook(Cache.prototype, m, function (native) {
        return function (request) {
          var args = slice.call(arguments);
          if (args.length && args[0] !== undefined) args[0] = cacheReq(args[0]);
          return native.apply(this, args);
        };
      });
    });
    hook(Cache.prototype, 'addAll', function (native) {
      return function addAll(requests) {
        var args = slice.call(arguments);
        if (args.length && requests && typeof requests[Symbol.iterator] === 'function') args[0] = Array.from(requests, cacheReq);
        return native.apply(this, args);
      };
    });
  }

  wrapCtor(G, 'BroadcastChannel', function (args) { if (args.length) args[0] = nsPrefix() + str(args[0]); return args; });
  if (G.BroadcastChannel) mapGetter(BroadcastChannel.prototype, 'name', stripNs);

  if (G.LockManager) {
    hook(LockManager.prototype, 'request', function (native) {
      return function request(name) {
        var args = slice.call(arguments);
        // Names starting with "-" are reserved; keep them so the native error is raised.
        if (args.length && str(name).charAt(0) !== '-') args[0] = nsPrefix() + str(name);
        return native.apply(this, args);
      };
    });
    hook(LockManager.prototype, 'query', function (native) {
      return function query() {
        return native.apply(this, arguments).then(function (s) {
          var fix = function (list) {
            return (list || []).filter(function (l) { return ownNs(l.name); }).map(function (l) {
              return { name: stripNs(l.name), mode: l.mode, clientId: l.clientId };
            });
          };
          return { held: fix(s.held), pending: fix(s.pending) };
        });
      };
    });
    if (G.Lock) mapGetter(Lock.prototype, 'name', stripNs);
  }

  hookAccessor(G, 'origin', function () { return function () { return targetOrigin(); }; });

  // --- JS entry points that take code as strings -------------------------------------------

  var jsHooks = false;
  function installJsHooks() {
    if (jsHooks || !G.__proxyRewriteJs) return;
    jsHooks = true;
    var ctors = [Function];
    try { ctors.push(O.getPrototypeOf(function* () {}).constructor); } catch (e) {}
    try { ctors.push(O.getPrototypeOf(async function () {}).constructor); } catch (e) {}
    try { ctors.push(O.getPrototypeOf(async function* () {}).constructor); } catch (e) {}
    ctors.forEach(function (Native, idx) {
      var Wrapped = mask(function () {
        var args = slice.call(arguments);
        if (args.length) args[args.length - 1] = rwJs(str(args[args.length - 1]));
        // Keep subclassing (class F extends Function) working.
        return new.target && new.target !== Wrapped ? Reflect.construct(Native, args, new.target) : Native.apply(this, args);
      }, Native);
      Wrapped.prototype = Native.prototype;
      try { defineProp(Native.prototype, 'constructor', { value: Wrapped, writable: true, configurable: true }); } catch (e) {}
      if (idx === 0) {
        try { defineProp(G, 'Function', { value: Wrapped, writable: true, configurable: true }); } catch (e) {}
      }
    });
    ['setTimeout', 'setInterval'].forEach(function (name) {
      hook(G, name, function (native) {
        return function (handler) {
          if (typeof handler !== 'string') return native.apply(this, arguments);
          var args = slice.call(arguments);
          args[0] = rwJs(handler);
          return native.apply(this, args);
        };
      });
    });
  }

  if (!IS_WIN) {
    // Worker realms stop here: the rest of the runtime is about documents and windows.
    installJsHooks();
    return;
  }

  // --- navigation ----------------------------------------------------------------------------

  hook(G, 'open', function (native) {
    return function open(url) {
      var args = slice.call(arguments);
      if (args.length && url !== undefined && url !== null && str(url) !== '') args[0] = rw(url);
      var w = native.apply(this, args);
      if (w) {
        bootChild(w);
        if (popups.indexOf(w) < 0) popups.push(w);
      }
      return w;
    };
  });

  ['pushState', 'replaceState'].forEach(function (fn) {
    hook(History.prototype, fn, function (native) {
      return function (state, unused, url) {
        var args = slice.call(arguments);
        if (args.length > 2 && url !== undefined && url !== null) {
          var t = str(url);
          var dest = null;
          try { dest = new NativeURL(t, docBase()); } catch (e) {}
          if (dest && HTTP.test(dest.protocol) && dest.origin !== targetOrigin() && !isProxied(t)) {
            throw new DOMException("Failed to execute '" + fn + "' on 'History': A history state object with URL '" + dest.href +
              "' cannot be created in a document with origin '" + targetOrigin() + "'.", 'SecurityError');
          }
          args[2] = rw(t);
        }
        var r = native.apply(this, args);
        updateToolbar();
        return r;
      };
    });
  });

  var nDestUrl = G.NavigationDestination && getDesc(NavigationDestination.prototype, 'url');
  if (G.navigation && G.Navigation && nDestUrl) {
    hook(Navigation.prototype, 'navigate', function (native) {
      return function navigate(url) {
        var args = slice.call(arguments);
        if (args.length) args[0] = rw(url);
        return native.apply(this, args);
      };
    });
    mapGetter(NavigationDestination.prototype, 'url', unrw);
    if (G.NavigationHistoryEntry) mapGetter(NavigationHistoryEntry.prototype, 'url', unrw);
  }

  // Catch navigations to URLs that escaped rewriting (e.g. window['location'] = 'https://...').
  function onNavigate(e) {
    try {
      if (!e.cancelable || e.hashChange || e.downloadRequest || e.formData || e.navigationType === 'traverse' || e.navigationType === 'reload') return;
      var dest = new NativeURL(nDestUrl.get.call(e.destination));
      if (dest.origin === SELF && (PROXIED_REL.test(dest.pathname) || dest.pathname.lastIndexOf('/__proxy/', 0) === 0)) return;
      if (dest.protocol !== 'http:' && dest.protocol !== 'https:') return;
      var r = rw(dest.href);
      if (r === dest.href) return;
      e.preventDefault();
      if (e.navigationType === 'replace') G.location.replace(r); else G.location.assign(r);
    } catch (err) {}
  }

  // --- DOM: element URL properties ----------------------------------------------------------

  var attrOrig = new WeakMap(); // element -> { attr: [stored value, value the page set] }
  function remember(el, name, stored, original) {
    var m = attrOrig.get(el);
    if (!m) { m = {}; attrOrig.set(el, m); }
    m[name] = [stored, original];
  }
  function attrForPage(el, name, raw, kind) {
    var m = attrOrig.get(el), e = m && m[name];
    if (e && e[0] === raw) return e[1];
    if (raw.indexOf(PREFIX) < 0) return raw;
    if (kind === 1) { var t = raw.trim(), d = displayUrl(t); return d === t ? raw : d; }
    if (kind === 4) return raw.replace(/\S+/g, displayUrl);
    if (kind === 2) return unrwSrcset(raw);
    return raw;
  }

  function patchProp(Ctor, prop, kind) {
    var proto = Ctor && Ctor.prototype;
    var attr = prop.toLowerCase();
    hookAccessor(proto, prop,
      function (g) { return kind === 2 ? function () { return unrwSrcset(g.call(this)); } : function () { return unrw(g.call(this)); }; },
      function (s) {
        return function (v) {
          var nv = v;
          try {
            if (v != null) {
              nv = kind === 2 ? rwSrcset(v) : rw(v);
              if (nv !== v) remember(this, attr, nv, str(v));
            }
          } catch (e) {}
          s.call(this, nv);
        };
      });
  }
  [
    [G.HTMLAnchorElement, 'href'], [G.HTMLAreaElement, 'href'], [G.HTMLLinkElement, 'href'], [G.HTMLBaseElement, 'href'],
    [G.HTMLImageElement, 'src'], [G.HTMLImageElement, 'srcset', 2], [G.HTMLImageElement, 'lowsrc'], [G.HTMLScriptElement, 'src'],
    [G.HTMLIFrameElement, 'src'], [G.HTMLFrameElement, 'src'], [G.HTMLSourceElement, 'src'], [G.HTMLSourceElement, 'srcset', 2],
    [G.HTMLMediaElement, 'src'], [G.HTMLVideoElement, 'poster'], [G.HTMLTrackElement, 'src'], [G.HTMLEmbedElement, 'src'],
    [G.HTMLObjectElement, 'data'], [G.HTMLFormElement, 'action'], [G.HTMLInputElement, 'src'], [G.HTMLInputElement, 'formAction'],
    [G.HTMLButtonElement, 'formAction'], [G.HTMLLinkElement, 'imageSrcset', 2],
  ].forEach(function (x) { patchProp(x[0], x[1], x[2]); });
  if (G.HTMLImageElement) mapGetter(HTMLImageElement.prototype, 'currentSrc', unrw);
  if (G.HTMLMediaElement) mapGetter(HTMLMediaElement.prototype, 'currentSrc', unrw);
  if (G.StyleSheet) mapGetter(StyleSheet.prototype, 'href', unrw);

  // Hyperlink parts (a.hostname, a.pathname...) describe the real URL.
  ['HTMLAnchorElement', 'HTMLAreaElement'].forEach(function (name) {
    var C = G[name];
    if (!C) return;
    var hrefDesc = getDesc(C.prototype, 'href');
    ['host', 'hostname', 'origin', 'pathname', 'port', 'protocol', 'search', 'hash', 'username', 'password'].forEach(function (part) {
      hookAccessor(C.prototype, part,
        function (g) {
          return function () {
            var real = hrefDesc.get.call(this);
            if (!real) return g.call(this);
            try { return new NativeURL(real)[part]; } catch (e) { return g.call(this); }
          };
        },
        function (s) {
          return function (v) {
            var real = hrefDesc.get.call(this);
            try { var u = new NativeURL(real); u[part] = v; hrefDesc.set.call(this, u.href); } catch (e) { s.call(this, v); }
          };
        });
    });
    hook(C.prototype, 'toString', function () { return function toString() { return hrefDesc.get.call(this); }; });
  });

  // integrity would fail because the proxy rewrites content.
  [G.HTMLScriptElement, G.HTMLLinkElement].forEach(function (C) {
    var d = C && getDesc(C.prototype, 'integrity');
    if (d && d.configurable) {
      defineProp(C.prototype, 'integrity', {
        configurable: true, enumerable: d.enumerable,
        get: mask(function () { return ''; }, d.get), set: mask(function () {}, d.set),
      });
    }
  });

  // --- DOM: attributes -----------------------------------------------------------------------

  /** Rewrite an attribute value the page is setting; null means "drop it". */
  function rwAttr(el, n, v) {
    var kind = ATTR_KIND[n];
    if (kind === 1 || (n === 'data' && el.localName === 'object')) return rw(v);
    if (kind === 2) return rwSrcset(v);
    if (kind === 3) return rwCss(v);
    if (kind === 4) return v.replace(/\S+/g, function (u) { return rw(u); });
    if (kind === 5) return el.localName === 'iframe' ? rwHtml(v, true) : v;
    if (kind === 6) return null;
    if (n.length > 2 && n.charCodeAt(0) === 111 && n.charCodeAt(1) === 110) return rwJs(v);
    if (el.localName === 'meta') {
      if (n === 'http-equiv' && /^\s*content-security-policy/i.test(v)) return 'x-proxy-blocked-csp';
      if (n === 'name' && /^\s*referrer\s*$/i.test(v)) return 'x-proxy-blocked-referrer';
      if (n === 'content' && /^\s*refresh\s*$/i.test(nGetAttr.call(el, 'http-equiv') || '')) return rwRefresh(v);
    }
    return v;
  }

  hook(ElementProto, 'setAttribute', function (native) {
    return function setAttribute(name, value) {
      if (arguments.length < 2) return native.apply(this, arguments);
      var v = value;
      try {
        var n = str(name).toLowerCase();
        if (ATTR_KIND[n] || n === 'data' || n.charCodeAt(0) === 111 || n === 'http-equiv' || n === 'name' || n === 'content') {
          var sv = str(value), nv = rwAttr(this, n, sv);
          if (nv === null) return;
          if (nv !== sv) { remember(this, n, nv, sv); v = nv; }
        }
      } catch (e) {}
      return native.call(this, name, v);
    };
  });
  hook(ElementProto, 'setAttributeNS', function (native) {
    return function setAttributeNS(ns, name, value) {
      if (arguments.length < 3) return native.apply(this, arguments);
      var v = value;
      try {
        var local = str(name).replace(/^.*:/, '').toLowerCase();
        if (local === 'href' || local === 'src') { v = rw(str(value)); if (v !== str(value)) remember(this, local, v, str(value)); }
      } catch (e) {}
      return native.call(this, ns, name, v);
    };
  });
  hook(ElementProto, 'getAttribute', function (native) {
    return function getAttribute(name) {
      var v = native.apply(this, arguments);
      if (v === null || v === '') return v;
      try {
        var n = str(name).toLowerCase(), kind = ATTR_KIND[n];
        if (n === 'data') kind = 1;
        if (kind && kind !== 6) return attrForPage(this, n, v, kind);
        if (n.charCodeAt(0) === 111 && n.charCodeAt(1) === 110) return attrForPage(this, n, v, 0);
      } catch (e) {}
      return v;
    };
  });
  hook(ElementProto, 'getAttributeNS', function (native) {
    return function getAttributeNS(ns, name) {
      var v = native.apply(this, arguments);
      if (!v) return v;
      try {
        var local = str(name).toLowerCase();
        if (local === 'href' || local === 'src') return attrForPage(this, local, v, 1);
      } catch (e) {}
      return v;
    };
  });

  // --- DOM: markup and script text set from JS ---------------------------------------------

  function htmlArg(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && G.TrustedHTML && v instanceof G.TrustedHTML) return String(v);
    return null;
  }
  var FRAME_HINT = /<i?frame[\s/>]/i;

  /** Text for the content of a <script> / <style> element. */
  function elementText(el, v) {
    var nm = el.localName;
    if (nm === 'script') return isJsType(nGetAttr.call(el, 'type')) ? rwJs(v) : v;
    if (nm === 'style') return rwCss(v);
    return null;
  }

  function markupSetter(nset) {
    return function (v) {
      var s = htmlArg(v);
      if (s !== null) {
        try {
          var t = this.nodeType === 1 ? elementText(this, s) : null;
          v = t !== null ? t : rwHtml(s);
        } catch (e) {}
      }
      nset.call(this, v);
      if (s !== null && FRAME_HINT.test(s)) bootFramesIn(this);
    };
  }
  hookAccessor(ElementProto, 'innerHTML', null, markupSetter);
  if (G.ShadowRoot) hookAccessor(ShadowRoot.prototype, 'innerHTML', null, markupSetter);
  hookAccessor(ElementProto, 'outerHTML', null, function (nset) {
    return function (v) {
      var s = htmlArg(v), parent = this.parentNode;
      if (s !== null) { try { v = rwHtml(s); } catch (e) {} }
      nset.call(this, v);
      if (s !== null && parent && FRAME_HINT.test(s)) bootFramesIn(parent);
    };
  });
  hook(ElementProto, 'insertAdjacentHTML', function (native) {
    return function insertAdjacentHTML(pos, html) {
      var args = slice.call(arguments), s = htmlArg(html);
      if (s !== null) { try { args[1] = rwHtml(s); } catch (e) {} }
      var r = native.apply(this, args);
      if (s !== null && FRAME_HINT.test(s)) bootFramesIn(this.parentNode || this);
      return r;
    };
  });
  ['setHTMLUnsafe'].forEach(function (m) {
    [ElementProto, G.ShadowRoot && ShadowRoot.prototype].forEach(function (proto) {
      hook(proto, m, function (native) {
        return function (html) {
          var args = slice.call(arguments), s = htmlArg(html);
          if (s !== null) { try { args[0] = rwHtml(s); } catch (e) {} }
          return native.apply(this, args);
        };
      });
    });
  });
  if (G.Range) {
    hook(Range.prototype, 'createContextualFragment', function (native) {
      return function createContextualFragment(html) {
        var args = slice.call(arguments), s = htmlArg(html);
        if (s !== null) { try { args[0] = rwHtml(s); } catch (e) {} }
        return native.apply(this, args);
      };
    });
  }
  ['write', 'writeln'].forEach(function (m) {
    hook(Document.prototype, m, function (native) {
      return function () {
        var args = slice.call(arguments).map(function (a) {
          var s = htmlArg(a);
          try { return s !== null ? rwHtml(s) : a; } catch (e) { return a; }
        });
        var r = native.apply(this, args);
        // Writing after load implicitly calls document.open(), which drops every listener.
        if (this === document) addListeners();
        return r;
      };
    });
  });
  hook(Document.prototype, 'open', function (native) {
    return function open() {
      var r = native.apply(this, arguments);
      if (this === document && arguments.length < 3) addListeners();
      return r;
    };
  });

  var srcdocOrig = new WeakMap();
  if (G.HTMLIFrameElement) {
    hookAccessor(HTMLIFrameElement.prototype, 'srcdoc',
      function (g) {
        return function () { var v = g.call(this), o = srcdocOrig.get(this); return o && o[0] === v ? o[1] : v; };
      },
      function (s) {
        return function (v) {
          var h = htmlArg(v);
          if (h !== null) {
            try {
              var nv = rwHtml(h, true);
              srcdocOrig.set(this, [nv, h]);
              v = nv;
            } catch (e) {}
          }
          s.call(this, v);
        };
      });
  }

  function textSetter(nset) {
    return function (v) {
      if (typeof v === 'string' && this.nodeType === 1) {
        try { var t = elementText(this, v); if (t !== null) v = t; } catch (e) {}
      }
      nset.call(this, v);
    };
  }
  hookAccessor(Node.prototype, 'textContent', null, textSetter);
  hookAccessor(HTMLElement.prototype, 'innerText', null, textSetter);
  if (G.HTMLScriptElement) hookAccessor(HTMLScriptElement.prototype, 'text', null, textSetter);

  // Insertion: text appended into a not-yet-run <script> (script.appendChild(createTextNode(code)))
  // is rewritten, and subtrees built in another document (DOMParser, inert templates) are fixed
  // before they are connected, because stylesheets and objects start loading on insertion.
  function prepInsert(parent, node) {
    if (node === null || node === undefined) return node;
    try {
      if (typeof node === 'object' && (node.nodeType === 1 || node.nodeType === 11) && node.ownerDocument !== (parent.ownerDocument || parent)) {
        fixTree(node);
      }
      if (parent.nodeType !== 1) return node;
      var nm = parent.localName;
      if (nm !== 'script' && nm !== 'style') return node;
      if (typeof node === 'string') { var t = elementText(parent, node); return t === null ? node : t; }
      if (node.nodeType === 3) { var d = elementText(parent, node.data); if (d !== null && d !== node.data) node.data = d; }
    } catch (e) {}
    return node;
  }
  ['appendChild', 'insertBefore', 'replaceChild'].forEach(function (m) {
    hook(Node.prototype, m, function (native) {
      return function (node) {
        if (node) prepInsert(this, node);
        return native.apply(this, arguments);
      };
    });
  });
  [ElementProto, Document.prototype, DocumentFragment.prototype].forEach(function (proto) {
    ['append', 'prepend', 'replaceChildren'].forEach(function (m) {
      hook(proto, m, function (native) {
        return function () {
          var self = this, args = slice.call(arguments);
          for (var i = 0; i < args.length; i++) args[i] = prepInsert(self, args[i]);
          return native.apply(this, args);
        };
      });
    });
  });
  ['importNode', 'adoptNode'].forEach(function (m) {
    hook(Document.prototype, m, function (native) {
      return function () {
        var n = native.apply(this, arguments);
        if (this === document && n && (n.nodeType === 1 || n.nodeType === 11)) { try { fixTree(n); } catch (e) {} }
        return n;
      };
    });
  });

  // --- DOM: inline styles and stylesheets ---------------------------------------------------

  if (G.CSSStyleDeclaration) {
    var CSD = CSSStyleDeclaration.prototype;
    hook(CSD, 'setProperty', function (native) {
      return function setProperty(p, v) {
        var args = slice.call(arguments);
        if (typeof v === 'string') args[1] = rwCss(v);
        return native.apply(this, args);
      };
    });
    var cssProps = ['cssText', 'background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage',
      'content', 'cursor', 'mask', 'maskImage', 'webkitMask', 'webkitMaskImage', 'webkitMaskBoxImage', 'shapeOutside',
      'filter', 'clipPath', 'offsetPath'];
    // Engines that expose CSS properties as accessors (Firefox, newer CSSOM) are hooked directly;
    // Chrome uses an interceptor, which the mutation observer below covers.
    [CSD, G.CSS2Properties && CSS2Properties.prototype, G.CSSStyleProperties && CSSStyleProperties.prototype].forEach(function (proto) {
      if (!proto) return;
      cssProps.concat(cssProps.map(function (p) { return p.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); }); }))
        .forEach(function (p) {
          hookAccessor(proto, p, null, function (s) { return function (v) { s.call(this, typeof v === 'string' ? rwCss(v) : v); }; });
        });
    });
  }
  [G.HTMLElement, G.SVGElement].forEach(function (C) {
    if (C) hookAccessor(C.prototype, 'style', null, function (s) { return function (v) { s.call(this, typeof v === 'string' ? rwCss(v) : v); }; });
  });
  if (G.CSSStyleSheet) {
    var sheetBase = function (sheet) { try { return sheet.href || undefined; } catch (e) { return undefined; } };
    hook(CSSStyleSheet.prototype, 'insertRule', function (native) {
      return function insertRule(rule) {
        var args = slice.call(arguments);
        if (typeof rule === 'string') args[0] = rwCss(rule, sheetBase(this));
        return native.apply(this, args);
      };
    });
    ['replace', 'replaceSync'].forEach(function (m) {
      hook(CSSStyleSheet.prototype, m, function (native) {
        return function (text) {
          var args = slice.call(arguments);
          if (typeof text === 'string') args[0] = rwCss(text);
          return native.apply(this, args);
        };
      });
    });
  }

  // --- DOM: catch-all for anything inserted or changed without going through the hooks above -

  var FIX_ATTRS = ['src', 'href', 'action', 'formaction', 'poster', 'srcset', 'imagesrcset', 'data', 'background', 'lowsrc', 'integrity'];
  // Inline style changes are observed too: Chrome serves el.style.backgroundImage & co. through
  // an interceptor that cannot be wrapped, and the observer runs before the next style recalc.
  var MO_ATTRS = FIX_ATTRS.concat('style');
  var FIX_SELECTOR = '[src],[href],[action],[formaction],[poster],[srcset],[imagesrcset],[background],[lowsrc],[style*="url("],object[data],[integrity],style,iframe,frame';

  function fixAttr(el, n) {
    var v = nGetAttr.call(el, n);
    if (v === null || v === '') return;
    var kind = ATTR_KIND[n], nv = v;
    if (kind === 6) { if (n === 'integrity') nRemoveAttr.call(el, n); return; }
    if (kind === 1 || (n === 'data' && el.localName === 'object')) {
      var t = v.trim();
      if (t.charCodeAt(0) !== 35 && !isProxied(t)) nv = rw(v);
    } else if (kind === 2) nv = rwSrcset(v);
    else if (kind === 3) nv = rwCss(v);
    if (nv !== v) { remember(el, n, nv, v); nSetAttr.call(el, n, nv); }
  }
  function fixElement(el) {
    for (var i = 0; i < FIX_ATTRS.length; i++) if (nHasAttr.call(el, FIX_ATTRS[i])) fixAttr(el, FIX_ATTRS[i]);
    if (nHasAttr.call(el, 'style')) fixAttr(el, 'style');
    var nm = el.localName;
    if (nm === 'style') {
      var css = el.textContent;
      if (CSS_HINT.test(css)) { var nc = rwCss(css); if (nc !== css) nTextSet.call(el, nc); }
    } else if (nm === 'iframe' || nm === 'frame') bootFrame(el);
  }
  function fixTree(node) {
    if (node.nodeType === 1) fixElement(node);
    else if (node.nodeType !== 11) return;
    if (node.firstElementChild) {
      var list = node.nodeType === 1 ? nQSA.call(node, FIX_SELECTOR) : node.querySelectorAll(FIX_SELECTOR);
      for (var i = 0; i < list.length; i++) fixElement(list[i]);
    }
  }
  function bootFrame(el) {
    try {
      var w = el.localName === 'iframe' && nContentWindow ? nContentWindow.call(el) : el.contentWindow;
      if (w) bootChild(w);
    } catch (e) {}
  }
  function bootFramesIn(root) {
    try {
      if (!root || !root.querySelectorAll) return;
      var list = root.querySelectorAll('iframe,frame');
      for (var i = 0; i < list.length; i++) bootFrame(list[i]);
    } catch (e) {}
  }

  var mo = null;
  var MO_OPTS = { childList: true, subtree: true, attributes: true, attributeFilter: MO_ATTRS };
  if (G.MutationObserver) {
    mo = new MutationObserver(function (records) {
      // One fix per element and attribute per batch, however often a page rewrote it.
      var seen = records.length > 1 ? new Map() : null;
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        try {
          if (r.type === 'attributes') {
            if (r.attributeNamespace !== null || r.target.nodeType !== 1) continue;
            if (seen) {
              var names = seen.get(r.target);
              if (!names) seen.set(r.target, names = []);
              else if (names.indexOf(r.attributeName) >= 0) continue;
              names.push(r.attributeName);
            }
            fixAttr(r.target, r.attributeName);
          } else {
            for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
          }
        } catch (e) {}
      }
    });
  }

  // Same-origin child windows (about:blank / srcdoc frames) get the runtime when first touched.
  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement'].forEach(function (name) {
    var C = G[name];
    if (!C) return;
    ['contentWindow', 'contentDocument'].forEach(function (prop) {
      hookAccessor(C.prototype, prop, function (g) {
        return function () {
          var v = g.call(this);
          if (v) bootChild(prop === 'contentWindow' ? v : v.defaultView);
          return v;
        };
      });
    });
  });

  // Forms submitted with an action set at the last moment, or through form.submit().
  function fixForm(form, submitter) {
    try {
      var a = nGetAttr.call(form, 'action');
      if (a && !isProxied(a.trim())) fixAttr(form, 'action');
      if (submitter && submitter.nodeType === 1) {
        var fa = nGetAttr.call(submitter, 'formaction');
        if (fa && !isProxied(fa.trim())) fixAttr(submitter, 'formaction');
      }
    } catch (e) {}
  }
  if (G.HTMLFormElement) {
    hook(HTMLFormElement.prototype, 'submit', function (native) {
      return function submit() { fixForm(this); return native.apply(this, arguments); };
    });
  }
  function onSubmit(e) {
    if (e.target && e.target.localName === 'form') fixForm(e.target, e.submitter);
  }
  function onClick(e) {
    try {
      var path = e.composedPath ? e.composedPath() : [];
      for (var i = 0; i < path.length && i < 12; i++) {
        var el = path[i];
        if (el && (el.localName === 'a' || el.localName === 'area') && nHasAttr.call(el, 'href')) { fixAttr(el, 'href'); break; }
      }
    } catch (err) {}
  }

  // --- document properties ------------------------------------------------------------------

  function cookieUrl() { return '/__proxy/cookie?url=' + encodeURIComponent(currentUrl()); }
  function cookieRequest(method, body) {
    var x = new XHR();
    xhrOpen.call(x, method, cookieUrl(), false);
    xhrSend.call(x, body);
    return x.status === 200 ? x.responseText : null;
  }
  function readCookies(force) {
    var now = Date.now();
    if (!force && cookieCache !== null && now - cookieAt < 2000) return cookieCache;
    try {
      var t = cookieRequest('GET', null);
      if (t !== null) cookieCache = t;
    } catch (e) {}
    cookieAt = now;
    return cookieCache || '';
  }
  function writeCookie(v) {
    try {
      var t = cookieRequest('POST', String(v));
      if (t !== null) { cookieCache = t; cookieAt = Date.now(); } else cookieCache = null;
    } catch (e) { cookieCache = null; }
  }
  hookAccessor(Document.prototype, 'cookie',
    function (g) { return function () { return this === document ? readCookies(false) : g.call(this); }; },
    function (s) { return function (v) { if (this === document) writeCookie(v); else s.call(this, v); }; });

  // Cookie Store API on top of the same cookie jar.
  if (G.CookieStore && G.cookieStore) {
    var parseJar = function () {
      return readCookies(true).split(/;\s*/).filter(Boolean).map(function (p) {
        var i = p.indexOf('=');
        return i < 0 ? { name: '', value: p } : { name: p.slice(0, i), value: p.slice(i + 1) };
      });
    };
    var asName = function (x) { return x && typeof x === 'object' ? x.name : x; };
    var asyncCall = function (fn) { return new Promise(function (resolve) { resolve(fn()); }); };
    var cookieInfo = function (c) {
      return { name: c.name, value: c.value, domain: null, path: '/', expires: null, secure: SELF.lastIndexOf('https:', 0) === 0, sameSite: 'lax', partitioned: false };
    };
    var notify = function (changed, deleted) {
      try { G.cookieStore.dispatchEvent(new CookieChangeEvent('change', { changed: changed, deleted: deleted })); } catch (e) {}
    };
    var CSP = CookieStore.prototype;
    hook(CSP, 'get', function () {
      return function get(opt) {
        var name = asName(opt);
        return asyncCall(function () {
          var c = parseJar().filter(function (x) { return name === undefined || x.name === String(name); })[0];
          return c ? cookieInfo(c) : null;
        });
      };
    });
    hook(CSP, 'getAll', function () {
      return function getAll(opt) {
        var name = asName(opt);
        return asyncCall(function () {
          return parseJar().filter(function (x) { return name === undefined || x.name === String(name); }).map(cookieInfo);
        });
      };
    });
    hook(CSP, 'set', function () {
      return function set(a, b) {
        var o = a && typeof a === 'object' ? a : { name: a, value: b };
        return asyncCall(function () {
          var s = String(o.name) + '=' + String(o.value) + '; path=' + (o.path || '/');
          if (o.expires != null) s += '; expires=' + new Date(o.expires).toUTCString();
          if (o.domain) s += '; domain=' + o.domain;
          if (o.sameSite) s += '; samesite=' + o.sameSite;
          writeCookie(s);
          notify([{ name: String(o.name), value: String(o.value) }], []);
        });
      };
    });
    hook(CSP, 'delete', function () {
      return function (opt) {
        var o = opt && typeof opt === 'object' ? opt : { name: opt };
        return asyncCall(function () {
          writeCookie(String(o.name) + '=; path=' + (o.path || '/') + '; expires=Thu, 01 Jan 1970 00:00:00 GMT' + (o.domain ? '; domain=' + o.domain : ''));
          notify([], [{ name: String(o.name) }]);
        });
      };
    });
  }

  mapGetter(Document.prototype, 'referrer', function (r) {
    if (!r) return r;
    var d = decode(r);
    return d || (r.lastIndexOf(SELF, 0) === 0 ? '' : r);
  });
  mapGetter(Document.prototype, 'URL', unrw);
  mapGetter(Document.prototype, 'documentURI', unrw);
  mapGetter(Node.prototype, 'baseURI', unrw);
  hookAccessor(Document.prototype, 'domain',
    function () {
      return function () {
        if (this !== document) return '';
        try { return new NativeURL(currentUrl()).hostname; } catch (e) { return ''; }
      };
    },
    function () { return function () {}; });

  // --- postMessage ---------------------------------------------------------------------------
  // Every proxied frame shares the proxy origin, so an explicit targetOrigin is checked against
  // the receiver's real origin and replaced by '*'. The browser reports as event.source the realm
  // of the innermost JS function on the stack, which would be this wrapper (the receiver's
  // realm), so the native call is made through a trampoline living in the sender's realm.

  var NativeError = G.Error;
  var unmask = function (fn) { return masked.get(fn) || fn; };
  var nEntriesByName = G.Performance && unmask(G.Performance.prototype.getEntriesByName);
  var nScriptSrc = unmask(getDesc(HTMLScriptElement.prototype, 'src').get);
  var popups = [];
  var STACK_URL = /((?:https?|blob):[^\s()]+?):\d+:\d+\)?$/;

  /** Script URL of the innermost stack frame that is not the runtime's own code. */
  function callerScriptUrl() {
    var limit = NativeError.stackTraceLimit, prep = NativeError.prepareStackTrace, st = '';
    try {
      NativeError.stackTraceLimit = 25;
      NativeError.prepareStackTrace = undefined;
      st = String(new NativeError().stack);
    } catch (e) {}
    try { NativeError.stackTraceLimit = limit; NativeError.prepareStackTrace = prep; } catch (e) {}
    var lines = st.split('\n');
    for (var i = 1; i < lines.length; i++) {
      var m = STACK_URL.exec(lines[i].trim());
      if (!m || m[1].indexOf('/__proxy/') >= 0) continue;
      return m[1].replace(/#.*$/, '');
    }
    return null;
  }

  /** Did this realm's document run a script from url (inline scripts report the page URL)? */
  function ownsScript(url) {
    try {
      if (G.location.href.replace(/#.*$/, '') === url) return true;
      var list = document.scripts;
      for (var i = 0; i < list.length; i++) if (nScriptSrc.call(list[i]) === url) return true;
      return nEntriesByName ? nEntriesByName.call(performance, url).length > 0 : false;
    } catch (e) { return false; }
  }

  /** Every same-origin window this one can reach: the frame tree, openers and popups. */
  function reachableWindows() {
    var out = [], seen = [];
    var add = function (w, deep) {
      try {
        if (!w || seen.indexOf(w) >= 0 || !w.__proxy) return;
        seen.push(w);
        out.push(w);
        for (var i = 0; i < w.frames.length; i++) add(w.frames[i], deep);
        if (deep) {
          add(w.opener && w.opener.top, deep - 1);
          var ps = w.__proxy.popups();
          for (var j = 0; j < ps.length; j++) add(ps[j], deep - 1);
        }
      } catch (e) {}
    };
    add(G.top, 2);
    return out;
  }

  /** The window whose code is calling postMessage on `target`, or null if unknown. */
  function senderOf(target, message) {
    if (G.top === G && G.frames.length === 0 && !G.opener && !popups.length) return null;
    var wins = reachableWindows();
    if (message !== null && typeof message === 'object') {
      // Objects carry their realm: walk up to that realm's Object.prototype.
      try {
        var root = message, next;
        while ((next = O.getPrototypeOf(root)) !== null) root = next;
        for (var k = 0; k < wins.length; k++) if (wins[k].Object.prototype === root) return wins[k];
      } catch (e) {}
    }
    var url = callerScriptUrl();
    if (!url) return null;
    var found = null;
    for (var i = 0; i < wins.length; i++) {
      try {
        if (!wins[i].__proxy.ownsScript(url)) continue;
        if (wins[i] !== target) return wins[i];
        found = wins[i];
      } catch (e) {}
    }
    return found;
  }

  api.ownsScript = ownsScript;
  api.popups = function () {
    popups = popups.filter(function (w) { try { return !w.closed; } catch (e) { return false; } });
    return popups;
  };
  api.invoke = function (fn, self, args) { return fn.apply(self, args); };

  hook(G, 'postMessage', function (native) {
    return function postMessage(message, targetOriginArg) {
      var args = slice.call(arguments);
      var target = this == null ? G : this;
      try {
        var opts = targetOriginArg && typeof targetOriginArg === 'object' ? targetOriginArg : null;
        var to = opts ? opts.targetOrigin : targetOriginArg;
        if (to !== undefined && to !== null && to !== '*' && to !== '/') {
          var want = new NativeURL(str(to)).origin;
          var have = target !== G && target.__proxy ? target.__proxy.origin() : targetOrigin();
          if (want !== have) return undefined;
          if (opts) args[1] = O.assign({}, opts, { targetOrigin: '*' }); else args[1] = '*';
        }
        if (args.length) {
          var from = senderOf(target, message);
          if (from && from !== G) return from.__proxy.invoke(native, target, args);
        }
      } catch (e) {}
      return native.apply(target, args);
    };
  });
  if (G.MessageEvent) {
    var nSource = getDesc(MessageEvent.prototype, 'source');
    hookAccessor(MessageEvent.prototype, 'origin', function (g) {
      return function () {
        var o = g.call(this);
        if (o !== SELF && o !== WS_SELF) return o;
        try {
          var t = this.target;
          if (t && (isA(t, 'WebSocket') || isA(t, 'EventSource'))) return originOf(t.url) || o;
          var src = nSource && nSource.get.call(this);
          if (src && src.__proxy) return src.__proxy.origin();
        } catch (e) {}
        return o === SELF ? targetOrigin() : o;
      };
    });
  }

  // The storage event fires for every proxied site sharing the real storage: keep only ours.
  function onStorage(e) {
    try {
      var k = nStorageKeyGet ? nStorageKeyGet.call(e) : null;
      if (k === null) return;
      if (!ownNs(k)) e.stopImmediatePropagation();
      else { var area = storageProxies.get(nStorageAreaGet.call(e)); var a = area && storageApi.get(area); if (a) a.dirty(); }
    } catch (err) {}
  }
  var nStorageKeyGet = null, nStorageAreaGet = null;
  if (G.StorageEvent) {
    // mapGetter already wrapped these; masked maps the wrappers back to the natives.
    nStorageKeyGet = masked.get(getDesc(StorageEvent.prototype, 'key').get) || null;
    nStorageAreaGet = masked.get(getDesc(StorageEvent.prototype, 'storageArea').get) || null;
  }

  // --- floating toolbar (top window only) ---------------------------------------------------

  var TOOLBAR_KEY = '__proxy_toolbar_hidden';
  var toolbarHost = null, toolbarInput = null;

  function updateToolbar() {
    if (toolbarInput && document.activeElement !== toolbarHost) toolbarInput.value = currentUrl();
  }

  function buildToolbar() {
    if (toolbarHost && toolbarHost.isConnected) return;
    if (G.top !== G || cfg.toolbar === false || cfg.child || !document.documentElement || !decode(G.location.href)) return;
    var hidden = false;
    try { hidden = realLocal && stGet.call(realLocal, TOOLBAR_KEY) === '1'; } catch (e) {}
    toolbarHost = document.createElement('proxy-toolbar');
    toolbarHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
    var root = toolbarHost.attachShadow ? toolbarHost.attachShadow({ mode: 'closed' }) : toolbarHost;
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.wrap{font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8eaf0;background:rgba(23,26,33,.94);border:1px solid #2a2f3a;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;gap:4px;padding:4px;max-width:calc(100vw - 24px)}' +
      '.full{display:contents}' +
      '.wrap.min .full{display:none}' +
      'button{all:unset;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;color:#e8eaf0}' +
      'button:hover{background:#2a2f3a}' +
      'button:focus-visible{outline:2px solid #748ffc}' +
      'input{all:unset;width:min(52vw,420px);padding:5px 8px;border-radius:8px;background:#0f1115;color:#e8eaf0;border:1px solid #2a2f3a;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box}' +
      'input:focus{border-color:#748ffc}' +
      'svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      '</style>' +
      '<div class="wrap' + (hidden ? ' min' : '') + '">' +
      '<button class="toggle" title="Proxy controls" aria-label="Toggle proxy controls"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9z"/></svg></button>' +
      '<span class="full">' +
      '<button class="back" title="Back" aria-label="Back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>' +
      '<button class="fwd" title="Forward" aria-label="Forward"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>' +
      '<button class="reload" title="Reload" aria-label="Reload"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>' +
      '<input class="addr" spellcheck="false" autocomplete="off" aria-label="Address">' +
      '<button class="home" title="Proxy home" aria-label="Proxy home"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg></button>' +
      '</span></div>';
    var wrap = root.querySelector('.wrap');
    toolbarInput = root.querySelector('.addr');
    toolbarInput.value = currentUrl();
    root.querySelector('.toggle').addEventListener('click', function () {
      wrap.classList.toggle('min');
      try { if (realLocal) stSet.call(realLocal, TOOLBAR_KEY, wrap.classList.contains('min') ? '1' : '0'); } catch (e) {}
    });
    root.querySelector('.back').addEventListener('click', function () { history.back(); });
    root.querySelector('.fwd').addEventListener('click', function () { history.forward(); });
    root.querySelector('.reload').addEventListener('click', function () { G.location.reload(); });
    root.querySelector('.home').addEventListener('click', function () { G.location.href = '/__proxy/home'; });
    toolbarInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') {
        var v = toolbarInput.value.trim();
        if (v) G.location.href = '/__proxy/go?url=' + encodeURIComponent(v);
      } else if (e.key === 'Escape') { toolbarInput.value = currentUrl(); toolbarInput.blur(); }
    });
    ['keyup', 'keypress', 'input'].forEach(function (t) { toolbarInput.addEventListener(t, function (e) { e.stopPropagation(); }); });
    toolbarInput.addEventListener('focus', function () { toolbarInput.select(); });
    document.documentElement.appendChild(toolbarHost);
  }

  // --- per-document setup -------------------------------------------------------------------

  var setupDoc = null;
  function addListeners() {
    try {
      document.addEventListener('submit', onSubmit, true);
      document.addEventListener('click', onClick, true);
      G.addEventListener('storage', onStorage, true);
      G.addEventListener('popstate', updateToolbar);
      G.addEventListener('hashchange', updateToolbar);
      G.addEventListener('focus', invalidateCookies, true);
      if (G.navigation && nDestUrl) G.navigation.addEventListener('navigate', onNavigate);
      if (toolbarHost && !toolbarHost.isConnected) setTimeout(buildToolbar, 0);
    } catch (e) {}
  }

  function initDocument() {
    var c = G.__PROXY_CFG;
    if (c && typeof c === 'object' && c !== cfg && c.url) {
      cfg = c;
      resetCaches();
      cookieCache = typeof c.cookies === 'string' ? c.cookies : null;
      cookieAt = Date.now();
    }
    var doc = G.document;
    if (!doc) return;
    if (doc === setupDoc) { addListeners(); return; }
    setupDoc = doc;
    resetCaches();
    installJsHooks();
    try { if (mo) mo.observe(doc, MO_OPTS); } catch (e) {}
    toolbarHost = null;
    toolbarInput = null;
    addListeners();
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', buildToolbar);
    else buildToolbar();
  }
  initDocument();
})();
