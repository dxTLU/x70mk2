'use strict';

// Keeps the last N requests of each browser session in memory and serves them at
// /__proxy/x/request-log/ (a page) and /__proxy/x/request-log/api (JSON).

module.exports = (x70) => {
  const logs = new Map(); // session id -> entries, newest last

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  return {
    onDisable() { logs.clear(); },

    onRequest(ctx) {
      const s = ctx.settings;
      if (s.documentsOnly && !ctx.topLevel) return;
      let list = logs.get(ctx.session);
      if (!list) logs.set(ctx.session, (list = []));
      list.push({ at: Date.now(), method: ctx.method, url: ctx.url, dest: ctx.dest || (ctx.topLevel ? 'document' : ''), from: ctx.initiator });
      if (list.length > s.max) list.splice(0, list.length - s.max);
    },

    route(req, res, ctx) {
      const list = logs.get(ctx.session) || [];
      if (ctx.path === '/api') return ctx.json({ entries: list });
      if (ctx.path === '/clear' && req.method === 'POST') {
        if (ctx.fromPage || ctx.foreign) return ctx.json({ error: 'forbidden' }, 403);
        logs.delete(ctx.session);
        return ctx.json({ ok: true });
      }
      if (ctx.path !== '/') return ctx.send(404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
      const rows = list.slice().reverse().map((e) => `<tr><td>${new Date(e.at).toLocaleTimeString()}</td><td>${esc(e.method)}</td>` +
        `<td>${esc(e.dest)}</td><td class="u"><a href="/p/${esc(e.url)}">${esc(e.url)}</a></td></tr>`).join('');
      ctx.send(200, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request log</title><style>
:root{color-scheme:light dark}body{font:13px/1.4 system-ui,sans-serif;margin:0;padding:20px 16px}
h1{font-size:20px;margin:0 0 4px}p{color:#888;margin:0 0 14px}table{border-collapse:collapse;width:100%}
td,th{text-align:left;padding:4px 8px;border-bottom:1px solid #8884;vertical-align:top}.u{word-break:break-all;font-family:ui-monospace,monospace;font-size:12px}
.bar{display:flex;gap:8px;margin-bottom:12px}button{font:inherit;padding:4px 10px}
</style></head><body><h1>Request log</h1><p>${list.length} requests from this browser session (newest first). Refreshes every 3 s.</p>
<div class="bar"><a href="/__proxy/plugins">Plugins</a><button id="clear">Clear</button></div>
<table><thead><tr><th>Time</th><th>Method</th><th>Type</th><th>URL</th></tr></thead><tbody>${rows}</tbody></table>
<script>
document.getElementById('clear').onclick = function () { fetch('clear', { method: 'POST' }).then(function () { location.reload(); }); };
setTimeout(function () { location.reload(); }, 3000);
</script></body></html>`, { 'content-type': 'text/html; charset=utf-8' });
    },
  };
};
