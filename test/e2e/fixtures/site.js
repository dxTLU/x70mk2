'use strict';

/*
 * Fixture site for the browser runtime tests. The same handler is served on two ports so pages
 * can talk to a second real origin. Every page reports what it saw through window.__done /
 * window.__results; the test drives navigation and reads those back.
 */

const http = require('http');
const crypto = require('crypto');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

// Shared by every page: report results and capture errors thrown by page code.
const HARNESS = `<script>
window.__errors = [];
window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
function done(r) { window.__results = r; window.__done = true; }
function fail(e) { done({ error: String(e && e.stack || e) }); }
</script>`;

function page(title, body, { head = '', harness = true } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>` +
    `<link rel="icon" href="/favicon.ico">${harness ? HARNESS : ''}${head}</head><body>${body}</body></html>`;
}

const pages = {
  '/plain': () => page('Plain', '<h1 id="h">Plain page</h1><p id="q"></p><script>document.getElementById("q").textContent = location.search; done({});</script>'),

  // A History-API router: everything under /spa/ serves the same shell.
  '/spa/': () => page('SPA', `
<nav><a id="to-about" data-link href="/spa/about?tab=2#sec">About</a> <a id="to-user" data-link href="/spa/users/42">User</a></nav>
<pre id="view"></pre>
<script>
function render() {
  document.getElementById('view').textContent = JSON.stringify({
    path: location.pathname, search: location.search, hash: location.hash, href: location.href, state: history.state,
  });
}
document.addEventListener('click', function (e) {
  var a = e.target.closest('a[data-link]');
  if (!a) return;
  e.preventDefault();
  var url = new URL(a.href);
  if (url.origin !== location.origin) throw new Error('origin mismatch ' + url.origin + ' vs ' + location.origin);
  history.pushState({ page: a.id }, '', url.pathname + url.search + url.hash);
  render();
});
window.addEventListener('popstate', render);
window.replaceRoute = function () { history.replaceState({ replaced: true }, '', location.pathname + '?replaced=1'); render(); };
window.pushUrlObject = function () { history.pushState({ obj: true }, '', new URL('/spa/obj?o=1', location.href)); render(); };
render();
</script>`),

  '/dom': (c) => page('DOM', `
<div id="c"></div>
<template id="tpl"><img class="t" src="/img/tpl.png"><a class="t" href="/target/tpl">t</a></template>
<script>
var c = document.getElementById('c');
c.innerHTML = '<img id="i1" src="/img/inner.png"><a id="a1" href="/target/inner">x</a>' +
  '<script src="/js/never.js"><\\/script><link id="l1" rel="stylesheet" href="/css/inner.css">' +
  '<a id="a2" href="${c.B}/target/other">o</a>';
c.insertAdjacentHTML('beforeend', '<iframe id="f1" src="/frame/adjacent"></iframe><img id="i2" srcset="/img/adj1.png 1x, /img/adj2.png 2x">');
var img = document.createElement('img'); img.id = 'i3'; img.setAttribute('src', '/img/setattr.png'); c.appendChild(img);
var img2 = new Image(); img2.id = 'i4'; img2.src = '/img/prop.png'; c.appendChild(img2);
var s = document.createElement('script'); s.src = '/js/dyn.js'; document.head.appendChild(s);
var f2 = document.createElement('iframe'); f2.id = 'f2'; f2.src = 'frame/prop'; c.appendChild(f2);
var tpl = document.getElementById('tpl');
c.appendChild(tpl.content.cloneNode(true));
c.appendChild(document.importNode(tpl.content, true));
var t2 = document.createElement('template'); t2.innerHTML = '<img id="i5" src="/img/tpl2.png">'; c.appendChild(t2.content.cloneNode(true));
var i6 = document.createElement('img'); i6.id = 'i6'; i6.srcset = '/img/srcset1.png 1x, /img/srcset2.png 2x'; c.appendChild(i6);
var l2 = document.createElement('link'); l2.rel = 'stylesheet'; l2.href = '/css/prop.css'; document.head.appendChild(l2);
var o = document.createElement('div'); c.appendChild(o); o.outerHTML = '<img id="i7" src="/img/outer.png">';
var frag = document.createRange().createContextualFragment('<img id="i8" src="/img/range.png">'); c.appendChild(frag);
var a3 = document.createElement('a'); a3.id = 'a3'; a3.href = '/target/prop'; c.appendChild(a3);
var parsed = new DOMParser().parseFromString('<link id="l3" rel="stylesheet" href="/css/parsed.css"><img id="i9" src="/img/parsed.png"><img id="i10" src="/img/adopted.png">', 'text/html');
document.head.appendChild(parsed.getElementById('l3'));
c.appendChild(document.importNode(parsed.getElementById('i9'), true));
c.appendChild(document.adoptNode(parsed.getElementById('i10')));
var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
var im = document.createElementNS('http://www.w3.org/2000/svg', 'image');
im.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '/img/svg.png'); svg.appendChild(im); c.appendChild(svg);
window.addEventListener('load', function () {
  var $ = function (id) { return document.getElementById(id); };
  var imgs = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6', 'i7', 'i8', 'i9', 'i10'];
  done({
    raw: {
      i1: $('i1').attributes.src.value, a1: $('a1').attributes.href.value, a2: $('a2').attributes.href.value,
      i3: $('i3').attributes.src.value, i4: $('i4').attributes.src.value, i6: $('i6').attributes.srcset.value,
      f1: $('f1').attributes.src.value, f2: $('f2').attributes.src.value, l1: $('l1').attributes.href.value,
      tpl: Array.prototype.map.call(document.querySelectorAll('#c .t'), function (e) { return e.attributes.src ? e.attributes.src.value : e.attributes.href.value; }),
      svg: im.getAttributeNodeNS('http://www.w3.org/1999/xlink', 'href').value,
    },
    attr: { i1: $('i1').getAttribute('src'), a1: $('a1').getAttribute('href'), a2: $('a2').getAttribute('href'), i3: $('i3').getAttribute('src'), i4: $('i4').getAttribute('src'), i6: $('i6').getAttribute('srcset'), a3: $('a3').getAttribute('href') },
    props: { i1: $('i1').src, a1: $('a1').href, a3: $('a3').href, i6: $('i6').srcset, f2: $('f2').src, script: s.src },
    loaded: imgs.filter(function (id) { return !($(id).complete && $(id).naturalWidth > 0); }),
    dyn: window.dynLoaded === true,
    never: window.neverLoaded === true,
    frames: [$('f1').contentDocument.title, $('f2').contentDocument.title],
    cssColor: getComputedStyle(c).color, cssPropColor: getComputedStyle(c).outlineColor, cssParsed: getComputedStyle(c).borderTopColor,
  });
});
</script>`),

  '/net/': (c) => page('Net', `<script>
(async function () {
  var r = {};
  async function j(p) { var res = await p; return { url: res.url, body: await res.json() }; }
  r.rootRel = await j(fetch('/api/echo?t=root'));
  r.rel = await j(fetch('api/echo?t=rel'));
  r.abs = await j(fetch('${c.me}/api/echo?t=abs'));
  r.urlObj = await j(fetch(new URL('/api/echo?t=urlobj', location.origin)));
  r.originStr = await j(fetch(location.origin + '/api/echo?t=originstr'));
  var req = new Request('/api/echo?t=req', { method: 'POST', body: 'hello-body', headers: { 'x-test': '1' } });
  r.reqUrl = req.url;
  r.reqInstance = req instanceof Request;
  r.req = await j(fetch(req));
  r.post = await j(fetch('/api/echo?t=post', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } }));
  r.cross = await j(fetch('${c.B}/api/echo?t=cross'));
  r.xhr = await new Promise(function (resolve) {
    var x = new XMLHttpRequest();
    x.open('GET', '/api/echo?t=xhr');
    x.onload = function () { resolve({ url: x.responseURL, body: JSON.parse(x.responseText) }); };
    x.send();
  });
  var xs = new XMLHttpRequest();
  xs.open('GET', 'api/echo?t=sync', false);
  xs.send();
  r.sync = { url: xs.responseURL, body: JSON.parse(xs.responseText) };
  r.beacon = navigator.sendBeacon('/api/echo?t=beacon', 'b');
  r.fetchNative = Function.prototype.toString.call(fetch).indexOf('[native code]') >= 0;
  r.sw = await navigator.serviceWorker.register('/sw.js').then(function () { return 'registered'; }, function (e) { return e.name; });
  done(r);
})().catch(fail);
</script>`),

  '/stream': () => page('Stream', `<script>
var r = {};
var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?x=1');
r.wsUrl = ws.url;
ws.onopen = function () { ws.send('hi'); };
ws.onmessage = function (e) {
  r.wsMsg = e.data; r.wsOrigin = e.origin; ws.close();
  var rel = new WebSocket('/ws?rel=1');
  r.relUrl = rel.url;
  rel.onopen = function () { rel.send('rel'); };
  rel.onmessage = function (e2) { r.relMsg = e2.data; rel.close(); sse(); };
  rel.onerror = function () { r.relMsg = 'error'; sse(); };
};
ws.onerror = function () { fail('websocket error'); };
function sse() {
  var es = new EventSource('/sse');
  r.esUrl = es.url;
  var msgs = [];
  es.onmessage = function (e) {
    msgs.push(e.data); r.esOrigin = e.origin;
    if (msgs.length === 2) { es.close(); r.es = msgs; done(r); }
  };
  es.onerror = function () { if (msgs.length < 2) fail('eventsource error'); };
}
</script>`),

  '/workers/page': (c) => page('Workers', `<script>
var r = {};
var pending = 3;
function finish(k, v) { r[k] = v; if (--pending === 0) done(r); }
var w = new Worker('worker.js', { name: 'classic' });
w.onmessage = function (e) { finish('classic', e.data); };
w.onerror = function (e) { finish('classic', { error: e.message }); };
w.postMessage('go');
var mw = new Worker('/workers/module-worker.mjs', { type: 'module' });
mw.onmessage = function (e) { finish('module', e.data); };
mw.onerror = function (e) { finish('module', { error: e.message }); };
var code = 'self.onmessage = async function () { var res = await fetch("${c.me}/api/echo?t=blob"); ' +
  'postMessage({ path: (await res.json()).path, origin: self.origin }); };';
var url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
var bw = new Worker(url);
URL.revokeObjectURL(url);
bw.onmessage = function (e) { finish('blob', e.data); };
bw.onerror = function (e) { finish('blob', { error: e.message }); };
bw.postMessage('go');
r.isWorker = w instanceof Worker;
</script>`),

  '/forms': (c) => page('Forms', `
<form id="get" action="/form-result" method="get"><input name="q" value="hello world"><button id="get-btn">Go</button></form>
<form id="post" action="/form-result" method="post"><input name="a" value="1"><button id="post-btn">Post</button>
<button id="fa-btn" formaction="/form-result?via=formaction">FA</button></form>
<script>
window.jsSubmit = function () {
  var f = document.createElement('form'); f.method = 'post'; f.action = '/form-result?via=js';
  var i = document.createElement('input'); i.name = 'z'; i.value = '9'; f.appendChild(i);
  document.body.appendChild(f); f.submit();
};
window.jsRequestSubmit = function () {
  var f = document.createElement('form'); f.setAttribute('method', 'get'); f.setAttribute('action', '${c.B}/form-result');
  f.innerHTML = '<input name="k" value="v">'; document.body.appendChild(f); f.requestSubmit();
};
window.jsFormAction = function () {
  var f = document.getElementById('post');
  var b = document.createElement('button'); b.formAction = '/form-result?via=jsformaction'; f.appendChild(b); b.click();
};
done({ action: document.getElementById('get').action });
</script>`),

  '/popup-opener': (c) => page('Opener', `
<a id="named" href="/popup?n=2" target="pop">named</a>
<script>
window.msgs = [];
window.addEventListener('message', function (e) { window.msgs.push({ data: e.data, origin: e.origin }); });
window.openPop = function () { window.popRef = window.open('/popup?n=1', 'pop'); return !!window.popRef; };
window.reuse = function () { return window.open('', 'pop') === window.popRef; };
window.popInfo = function () { return { href: popRef.location.href, path: popRef.location.pathname }; };
window.blankPopup = function () {
  var w = window.open('', 'blankpop');
  w.document.write('<p>blank</p><script>opener.blankInfo = { href: location.href, openerHref: opener.location.href, origin: location.origin };<\\/script>');
  w.document.close();
  return window.blankInfo;
};
done({});
</script>`),

  '/popup': (c) => page('Popup', `<script>
opener.postMessage({ href: location.href, openerHref: opener.location.href, name: window.name }, '${c.me}');
done({ href: location.href });
</script>`),

  '/loc': () => page('Loc', `<pre id="info"></pre>
<script>
document.getElementById('info').textContent = JSON.stringify({
  href: location.href, path: location.pathname, search: location.search, hash: location.hash, origin: location.origin,
  host: location.host, docLoc: document.location.href, winLoc: window.location.pathname, str: String(location),
  tmpl: \`\${location}\`, isLoc: location instanceof Location, same: window.location === document.location,
});
window.nav = {
  href: function (u) { location.href = u; }, assign: function (u) { location.assign(u); },
  replace: function (u) { location.replace(u); }, hash: function (h) { location.hash = h; },
  doc: function (u) { document.location = u; }, bare: function (u) { location = u; },
  search: function (s) { location.search = s; }, path: function (p) { location.pathname = p; },
  win: function (u) { window.location = u; },
};
window.addEventListener('hashchange', function () { window.hashChanged = location.hash; });
done({});
</script>`),

  '/cookies/': () => page('Cookies', '<p>cookies</p><script>done({ cookie: document.cookie });</script>'),

  '/storage': (c) => page('Storage', `<p>storage</p>
<script>
window.storageEvents = [];
window.addEventListener('storage', function (e) { window.storageEvents.push({ key: e.key, newValue: e.newValue, url: e.url, area: e.storageArea === localStorage }); });
window.bcGot = [];
window.bc = new BroadcastChannel('chan');
window.bc.onmessage = function (e) { window.bcGot.push(e.data); };
done({ origin: location.origin });
</script>`),

  '/storage-host': (c) => page('Storage host', `
<iframe id="same" src="/storage"></iframe><iframe id="other" src="${c.B}/storage"></iframe>
<script>
window.storageEvents = [];
window.addEventListener('storage', function (e) { window.storageEvents.push({ key: e.key, newValue: e.newValue }); });
var n = 0;
Array.prototype.forEach.call(document.querySelectorAll('iframe'), function (f) { f.onload = function () { if (++n === 2) done({}); }; });
</script>`),

  '/blank': (c) => page('Blank', `<div id="c"></div>
<script>
localStorage.setItem('k', 'parent-value');
var f = document.createElement('iframe'); document.body.appendChild(f);
var d = f.contentDocument;
d.open();
d.write('<!doctype html><p id="p">x</p><img id="ci" src="/img/blank-child.png"><script>parent.childInfo = { href: location.href, parentHref: parent.location.href, ' +
  'topPath: top.location.pathname, origin: location.origin, docUrl: document.URL, ls: localStorage.getItem("k"), base: document.baseURI, ' +
  'cookie: typeof document.cookie };' +
  'fetch("/api/echo?t=blank").then(function (r) { return r.json(); }).then(function (j) { parent.childFetch = j.path; });<\\/script>');
d.close();
document.getElementById('c').innerHTML = '<iframe name="viaframes"></iframe>';
frames[1].document.write('<script>parent.framesInfo = { parentPath: parent.location.pathname, ls: localStorage.getItem("k") };<\\/script>');
frames[1].document.close();
var f3 = document.createElement('iframe');
f3.srcdoc = '<p>srcdoc</p><img id="si" src="/img/srcdoc.png"><script>parent.srcdocInfo = { href: location.href, parentPath: parent.location.pathname, ' +
  'runtime: !!window.__PROXY_RUNTIME__, base: document.baseURI };<\\/script>';
document.body.appendChild(f3);
var f4 = document.createElement('iframe');
f4.src = '${c.B}/frame-info';
document.body.appendChild(f4);
window.earlyHref = f4.contentWindow.location.href;
window.addEventListener('message', function (e) { if (e.data && e.data.frameInfo) window.frameInfo = { data: e.data, origin: e.origin }; });
window.addEventListener('load', function () {
  var ci = f.contentDocument.getElementById('ci');
  setTimeout(function () {
    done({ childImg: ci.complete && ci.naturalWidth > 0, childImgRaw: ci.attributes.src.value, early: window.earlyHref });
  }, 100);
});
</script>`),

  '/frame-info': (c) => page('Frame info', `<div id="d"></div><script>
localStorage.setItem('fi', 'B');
document.getElementById('d').innerHTML = '<img id="fimg" src="/img/frame-info.png">';
var img = document.getElementById('fimg');
function report() {
  parent.postMessage({ frameInfo: true, href: location.href, origin: location.origin, ls: localStorage.getItem('k'), fi: localStorage.getItem('fi'),
    imgRaw: img.attributes.src.value, imgOk: img.complete && img.naturalWidth > 0, cfgUrl: window.__PROXY_CFG && window.__PROXY_CFG.url }, '*');
}
if (img.complete) report(); else img.onload = img.onerror = report;
</script>`),

  '/pm-parent': (c) => page('PM parent', `<iframe id="child" src="${c.B}/pm-child"></iframe>
<script>
window.got = [];
window.addEventListener('message', function (e) {
  if (e.origin !== '${c.B}') { window.got.push({ rejected: e.origin, data: e.data }); return; }
  window.got.push({ data: e.data, origin: e.origin, sourceOk: e.source === document.getElementById('child').contentWindow });
  if (e.data === 'to-parent-explicit') e.source.postMessage({ reply: e.data }, e.origin);
});
window.sendWrong = function () { document.getElementById('child').contentWindow.postMessage('wrong-origin', '${c.A}'); };
window.sendRight = function () { document.getElementById('child').contentWindow.postMessage('right-origin', '${c.B}'); };
done({});
</script>`),

  '/pm-child': (c) => page('PM child', `<script>
window.got = [];
window.addEventListener('message', function (e) { window.got.push({ data: e.data, origin: e.origin }); });
parent.postMessage('to-parent-wrong', 'http://evil.example');
parent.postMessage('to-parent-explicit', '${c.A}');
parent.postMessage('to-parent-star', '*');
parent.postMessage('to-parent-opts', { targetOrigin: '${c.A}' });
done({});
</script>`),

  '/props-from': () => page('From', '<a id="go" href="/props?x=1#frag">go</a><script>done({});</script>'),

  '/props': () => page('Props', `<a id="rel" href="sub/page?x=2#y">rel</a>
<script>
var a = document.createElement('a');
a.href = 'https://user:pw@other.example:8443/p/a/t/h?query=1#hash';
var b = document.getElementById('rel');
var info = {
  referrer: document.referrer, URL: document.URL, documentURI: document.documentURI, domain: document.domain,
  baseURI: document.baseURI, winOrigin: window.origin,
  a: { href: a.href, protocol: a.protocol, host: a.host, hostname: a.hostname, port: a.port, pathname: a.pathname,
    search: a.search, hash: a.hash, origin: a.origin, username: a.username, str: String(a) },
  rel: { href: b.href, hostname: b.hostname, pathname: b.pathname, origin: b.origin, attr: b.getAttribute('href') },
};
b.pathname = '/changed';
info.changed = b.href;
info.changedRaw = b.attributes.href.value;
document.domain = 'example.com';
info.domainAfterSet = document.domain;
done(info);
</script>`),

  '/css': (c) => page('CSS', `
<style>#d0{color:rgb(1,2,3)}</style>
<div id="d1">1</div><div id="d2">2</div><div id="d3">3</div><div id="d4">4</div><div id="d5">5</div>
<div id="d6">6</div><div id="d7">7</div><div id="d8">8</div><div id="d9">9</div>
<script>
var $ = function (id) { return document.getElementById(id); };
$('d1').style.backgroundImage = 'url(/img/css1.png)';
$('d2').style.cssText = 'background: url("/img/css2.png") no-repeat';
$('d3').style.setProperty('background-image', "url('/img/css3.png')");
$('d4').setAttribute('style', 'background-image:url(/img/css4.png)');
$('d5').style['background-image'] = 'url(/img/css5.png)';
var st = document.createElement('style'); st.textContent = '#d6{background-image:url(/img/css6.png)}'; document.head.appendChild(st);
var sheet = new CSSStyleSheet(); sheet.replaceSync('#d7{background-image:url(/img/css7.png)}'); document.adoptedStyleSheets = [sheet];
document.styleSheets[0].insertRule('#d8{background-image:url(/img/css8.png)}');
$('d9').style.background = 'url(' + location.origin + '/img/css9.png)';
window.addEventListener('load', function () {
  var out = {};
  for (var i = 1; i <= 9; i++) out['d' + i] = getComputedStyle($('d' + i)).backgroundImage;
  out.d4attr = $('d4').getAttribute('style');
  done(out);
});
</script>`),

  // Patched APIs must keep behaving like the originals.
  '/fidelity': (c) => page('Fidelity', `<a id="srv" href="/fid/target?x=1">srv</a><a id="ext" href="${c.B}/ext">ext</a>
<script>
var r = {};
function attempt(name, fn) { try { r[name] = fn(); } catch (e) { r[name] = 'threw ' + e.name + ': ' + e.message; } }
attempt('fnSubclass', function () { class F extends Function {} var f = new F('return 7'); return [f(), f instanceof F, f instanceof Function]; });
attempt('fnCtor', function () { return [(function () {}).constructor === Function, Function.name, Function.length, typeof Function.prototype.call]; });
attempt('reqSubclass', function () { class R extends Request {} var q = new R('/fid/x'); return [q instanceof R, q instanceof Request, q.url]; });
attempt('reqCtor', function () { var q = new Request('/fid/y'); return [q.constructor === Request, Request.name]; });
attempt('wsStatic', function () { return [WebSocket.OPEN, WebSocket.CLOSED, typeof WebSocket.prototype.send]; });
attempt('nativeToString', function () { return [Element.prototype.setAttribute, window.fetch, XMLHttpRequest.prototype.open, Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get, history.pushState]
  .map(function (f) { return /\[native code\]/.test(Function.prototype.toString.call(f)); }); });
attempt('names', function () { return [fetch.name, fetch.length, Element.prototype.setAttribute.name, Element.prototype.setAttribute.length]; });
attempt('locKeys', function () { return ['href', 'origin', 'pathname', 'assign', 'replace', 'reload'].every(function (k) { return k in location; }); });
attempt('locJson', function () { return JSON.parse(JSON.stringify(location)).pathname; });
attempt('locInstance', function () { return [location instanceof Location, typeof location, location == location.href, location + '']; });
attempt('withDoc', function () { with (document) { return location.pathname; } });
attempt('withObj', function () { with ({}) { return location.pathname; } });
attempt('withOwn', function () { with ({ location: { pathname: 'own' } }) { return location.pathname; } });
attempt('withArr', function () { with ([]) { return location.pathname; } });
attempt('plainObj', function () { var o = { location: 'x' }; var o2 = { location: location }; return [o.location, o2.location.pathname, ({}).location]; });
attempt('destructure', function () { var { location: l } = window; var { pathname } = location; return [l.pathname, pathname]; });
attempt('srvAttr', function () { var a = document.getElementById('srv'); return [a.getAttribute('href'), a.href, a.pathname + a.search]; });
attempt('extAttr', function () { return document.getElementById('ext').getAttribute('href'); });
attempt('emptyA', function () { var a = document.createElement('a'); return [a.href, a.hostname, a.getAttribute('href')]; });
attempt('storageProto', function () { Storage.prototype.setItem.call(sessionStorage, 'p', '1'); return [sessionStorage.getItem('p'), Storage.prototype.key.call(sessionStorage, 0), sessionStorage.length]; });
attempt('urlFromLocation', function () { return [new URL('rel', location).href, new URL('/abs', location.href).href]; });
attempt('docLocSame', function () { return document.location === location && window.location === location; });
attempt('topSelf', function () { return [top.location === self.location, top === window]; });
attempt('origin', function () { return [window.origin, self.origin, location.origin]; });
attempt('setAttrReturn', function () { var d = document.createElement('div'); return [d.setAttribute('data-x', '1'), d.getAttribute('data-x'), d.getAttribute('missing')]; });
attempt('innerHTMLText', function () { var d = document.createElement('div'); d.innerHTML = 'plain & <b>bold</b>'; return d.innerHTML; });
attempt('textContentScript', function () { var s = document.createElement('script'); s.type = 'application/json'; s.textContent = '{"location":1}'; return s.textContent; });
done(r);
</script>`),

  '/bust-parent': () => page('Bust parent', '<iframe src="/buster"></iframe>'),
  '/buster': () => page('Buster', '<p>buster</p><script>if (top.location !== self.location) { top.location = self.location; }</script>'),
  '/bust-parent2': () => page('Bust parent 2', '<iframe src="/buster2"></iframe>'),
  '/buster2': () => page('Buster 2', '<script>if (window.top !== window.self) { window.top.location.href = window.location.href; }</script>'),
  '/bust-parent3': () => page('Bust parent 3', '<iframe src="/buster3"></iframe><script>window.addEventListener("load", function () { setTimeout(function () { done({ stayed: true }); }, 200); });</script>'),
  '/buster3': () => page('Buster 3', '<script>if (top.location.hostname !== self.location.hostname) top.location.replace(self.location.href);</script>'),

  '/perf': () => page('Perf', `<div id="c"></div><div id="c2"></div>
<script>
var c = document.getElementById('c');
var t0 = performance.now();
for (var i = 0; i < 5000; i++) {
  var a = document.createElement('a'); a.href = '/item/' + i; a.textContent = i;
  var img = document.createElement('img'); img.setAttribute('data-x', i); a.appendChild(img);
  c.appendChild(a);
}
var t1 = performance.now();
var html = '';
for (i = 0; i < 5000; i++) html += '<div class="r"><a href="/row/' + i + '">r</a><span style="color:red">' + i + '</span></div>';
document.getElementById('c2').innerHTML = html;
var t2 = performance.now();
var box = document.createElement('div'); document.body.appendChild(box);
for (i = 0; i < 10000; i++) box.style.transform = 'translateX(' + (i % 100) + 'px)';
box.style.backgroundImage = 'url(/img/anim.png)';
var t3 = performance.now();
var count = 0, late = [];
new MutationObserver(function (rs) {
  // The proxy toolbar is attached once at DOMContentLoaded, which can land late on a heavy page.
  rs = rs.filter(function (m) { return !(m.addedNodes.length === 1 && m.addedNodes[0].nodeName === 'PROXY-TOOLBAR'); });
  count += rs.length;
  if (window.__c1 !== undefined) rs.forEach(function (m) { late.push(m.type + ':' + (m.target.nodeName || '') + ':' + (m.attributeName || '') + ':' + Array.prototype.map.call(m.addedNodes, function (n) { return n.nodeName; }).join('+')); });
}).observe(document, { attributes: true, childList: true, subtree: true });
setTimeout(function () {
  var c1 = window.__c1 = count;
  setTimeout(function () {
    var last = document.querySelector('#c2 .r:last-child a');
    done({ appendMs: t1 - t0, innerMs: t2 - t1, styleMs: t3 - t2, boxBg: box.attributes.style.value, settled: count === c1, mutations: count, late: late,
      last: c.lastChild.getAttribute('href'), lastRaw: c.lastChild.attributes.href.value, rowRaw: last.attributes.href.value });
  }, 300);
}, 300);
</script>`),

  '/eval': () => page('Eval', `<div id="d"></div>
<script>
(async function () {
  var r = { hasRewriter: !!window.__proxyRewriteJs };
  r.fn = new Function('return location.pathname')();
  r.fn2 = Function('a', 'return a + location.search')('x');
  r.direct = eval('location.pathname');
  r.indirect = (0, eval)('typeof location');
  r.gen = Object.getPrototypeOf(function* () {}).constructor('yield location.pathname')().next().value;
  setTimeout('window.__t = location.pathname', 0);
  var s = document.createElement('script'); s.textContent = 'window.__s = location.pathname'; document.head.appendChild(s);
  var s2 = document.createElement('script'); s2.appendChild(document.createTextNode('window.__s2 = location.href')); document.head.appendChild(s2);
  var s3 = document.createElement('script'); s3.text = 'window.__s3 = document.location.pathname'; document.head.appendChild(s3);
  var d = document.getElementById('d');
  d.innerHTML = '<a id="jsl" href="javascript:void(window.__jsl = location.pathname)">x</a>';
  document.getElementById('jsl').click();
  d.setAttribute('onclick', 'window.__oc = location.pathname');
  d.click();
  r.ocAttr = d.getAttribute('onclick');
  await new Promise(function (res) { setTimeout(res, 50); });
  r.t = window.__t; r.s = window.__s; r.s2 = window.__s2; r.s3 = window.__s3; r.jsl = window.__jsl; r.oc = window.__oc;
  r.dw = window.__dw;
  r.fnToString = Function.prototype.toString.call(Function).indexOf('[native code]') >= 0;
  done(r);
})().catch(fail);
</script>
<script>document.write('<script>window.__dw = location.pathname<\\/script>');</script>`),
};

function wsAccept(req, socket) {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  const send = (op, payload) => {
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : Buffer.from([0x80 | op, 126, len >> 8, len & 255]);
    socket.write(Buffer.concat([head, payload]));
  };
  let buf = Buffer.alloc(0);
  socket.on('error', () => {});
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 0x0f;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);
      if (op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (op === 9) send(0xa, payload);
      else if (op === 1) send(1, Buffer.from('echo:' + payload.toString()));
    }
  });
}

/** Start one fixture origin. `ctx` is shared so pages can link to the other origin. */
function createSite(ctx) {
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    log.push({ path: req.url, method: req.method });
    const me = 'http://' + req.headers.host;
    const html = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(body);
    };
    if (p === '/favicon.ico' || p.startsWith('/img/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(PNG);
    }
    if (p.endsWith('/api/echo')) {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ method: req.method, path: req.url, body: Buffer.concat(chunks).toString(), cookie: req.headers.cookie || '', referer: req.headers.referer || '', test: req.headers['x-test'] || '' }));
      });
      return;
    }
    if (p === '/api/set-cookie') {
      res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['srv=1; Path=/', 'hidden=1; Path=/; HttpOnly'] });
      return res.end('ok');
    }
    if (p === '/sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('data: one\n\n');
      const t = setTimeout(() => res.write('data: two\n\n'), 50);
      req.on('close', () => clearTimeout(t));
      return;
    }
    if (p === '/js/dyn.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.dynLoaded = true;'); }
    if (p === '/js/never.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('window.neverLoaded = true;'); }
    if (p === '/css/inner.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('#c{color:rgb(10, 20, 30)}'); }
    if (p === '/css/prop.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('#c{outline-color:rgb(40, 50, 60)}'); }
    if (p === '/css/parsed.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end('#c{border-top-color:rgb(70, 80, 90)}'); }
    if (p === '/workers/worker.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`self.onmessage = async function () {
  try {
    var r = { href: self.location.href, pathname: location.pathname, origin: self.origin, locOrigin: location.origin, str: String(location) };
    var a = await fetch('api/echo?w=rel'); r.rel = (await a.json()).path; r.resUrl = a.url;
    var b = await fetch('/api/echo?w=root'); r.root = (await b.json()).path;
    var x = new XMLHttpRequest(); x.open('GET', 'api/echo?w=xhr', false); x.send(); r.xhr = JSON.parse(x.responseText).path;
    importScripts('worker-helper.js'); r.helper = self.helperLoaded;
    r.name = self.name;
    if (self.__proxyRewriteJs) r.fn = new Function('return location.pathname')();
    postMessage(r);
  } catch (e) { postMessage({ error: String(e && e.stack || e) }); }
};`);
    }
    if (p === '/workers/worker-helper.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('self.helperLoaded = location.pathname;'); }
    if (p === '/workers/module-worker.mjs') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(`import { dep } from './module-dep.mjs';
const res = await fetch('api/echo?w=module');
postMessage({ href: location.href, dep, path: (await res.json()).path });`);
    }
    if (p === '/workers/module-dep.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end('export const dep = location.pathname;'); }
    if (p.startsWith('/frame/')) return html(page('frame:' + p, '<p>frame</p>', { harness: false }));
    if (p.startsWith('/target/') || p.startsWith('/item/') || p.startsWith('/row/')) return html(page('target', '<p>target</p>', { harness: false }));
    if (p === '/form-result') {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => html(page('Result', `<pre id="result">${JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }).replace(/</g, '\\u003c')}</pre>`, { harness: false })));
      return;
    }
    let key = p;
    if (p.startsWith('/spa/')) key = '/spa/';
    else if (p.startsWith('/net/')) key = '/net/';
    else if (p.startsWith('/cookies/')) key = '/cookies/';
    else if (p.startsWith('/loc')) key = '/loc';
    const fn = pages[key];
    if (fn) return html(fn({ A: ctx.A, B: ctx.B, me }));
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + p);
  });
  server.on('upgrade', (req, socket) => {
    log.push({ path: req.url, method: 'UPGRADE' });
    if (req.url.startsWith('/ws')) wsAccept(req, socket);
    else socket.destroy();
  });
  server.log = log;
  return server;
}

module.exports = { createSite, PNG };
