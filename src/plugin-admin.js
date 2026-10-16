'use strict';

/**
 * /__proxy/plugins: the plugin manager page and its JSON API.
 *
 *   GET  /__proxy/plugins                 the manager page
 *   GET  /__proxy/plugins/api             { plugins: [...], writable, dir }
 *   POST /__proxy/plugins/api/reload      re-read every plugin folder
 *   POST /__proxy/plugins/api/<id>        { enabled?, settings?, sites? }
 *   POST /__proxy/plugins/api/<id>/reload re-read one plugin
 *
 * Changes need a JSON body and an `X-X70-Admin: 1` header (so plain forms and cross-site pages
 * cannot send them) and are refused when they come from a proxied page. Every proxied site
 * shares the proxy's origin, so this is defence in depth rather than isolation: protect the
 * proxy with BASIC_AUTH, or set PLUGIN_ADMIN=0 to make this page read-only.
 */

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'same-origin',
};

function json(h, res, status, value) {
  return h.send(res, status, JSON.stringify(value), { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
}

function writeRefusal(req, h) {
  if (!h.allowWrite) return [403, 'The plugin manager is read-only (PLUGIN_ADMIN=0).'];
  if (h.fromForeignPage(req)) return [403, 'Forbidden'];
  if (h.refererTarget(req)) return [403, 'Proxied pages cannot change plugins.'];
  if (req.headers['x-x70-admin'] !== '1') return [403, 'Missing X-X70-Admin header.'];
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return [415, 'Send application/json.'];
  return null;
}

async function handle(req, res, url, h) {
  const { plugins } = h;
  const p = url.pathname.replace(/\/+$/, '');
  if (p === '/__proxy/plugins') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return h.sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    return h.send(res, 200, PAGE, PAGE_HEADERS);
  }
  if (p === '/__proxy/plugins/api') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return h.sendText(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
    return json(h, res, 200, { plugins: plugins.list(), writable: h.allowWrite, dir: plugins.dir, enabled: !plugins.disabled });
  }
  const m = /^\/__proxy\/plugins\/api\/([a-z0-9][a-z0-9_-]{0,63})(\/reload)?$/.exec(p);
  if (!m) return h.sendError(res, 404, 'Not found', 'Unknown plugin manager endpoint.');
  if (req.method !== 'POST') return h.sendText(res, 405, 'Method not allowed', { allow: 'POST' });
  const refused = writeRefusal(req, h);
  if (refused) {
    req.resume();
    return json(h, res, refused[0], { error: refused[1] });
  }
  let body = {};
  try {
    const text = await h.readBody(req);
    body = text.trim() ? JSON.parse(text) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('expected an object');
  } catch (e) {
    return json(h, res, e.status || 400, { error: `Bad request body: ${e.message}` });
  }
  try {
    const [, id, reload] = m;
    if (id === 'reload' && !reload) return json(h, res, 200, { plugins: plugins.reload() });
    if (reload) return json(h, res, 200, { plugin: plugins.reload(id) });
    const change = {};
    for (const k of ['enabled', 'settings', 'sites']) if (body[k] !== undefined) change[k] = body[k];
    return json(h, res, 200, { plugin: plugins.update(id, change) });
  } catch (e) {
    return json(h, res, e.status || 500, { error: e.message });
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Plugins · userx70</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1b1e24;--muted:#626a78;--line:#e2e5ea;--accent:#4c6ef5;--ok:#2b8a3e;--bad:#c92a2a;--chip:#eef1f6;--input:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--fg:#e8eaf0;--muted:#9aa3b2;--line:#2a2f3a;--accent:#748ffc;--ok:#51cf66;--bad:#ff6b6b;--chip:#222733;--input:#0f1115}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:28px 16px 64px}
header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px}
h1{font-size:22px;margin:0;flex:1}
a{color:var(--accent)}
.sub{color:var(--muted);margin:0 0 20px}
.sub code{background:var(--chip);padding:1px 6px;border-radius:6px;font-size:12px;word-break:break-all}
button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 12px;border-radius:8px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:12px 0}
.top{display:flex;align-items:flex-start;gap:12px}
.top .info{flex:1;min-width:0}
.name{font-weight:600;font-size:16px}
.ver{color:var(--muted);font-size:12px;margin-left:6px}
.desc{color:var(--muted);margin:4px 0 0}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{background:var(--chip);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--muted)}
.pill{font-size:12px;border-radius:999px;padding:1px 8px;border:1px solid currentColor}
.pill.on{color:var(--ok)}.pill.off{color:var(--muted)}.pill.err{color:var(--bad)}
.err{color:var(--bad);margin-top:8px;font-size:13px;white-space:pre-wrap}
.switch{position:relative;width:42px;height:24px;flex:none}
.switch input{opacity:0;width:0;height:0;position:absolute}
.switch span{position:absolute;inset:0;background:var(--line);border-radius:999px;transition:.15s;cursor:pointer}
.switch span:before{content:"";position:absolute;width:18px;height:18px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.15s}
.switch input:checked+span{background:var(--accent)}
.switch input:checked+span:before{transform:translateX(18px)}
.switch input:disabled+span{opacity:.5;cursor:default}
.switch input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}
details{margin-top:12px;border-top:1px solid var(--line);padding-top:10px}
summary{cursor:pointer;color:var(--muted)}
.form{display:grid;gap:12px;margin-top:12px}
label.f{display:grid;gap:4px}
label.f small{color:var(--muted)}
.f.row{display:flex;align-items:center;gap:8px}
input[type=text],input[type=number],input[type=password],select,textarea{font:inherit;color:var(--fg);background:var(--input);border:1px solid var(--line);border-radius:8px;padding:6px 8px;width:100%}
textarea{min-height:64px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
input[type=color]{width:48px;height:32px;border:1px solid var(--line);border-radius:8px;background:var(--input)}
.actions{display:flex;gap:8px;align-items:center}
.msg{font-size:13px;color:var(--muted)}
.empty{text-align:center;color:var(--muted);padding:40px 16px}
#toast{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:8px;opacity:0;transition:.2s;pointer-events:none;max-width:calc(100vw - 32px)}
#toast.show{opacity:1}
</style>
</head>
<body>
<main>
<header><h1>Plugins</h1><a href="/">Home</a><button id="reloadAll" type="button">Reload from disk</button></header>
<p class="sub" id="sub">Loading…</p>
<div id="list"></div>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script>
(function () {
  var API = '/__proxy/plugins/api';
  var state = { plugins: [], writable: false };
  var list = document.getElementById('list');
  var toastTimer;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'on') for (var ev in attrs.on) e.addEventListener(ev, attrs.on[ev]);
      else if (attrs[k] === true) e.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  function toast(text) {
    var t = document.getElementById('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2600);
  }

  function call(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-x70-admin': '1' },
      body: JSON.stringify(body || {}),
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  function load() {
    return fetch(API, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) {
      state = j;
      render();
    }).catch(function (e) { document.getElementById('sub').textContent = 'Could not load plugins: ' + e.message; });
  }

  function replace(p) {
    state.plugins = state.plugins.map(function (q) { return q.id === p.id ? p : q; });
    render();
  }

  function field(id, key, spec, value) {
    var name = 'f-' + id + '-' + key;
    var input;
    if (spec.type === 'boolean') {
      input = el('input', { type: 'checkbox', id: name, name: key, checked: Boolean(value) });
      return el('label', { class: 'f row', for: name }, [input, el('span', { text: spec.label }), spec.description ? el('small', { text: ' — ' + spec.description }) : null]);
    }
    if (spec.type === 'select') {
      input = el('select', { id: name, name: key }, spec.options.map(function (o) {
        var v = o && typeof o === 'object' ? o.value : o;
        var l = o && typeof o === 'object' ? (o.label || o.value) : o;
        return el('option', { value: String(v), selected: String(v) === String(value), text: String(l) });
      }));
    } else if (spec.type === 'text') {
      input = el('textarea', { id: name, name: key });
      input.value = value == null ? '' : String(value);
    } else {
      var type = spec.secret ? 'password' : spec.type === 'number' ? 'number' : spec.type === 'color' ? 'color' : 'text';
      input = el('input', { type: type, id: name, name: key, min: spec.min, max: spec.max, step: spec.step != null ? spec.step : (spec.type === 'number' ? 'any' : null),
        placeholder: spec.secret && spec.hasValue ? '•••••• (saved — leave blank to keep)' : null, autocomplete: spec.secret ? 'off' : null });
      input.value = value == null ? '' : String(value);
    }
    return el('label', { class: 'f', for: name }, [el('span', { text: spec.label }), input, spec.description ? el('small', { text: spec.description }) : null]);
  }

  function readForm(form, schema) {
    var out = {};
    Object.keys(schema).forEach(function (k) {
      var spec = schema[k];
      var input = form.elements[k];
      if (!input) return;
      if (spec.type === 'boolean') out[k] = input.checked;
      else if (spec.type === 'number') out[k] = input.value === '' ? null : Number(input.value);
      else out[k] = input.value;
      if (out[k] === null) delete out[k];
    });
    return out;
  }

  function card(p) {
    var ro = !state.writable;
    var status = p.error ? el('span', { class: 'pill err', text: 'error' })
      : p.running ? el('span', { class: 'pill on', text: 'running' }) : el('span', { class: 'pill off', text: 'off' });
    var toggle = el('input', { type: 'checkbox', checked: p.enabled && p.running, disabled: ro || Boolean(p.error), 'aria-label': 'Enable ' + p.name });
    toggle.addEventListener('change', function () {
      toggle.disabled = true;
      call('/' + p.id, { enabled: toggle.checked }).then(function (j) {
        replace(j.plugin);
        toast(p.name + (j.plugin.running ? ' on' : ' off') + ' — reload proxied pages to apply');
      }).catch(function (e) { toast(e.message); load(); });
    });

    var chips = el('div', { class: 'chips' }, p.hooks.map(function (hk) { return el('span', { class: 'chip', text: hk }); })
      .concat(p.client ? [el('span', { class: 'chip', text: 'client script' })] : [])
      .concat(p.toolbar.length ? [el('span', { class: 'chip', text: p.toolbar.length + ' toolbar button' + (p.toolbar.length > 1 ? 's' : '') })] : []));

    var errs = [];
    if (p.error) errs.push(el('div', { class: 'err', text: 'Could not load: ' + p.error }));
    if (p.lastError) errs.push(el('div', { class: 'err', text: (p.lastError.disabled ? 'Switched off after repeated failures. ' : '') + 'Last error in ' + p.lastError.hook + ': ' + p.lastError.message }));

    var form = el('form', { class: 'form' });
    Object.keys(p.schema).forEach(function (k) { form.appendChild(field(p.id, k, p.schema[k], p.settings[k])); });
    var sites = el('textarea', { name: '__sites', id: 'sites-' + p.id });
    sites.value = p.sites.join('\\n');
    form.appendChild(el('label', { class: 'f', for: 'sites-' + p.id }, [el('span', { text: 'Sites' }),
      sites, el('small', { text: 'One per line. * = every site, example.com = it and its subdomains, !example.com = never there.' })]));
    var msg = el('span', { class: 'msg' });
    var save = el('button', { class: 'primary', type: 'submit', disabled: ro || Boolean(p.error), text: 'Save' });
    var reload = el('button', { type: 'button', disabled: ro, text: 'Reload plugin' });
    reload.addEventListener('click', function () {
      call('/' + p.id + '/reload').then(function (j) { replace(j.plugin); toast(p.name + ' reloaded'); }).catch(function (e) { toast(e.message); load(); });
    });
    form.appendChild(el('div', { class: 'actions' }, [save, reload, msg]));
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      save.disabled = true;
      var body = { settings: readForm(form, p.schema), sites: sites.value.split(/[\\s,]+/).filter(Boolean) };
      if (!Object.keys(p.schema).length) delete body.settings;
      call('/' + p.id, body).then(function (j) { replace(j.plugin); toast('Saved ' + p.name); })
        .catch(function (err) { save.disabled = false; msg.textContent = err.message; });
    });
    if (ro) Array.prototype.forEach.call(form.elements, function (x) { x.disabled = true; });

    return el('section', { class: 'card', 'aria-label': p.name, 'data-id': p.id }, [
      el('div', { class: 'top' }, [
        el('div', { class: 'info' }, [
          el('div', {}, [el('span', { class: 'name', text: p.name }), el('span', { class: 'ver', text: 'v' + p.version + ' · ' + p.id }), ' ', status]),
          p.description ? el('p', { class: 'desc', text: p.description }) : null,
          chips,
        ]),
        el('label', { class: 'switch' }, [toggle, el('span')]),
      ]),
    ].concat(errs).concat([el('details', {}, [el('summary', { text: 'Settings & sites' }), form])]));
  }

  function render() {
    var sub = document.getElementById('sub');
    sub.textContent = '';
    if (!state.enabled) sub.appendChild(document.createTextNode('Plugins are switched off on this server (PLUGINS_ENABLED=0). '));
    sub.appendChild(document.createTextNode(state.plugins.length + ' installed in '));
    sub.appendChild(el('code', { text: state.dir || '(none)' }));
    sub.appendChild(document.createTextNode(state.writable ? '. Changes apply to new page loads.' : '. Read-only (PLUGIN_ADMIN=0).'));
    document.getElementById('reloadAll').disabled = !state.writable;
    var open = {};
    Array.prototype.forEach.call(list.querySelectorAll('section[data-id]'), function (sec) {
      var d = sec.querySelector('details');
      if (d && d.open) open[sec.getAttribute('data-id')] = true;
    });
    list.textContent = '';
    if (!state.plugins.length) {
      list.appendChild(el('div', { class: 'card empty', text: 'No plugins yet. Add a folder with a plugin.json to the plugins directory, then press “Reload from disk”.' }));
      return;
    }
    state.plugins.forEach(function (p) {
      var c = card(p);
      if (open[p.id]) c.querySelector('details').open = true;
      list.appendChild(c);
    });
  }

  document.getElementById('reloadAll').addEventListener('click', function () {
    call('/reload').then(function (j) { state.plugins = j.plugins; render(); toast('Reloaded ' + j.plugins.length + ' plugins'); })
      .catch(function (e) { toast(e.message); });
  });
  load();
})();
</script>
</body>
</html>
`;

module.exports = { handle, PAGE };
