/* Proxy browser runtime: keeps every URL a page builds at runtime inside the proxy. */
(function () {
  'use strict';
  if (window.__PROXY_RUNTIME__) return;
  var cfg = window.__PROXY_CFG || {};
  Object.defineProperty(window, '__PROXY_RUNTIME__', { value: true });

  var PREFIX = cfg.prefix || '/p/';
  var SELF = location.origin;
  var SKIP = /^(?:data|blob|javascript|about|mailto|tel|sms|chrome|chrome-extension|moz-extension|intent|vbscript|filesystem|urn|magnet):/i;
  var PROXIED_REL = /^\/p\/(?:https?|wss?):\/\/?/i;
  var HTTP = /^(?:https?|wss?):$/;

  // Native accessors captured before anything is patched.
  var nativeBaseURI = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
  var realSessionStorage = null;
  try { realSessionStorage = window.sessionStorage; } catch (e) {}
  var reqUrlDesc = typeof Request !== 'undefined' ? Object.getOwnPropertyDescriptor(Request.prototype, 'url') : null;

  // --- URL helpers ---------------------------------------------------------------------

  function decode(u) {
    if (typeof u !== 'string') return null;
    var rest = null;
    if (u.indexOf(SELF + PREFIX) === 0) rest = u.slice(SELF.length + PREFIX.length);
    else if (PROXIED_REL.test(u)) rest = u.slice(PREFIX.length);
    if (rest === null) return null;
    rest = rest.replace(/^(https?|wss?):\/(?!\/)/i, '$1://');
    try { return new URL(rest).href; } catch (e) { return null; }
  }

  function currentUrl() {
    return decode(location.href) || cfg.url;
  }

  function targetOrigin() {
    try { return new URL(currentUrl()).origin; } catch (e) { return SELF; }
  }

  function docBase() {
    var b = null;
    try { b = decode(nativeBaseURI ? nativeBaseURI.get.call(document) : document.baseURI); } catch (e) {}
    return b || currentUrl();
  }

  function isProxied(s) {
    return PROXIED_REL.test(s) || s.indexOf(SELF + PREFIX) === 0 && PROXIED_REL.test(s.slice(SELF.length));
  }

  /** Rewrite any URL so it goes through the proxy. */
  function rw(u, base) {
    if (u == null) return u;
    var s = typeof u === 'string' ? u : (u instanceof URL ? u.href : String(u));
    var t = s.trim();
    if (!t || t.charAt(0) === '#' || SKIP.test(t) || isProxied(t)) return s;
    var abs;
    try { abs = new URL(t, base || docBase()); } catch (e) { return s; }
    if (abs.origin === SELF) {
      // Absolute URL on our own origin but outside the prefix (e.g. built from location.origin).
      if (PROXIED_REL.test(abs.pathname) || abs.pathname.indexOf('/__proxy/') === 0) return abs.href;
      try { abs = new URL(abs.pathname + abs.search + abs.hash, targetOrigin()); } catch (e) { return s; }
    }
    if (!HTTP.test(abs.protocol)) return s;
    return PREFIX + abs.href;
  }

  function rwWs(u) {
    var s = u instanceof URL ? u.href : String(u);
    var abs;
    try { abs = new URL(s, docBase()); } catch (e) { return s; }
    if (abs.origin === SELF.replace(/^http/, 'ws') && PROXIED_REL.test(abs.pathname)) return abs.href;
    if (abs.protocol === 'http:') abs.protocol = 'ws:';
    if (abs.protocol === 'https:') abs.protocol = 'wss:';
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + PREFIX + abs.href;
  }

  function unrw(v) {
    if (typeof v !== 'string') return v;
    var d = decode(v);
    return d || v;
  }

  function rwSrcset(v) {
    if (v == null) return v;
    v = String(v);
    var out = [], i = 0, n = v.length;
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
      out.push(rw(url) + (desc ? ' ' + desc : ''));
    }
    return out.join(', ');
  }

  function rwCss(css) {
    if (!css) return css;
    return String(css).replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, function (m, q, u) {
      var r = rw(u.trim());
      return r === u ? m : 'url("' + r + '")';
    }).replace(/@import\s+(["'])([^"']+)\1/gi, function (m, q, u) { return '@import ' + q + rw(u) + q; });
  }

  var api = { rewrite: rw, decode: unrw, currentUrl: currentUrl };
  Object.defineProperty(window, '__proxy', { value: api });

  // --- virtual location ------------------------------------------------------------
  // Server-side rewriting renames `location` to `__pLocation`; this makes that name resolve to a
  // Location-like object describing the real site URL for windows and documents, and to the
  // ordinary `.location` property for every other object.

  var fakeLocations = new WeakMap();
  var LOC_PARTS = ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'origin'];

  function isWin(o) { try { return o != null && o.window === o && typeof o.document === 'object'; } catch (e) { return false; } }
  function isDoc(o) { try { return o != null && o.nodeType === 9 && 'defaultView' in o; } catch (e) { return false; } }

  function realUrlOf(win) {
    var href;
    try { href = win.location.href; } catch (e) { return null; }
    var d = decode(href);
    if (d) return d;
    if (win === window) return cfg.url;
    try { if (win.__proxy) return win.__proxy.currentUrl(); } catch (e) {}
    return href;
  }

  function fakeLocation(win) {
    var f = fakeLocations.get(win);
    if (f) return f;
    var real = win.location;
    var cur = function () { try { return new URL(realUrlOf(win)); } catch (e) { return new URL(real.href); } };
    f = {};
    LOC_PARTS.forEach(function (p) {
      Object.defineProperty(f, p, {
        enumerable: true, configurable: false,
        get: function () { return cur()[p]; },
        set: function (v) {
          if (p === 'origin') return;
          if (p === 'hash') { real.hash = v; return; }
          if (p === 'href') { real.href = rw(String(v)); return; }
          var u = cur(); u[p] = v; real.href = rw(u.href);
        },
      });
    });
    f.assign = function (u) { real.assign(rw(String(u))); };
    f.replace = function (u) { real.replace(rw(String(u))); };
    f.reload = function () { real.reload(); };
    f.toString = function () { return cur().href; };
    f.valueOf = function () { return f; };
    f.toJSON = function () { return cur().href; };
    try { Object.defineProperty(f, 'ancestorOrigins', { get: function () { return real.ancestorOrigins; } }); } catch (e) {}
    try { if (window.Location) Object.setPrototypeOf(f, Location.prototype); } catch (e) {}
    try { f[Symbol.toPrimitive] = function () { return cur().href; }; } catch (e) {}
    fakeLocations.set(win, f);
    return f;
  }

  var pLocationDescriptor = {
    configurable: true, enumerable: false,
    get: function () {
      if (isWin(this)) return fakeLocation(this);
      if (isDoc(this)) return this.defaultView ? fakeLocation(this.defaultView) : this.location;
      return this.location;
    },
    set: function (v) {
      if (isWin(this)) { fakeLocation(this).href = v; return; }
      if (isDoc(this) && this.defaultView) { fakeLocation(this.defaultView).href = v; return; }
      this.location = v;
    },
  };
  function installLocation(win) {
    try {
      var OP = win.Object.prototype;
      if (Object.prototype.hasOwnProperty.call(OP, '__pLocation') && Object.getOwnPropertyDescriptor(OP, '__pLocation').get === pLocationDescriptor.get) return;
      if (win !== window && win.__PROXY_RUNTIME__) return;
      Object.defineProperty(OP, '__pLocation', pLocationDescriptor);
    } catch (e) {}
  }
  installLocation(window);

  // Same-origin child windows created without a proxied URL (about:blank, srcdoc, window.open('')).
  ['HTMLIFrameElement', 'HTMLFrameElement', 'HTMLObjectElement'].forEach(function (name) {
    var C = window[name];
    if (!C) return;
    ['contentWindow', 'contentDocument'].forEach(function (prop) {
      var d = Object.getOwnPropertyDescriptor(C.prototype, prop);
      if (!d || !d.get || !d.configurable) return;
      Object.defineProperty(C.prototype, prop, {
        configurable: true, enumerable: d.enumerable,
        get: function () {
          var v = d.get.call(this);
          if (v) installLocation(prop === 'contentWindow' ? v : v.defaultView);
          return v;
        },
      });
    });
  });

  // --- network APIs --------------------------------------------------------------------

  var cookieCache = null, cookieAt = 0;
  function invalidateCookies() { cookieCache = null; }

  var nativeFetch = window.fetch;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) {
          var raw = reqUrlDesc ? reqUrlDesc.get.call(input) : input.url;
          var nu = rw(raw);
          if (nu !== raw && SELF + nu !== raw) input = new NativeRequest(nu, input);
        } else {
          input = rw(input);
        }
      } catch (e) {}
      var p = nativeFetch.call(this, input, init);
      p.then(invalidateCookies, function () {});
      return p;
    };
  }

  var NativeRequest = typeof Request !== 'undefined' ? Request : null;
  if (NativeRequest) {
    var PatchedRequest = function Request(input, init) {
      if (!(input instanceof NativeRequest)) input = rw(input);
      return new NativeRequest(input, init);
    };
    PatchedRequest.prototype = NativeRequest.prototype;
    try { Object.setPrototypeOf(PatchedRequest, NativeRequest); } catch (e) {}
    window.Request = PatchedRequest;
    patchGetter(NativeRequest.prototype, 'url');
  }
  if (typeof Response !== 'undefined') patchGetter(Response.prototype, 'url');

  var xhrOpen = XMLHttpRequest.prototype.open;
  var xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rw(url);
    this.addEventListener('loadend', invalidateCookies);
    return xhrOpen.apply(this, args);
  };
  patchGetter(XMLHttpRequest.prototype, 'responseURL');

  if (navigator.sendBeacon) {
    var beacon = navigator.sendBeacon;
    navigator.sendBeacon = function (url, data) { return beacon.call(navigator, rw(url), data); };
  }

  function wrapCtor(name, fn) {
    var Native = window[name];
    if (!Native) return;
    var Wrapped = function () {
      var args = Array.prototype.slice.call(arguments);
      if (args.length) args[0] = fn(args[0]);
      return Reflect.construct(Native, args, new.target || Wrapped);
    };
    Wrapped.prototype = Native.prototype;
    try { Object.setPrototypeOf(Wrapped, Native); } catch (e) {}
    try { Object.defineProperty(Wrapped, 'name', { value: name }); } catch (e) {}
    window[name] = Wrapped;
  }
  wrapCtor('WebSocket', rwWs);
  wrapCtor('EventSource', rw);
  wrapCtor('Worker', function (u) { return rw(u); });
  wrapCtor('SharedWorker', function (u) { return rw(u); });
  wrapCtor('Audio', function (u) { return u === undefined ? u : rw(u); });
  if (window.WebSocket) patchGetter(window.WebSocket.prototype, 'url', function (v) {
    var m = /^wss?:\/\/[^/]+\/p\/(.*)$/.exec(v);
    if (!m) return v;
    return m[1].replace(/^http/, 'ws');
  });

  // Service workers would intercept requests on the proxy origin without our rewriting.
  if (navigator.serviceWorker) {
    try {
      var swc = Object.getPrototypeOf(navigator.serviceWorker);
      swc.register = function () { return Promise.reject(new DOMException('Service workers are disabled by the proxy', 'SecurityError')); };
      navigator.serviceWorker.getRegistrations().then(function (regs) { regs.forEach(function (r) { r.unregister(); }); }, function () {});
    } catch (e) {}
  }

  // --- navigation ----------------------------------------------------------------------

  var nativeOpen = window.open;
  window.open = function (url) {
    var args = Array.prototype.slice.call(arguments);
    if (url !== undefined && url !== '') args[0] = rw(url);
    var w = nativeOpen.apply(window, args);
    if (w) installLocation(w);
    return w;
  };

  ['pushState', 'replaceState'].forEach(function (fn) {
    var orig = history[fn];
    history[fn] = function (state, title, url) {
      if (url !== undefined && url !== null) {
        arguments[2] = rw(url);
      }
      var r = orig.apply(history, arguments);
      updateToolbar();
      return r;
    };
  });

  // Catch location.href = "https://elsewhere" style navigations (Navigation API browsers).
  if (window.navigation && navigation.addEventListener) {
    navigation.addEventListener('navigate', function (e) {
      try {
        if (!e.cancelable || e.hashChange || e.downloadRequest || e.formData || e.navigationType === 'traverse' || e.navigationType === 'reload') return;
        var dest = new URL(e.destination.url);
        if (dest.origin === SELF && (PROXIED_REL.test(dest.pathname) || dest.pathname.indexOf('/__proxy/') === 0)) return;
        if (dest.protocol !== 'http:' && dest.protocol !== 'https:') return;
        var r = rw(dest.href);
        if (r === dest.href) return;
        e.preventDefault();
        if (e.navigationType === 'replace') location.replace(r); else location.assign(r);
      } catch (err) {}
    });
  }

  // --- DOM attributes & properties -----------------------------------------------------

  function patchGetter(proto, prop, map) {
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get || !d.configurable) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get: function () { var v = d.get.call(this); return map ? map(v) : unrw(v); },
      set: d.set,
    });
  }

  function patchProp(Ctor, prop, kind) {
    var proto = Ctor && Ctor.prototype;
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.configurable) return;
    var conv = kind === 'srcset' ? rwSrcset : rw;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable,
      get: function () { var v = d.get.call(this); return kind === 'srcset' ? v : unrw(v); },
      set: function (v) { d.set.call(this, conv(v)); },
    });
  }

  var W = window;
  [
    [W.HTMLAnchorElement, 'href'], [W.HTMLAreaElement, 'href'], [W.HTMLLinkElement, 'href'], [W.HTMLBaseElement, 'href'],
    [W.HTMLImageElement, 'src'], [W.HTMLImageElement, 'srcset', 'srcset'], [W.HTMLScriptElement, 'src'],
    [W.HTMLIFrameElement, 'src'], [W.HTMLFrameElement, 'src'], [W.HTMLSourceElement, 'src'], [W.HTMLSourceElement, 'srcset', 'srcset'],
    [W.HTMLMediaElement, 'src'], [W.HTMLVideoElement, 'poster'], [W.HTMLTrackElement, 'src'], [W.HTMLEmbedElement, 'src'],
    [W.HTMLObjectElement, 'data'], [W.HTMLFormElement, 'action'], [W.HTMLInputElement, 'src'], [W.HTMLInputElement, 'formAction'],
    [W.HTMLButtonElement, 'formAction'],
  ].forEach(function (x) { patchProp(x[0], x[1], x[2]); });

  // Hyperlink parts (a.hostname, a.pathname…) should describe the real URL.
  ['HTMLAnchorElement', 'HTMLAreaElement'].forEach(function (name) {
    var C = window[name];
    if (!C) return;
    var hrefDesc = Object.getOwnPropertyDescriptor(C.prototype, 'href');
    ['host', 'hostname', 'origin', 'pathname', 'port', 'protocol', 'search', 'hash'].forEach(function (part) {
      var d = Object.getOwnPropertyDescriptor(C.prototype, part);
      if (!d || !d.configurable) return;
      Object.defineProperty(C.prototype, part, {
        configurable: true, enumerable: d.enumerable,
        get: function () {
          var real = hrefDesc.get.call(this);
          try { return new URL(real)[part]; } catch (e) { return d.get.call(this); }
        },
        set: function (v) {
          if (!d.set) return;
          var real = hrefDesc.get.call(this);
          try { var u = new URL(real); u[part] = v; hrefDesc.set.call(this, u.href); } catch (e) { d.set.call(this, v); }
        },
      });
    });
  });

  var URL_ATTRS = { src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1, 'xlink:href': 1, lowsrc: 1 };
  var SRCSET_ATTRS = { srcset: 1, imagesrcset: 1 };

  function rewriteAttrValue(el, name, value) {
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n] || (n === 'data' && el instanceof HTMLObjectElement)) return rw(value);
    if (SRCSET_ATTRS[n]) return rwSrcset(value);
    if (n === 'style') return rwCss(value);
    return value;
  }

  var setAttr = Element.prototype.setAttribute;
  var getAttr = Element.prototype.getAttribute;
  var setAttrNS = Element.prototype.setAttributeNS;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase();
    if (n === 'integrity' || (n === 'referrerpolicy')) return;
    return setAttr.call(this, name, rewriteAttrValue(this, name, value));
  };
  Element.prototype.setAttributeNS = function (ns, name, value) {
    var local = String(name).replace(/^.*:/, '');
    if (local === 'href' || local === 'src') value = rw(value);
    return setAttrNS.call(this, ns, name, value);
  };
  Element.prototype.getAttribute = function (name) {
    var v = getAttr.call(this, name);
    if (v == null) return v;
    var n = String(name).toLowerCase();
    if (URL_ATTRS[n] || n === 'data') return unrw(v);
    return v;
  };

  // integrity would fail because the proxy rewrites content.
  if (W.HTMLScriptElement) {
    ['integrity'].forEach(function (p) {
      [W.HTMLScriptElement, W.HTMLLinkElement].forEach(function (C) {
        var d = C && Object.getOwnPropertyDescriptor(C.prototype, p);
        if (d && d.configurable) Object.defineProperty(C.prototype, p, { configurable: true, get: function () { return ''; }, set: function () {} });
      });
    });
  }

  // Inline style properties set from script.
  if (W.CSSStyleDeclaration) {
    var setProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (p, v, prio) {
      if (typeof v === 'string' && v.indexOf('url(') !== -1) v = rwCss(v);
      return setProperty.call(this, p, v, prio);
    };
    ['background', 'backgroundImage', 'borderImage', 'borderImageSource', 'listStyle', 'listStyleImage', 'content', 'cursor', 'mask', 'maskImage'].forEach(function (p) {
      var d = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, p);
      if (!d || !d.set || !d.configurable) return;
      Object.defineProperty(CSSStyleDeclaration.prototype, p, {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) { d.set.call(this, typeof v === 'string' && v.indexOf('url(') !== -1 ? rwCss(v) : v); },
      });
    });
  }

  // Catch-all: elements inserted via innerHTML / templates / parsers we did not see.
  var ATTR_SELECTOR = '[src],[href],[action],[formaction],[poster],[srcset],[imagesrcset],[background],[style*="url("],object[data],[integrity]';
  function fixElement(el) {
    if (el.nodeType !== 1) return;
    if (el.hasAttribute('integrity')) el.removeAttribute('integrity');
    for (var i = 0; i < el.attributes.length; i++) {
      var a = el.attributes[i];
      var n = a.name.toLowerCase();
      var v = a.value;
      var nv = v;
      if (URL_ATTRS[n] || (n === 'data' && el.tagName === 'OBJECT')) {
        if (v && !isProxied(v) && !(n === 'href' && v.charAt(0) === '#')) nv = rw(v);
      } else if (SRCSET_ATTRS[n]) {
        if (v && v.split(',').some(function (c) { var t = c.trim(); return t && !isProxied(t) && !SKIP.test(t); })) nv = rwSrcset(v);
      } else if (n === 'style' && v.indexOf('url(') !== -1) {
        nv = rwCss(v);
      }
      if (nv !== v) setAttr.call(el, a.name, nv);
    }
    if (el.tagName === 'STYLE' && el.textContent.indexOf('url(') !== -1 && !el.__proxied) {
      el.__proxied = true;
      var css = rwCss(el.textContent);
      if (css !== el.textContent) el.textContent = css;
    }
  }
  function fixTree(root) {
    if (root.nodeType !== 1) return;
    fixElement(root);
    if (root.querySelectorAll) {
      var list = root.querySelectorAll(ATTR_SELECTOR + ',style');
      for (var i = 0; i < list.length; i++) fixElement(list[i]);
    }
  }
  if (W.MutationObserver) {
    var mo = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === 'childList') {
          for (var j = 0; j < r.addedNodes.length; j++) fixTree(r.addedNodes[j]);
        } else if (r.type === 'attributes') {
          fixElement(r.target);
        }
      }
    });
    mo.observe(document.documentElement || document, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'href', 'action', 'formaction', 'poster', 'srcset', 'imagesrcset', 'data', 'style', 'background', 'integrity'],
    });
  }

  // Forms submitted with a target URL set at the last moment.
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (f && f.tagName === 'FORM') {
      var a = getAttr.call(f, 'action');
      if (a && !isProxied(a)) setAttr.call(f, 'action', rw(a));
    }
  }, true);

  // --- document properties -------------------------------------------------------------

  var docCookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (docCookie && docCookie.configurable) {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true, enumerable: true,
      get: function () {
        var now = Date.now();
        if (cookieCache !== null && now - cookieAt < 2000) return cookieCache;
        try {
          var x = new XMLHttpRequest();
          xhrOpen.call(x, 'GET', '/__proxy/cookie?url=' + encodeURIComponent(currentUrl()), false);
          xhrSend.call(x);
          cookieCache = x.status === 200 ? x.responseText : '';
        } catch (e) { cookieCache = cookieCache || ''; }
        cookieAt = now;
        return cookieCache;
      },
      set: function (v) {
        try {
          var x = new XMLHttpRequest();
          xhrOpen.call(x, 'POST', '/__proxy/cookie?url=' + encodeURIComponent(currentUrl()), false);
          xhrSend.call(x, String(v));
          if (x.status === 200) { cookieCache = x.responseText; cookieAt = Date.now(); }
          else cookieCache = null;
        } catch (e) { cookieCache = null; }
      },
    });
  }

  function defineGetter(obj, prop, get) {
    try { Object.defineProperty(obj, prop, { configurable: true, get: get }); } catch (e) {}
  }
  var refDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'referrer');
  if (refDesc) defineGetter(Document.prototype, 'referrer', function () { return unrw(refDesc.get.call(this)); });
  ['URL', 'documentURI'].forEach(function (p) {
    var d = Object.getOwnPropertyDescriptor(Document.prototype, p);
    if (d) defineGetter(Document.prototype, p, function () { return unrw(d.get.call(this)); });
  });
  var baseDesc = Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI');
  if (baseDesc) defineGetter(Node.prototype, 'baseURI', function () { return unrw(baseDesc.get.call(this)); });
  try {
    Object.defineProperty(Document.prototype, 'domain', {
      configurable: true,
      get: function () { try { return new URL(currentUrl()).hostname; } catch (e) { return location.hostname; } },
      set: function () {},
    });
  } catch (e) {}

  // Same-origin checks against the real site origin when sending/receiving messages.
  var nativePostMessage = window.postMessage;
  window.postMessage = function (msg, targetOrigin, transfer) {
    var args = Array.prototype.slice.call(arguments);
    if (typeof targetOrigin === 'string' && targetOrigin !== '*' && targetOrigin !== '/') args[1] = '*';
    else if (targetOrigin && typeof targetOrigin === 'object' && targetOrigin.targetOrigin && targetOrigin.targetOrigin !== '/') {
      args[1] = Object.assign({}, targetOrigin, { targetOrigin: '*' });
    }
    return nativePostMessage.apply(this, args);
  };
  if (W.MessageEvent) {
    var originDesc = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'origin');
    if (originDesc && originDesc.configurable) {
      Object.defineProperty(MessageEvent.prototype, 'origin', {
        configurable: true, enumerable: true,
        get: function () {
          var o = originDesc.get.call(this);
          if (o !== SELF) return o;
          try {
            var src = this.source;
            if (src && src.__proxy) return new URL(src.__proxy.currentUrl()).origin;
          } catch (e) {}
          return targetOrigin();
        },
      });
    }
  }

  // --- storage isolation: every proxied site shares this origin, so namespace keys -------

  function isolateStorage(name) {
    var real;
    try { real = window[name]; } catch (e) { return; }
    if (!real) return;
    var ns = '\u0001' + targetOrigin() + '\u0001';
    function keys() {
      var out = [];
      for (var i = 0; i < real.length; i++) {
        var k = real.key(i);
        if (k && k.indexOf(ns) === 0) out.push(k.slice(ns.length));
      }
      return out;
    }
    var api = {
      getItem: function (k) { return real.getItem(ns + k); },
      setItem: function (k, v) { real.setItem(ns + k, String(v)); },
      removeItem: function (k) { real.removeItem(ns + k); },
      clear: function () { keys().forEach(function (k) { real.removeItem(ns + k); }); },
      key: function (i) { var k = keys(); return i < k.length ? k[i] : null; },
    };
    var proxyObj = new Proxy(api, {
      get: function (t, p) {
        if (p === 'length') return keys().length;
        if (typeof p === 'symbol') return p === Symbol.toStringTag ? 'Storage' : undefined;
        if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
        var v = real.getItem(ns + p);
        return v === null ? undefined : v;
      },
      set: function (t, p, v) { real.setItem(ns + String(p), String(v)); return true; },
      has: function (t, p) { return Object.prototype.hasOwnProperty.call(api, p) || p === 'length' || real.getItem(ns + String(p)) !== null; },
      deleteProperty: function (t, p) { real.removeItem(ns + String(p)); return true; },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) {
        var v = real.getItem(ns + String(p));
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      },
      getPrototypeOf: function () { return Storage.prototype; },
    });
    try { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: function () { return proxyObj; } }); } catch (e) {}
  }
  isolateStorage('localStorage');
  isolateStorage('sessionStorage');

  // --- floating toolbar (top window only) ----------------------------------------------

  var toolbarInput = null;
  function updateToolbar() {
    if (toolbarInput && document.activeElement !== toolbarHost) toolbarInput.value = currentUrl();
  }
  var toolbarHost = null;

  function buildToolbar() {
    if (window.top !== window || cfg.toolbar === false || !document.body) return;
    var hidden = false;
    try { hidden = realSessionStorage.getItem('__proxy_toolbar_hidden') === '1'; } catch (e) {}
    toolbarHost = document.createElement('proxy-toolbar');
    toolbarHost.style.cssText = 'all:initial;position:fixed;z-index:2147483647;right:12px;bottom:12px;';
    var root = toolbarHost.attachShadow ? toolbarHost.attachShadow({ mode: 'closed' }) : toolbarHost;
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.wrap{font:13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#e8eaf0;background:rgba(23,26,33,.94);border:1px solid #2a2f3a;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);display:flex;align-items:center;gap:4px;padding:4px;max-width:calc(100vw - 24px)}' +
      '.wrap.min .full{display:none}' +
      'button{all:unset;cursor:pointer;width:28px;height:28px;display:grid;place-items:center;border-radius:8px;color:#e8eaf0}' +
      'button:hover{background:#2a2f3a}' +
      'button:focus-visible{outline:2px solid #748ffc}' +
      'input{all:unset;width:min(52vw,420px);padding:5px 8px;border-radius:8px;background:#0f1115;color:#e8eaf0;border:1px solid #2a2f3a;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;box-sizing:border-box}' +
      'input:focus{border-color:#748ffc}' +
      'svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
      '</style>' +
      '<div class="wrap' + (hidden ? ' min' : '') + '">' +
      '<button class="toggle" title="Proxy controls"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 4 6 4 9s-1 6-4 9c-3-3-4-6-4-9s1-6 4-9z"/></svg></button>' +
      '<span class="full" style="display:contents">' +
      '<button class="back" title="Back"><svg viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg></button>' +
      '<button class="fwd" title="Forward"><svg viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg></button>' +
      '<button class="reload" title="Reload"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/></svg></button>' +
      '<input class="addr" spellcheck="false" aria-label="Address">' +
      '<button class="home" title="Proxy home"><svg viewBox="0 0 24 24"><path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg></button>' +
      '</span></div>';
    var wrap = root.querySelector('.wrap');
    toolbarInput = root.querySelector('.addr');
    toolbarInput.value = currentUrl();
    root.querySelector('.toggle').onclick = function () {
      wrap.classList.toggle('min');
      try { realSessionStorage.setItem('__proxy_toolbar_hidden', wrap.classList.contains('min') ? '1' : '0'); } catch (e) {}
    };
    root.querySelector('.back').onclick = function () { history.back(); };
    root.querySelector('.fwd').onclick = function () { history.forward(); };
    root.querySelector('.reload').onclick = function () { location.reload(); };
    root.querySelector('.home').onclick = function () { location.href = '/__proxy/home'; };
    toolbarInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') location.href = '/__proxy/go?url=' + encodeURIComponent(toolbarInput.value);
      if (e.key === 'Escape') { toolbarInput.value = currentUrl(); toolbarInput.blur(); }
    });
    ['keyup', 'keypress', 'input'].forEach(function (t) { toolbarInput.addEventListener(t, function (e) { e.stopPropagation(); }); });
    toolbarInput.addEventListener('focus', function () { toolbarInput.select(); });
    document.documentElement.appendChild(toolbarHost);
  }
  window.addEventListener('popstate', updateToolbar);
  window.addEventListener('hashchange', updateToolbar);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildToolbar);
  else buildToolbar();
})();
