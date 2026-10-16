# Writing plugins

A plugin is a folder in `plugins/` (or `PLUGINS_DIR`). The folder name is the plugin's id:
lowercase letters, digits, `-` and `_`. Folders starting with `_` or `.` are ignored, so
`_my-draft/` stays switched off until you rename it.

```
plugins/hello/
  plugin.json   manifest (required)
  index.js      server hooks (optional)
  client.js     runs inside proxied pages (optional)
```

Open `/__proxy/plugins`, press **Reload from disk**, then switch the plugin on. After editing its
files, press **Reload plugin** on its card. No restart is needed.

## plugin.json

```json
{
  "name": "Hello",
  "version": "1.0.0",
  "description": "Says hello on every page.",
  "main": "index.js",
  "client": "client.js",
  "allFrames": false,
  "sites": ["*"],
  "settings": {
    "greeting": { "type": "string", "label": "Greeting", "default": "Hello!", "public": true },
    "shout":    { "type": "boolean", "label": "Shout", "default": false },
    "size":     { "type": "number", "label": "Size", "default": 14, "min": 8, "max": 40 },
    "mode":     { "type": "select", "label": "Mode", "options": ["a", { "value": "b", "label": "Bee" }] },
    "accent":   { "type": "color", "label": "Accent", "default": "#4c6ef5" },
    "notes":    { "type": "text", "label": "Notes" },
    "apiKey":   { "type": "string", "label": "API key", "secret": true }
  },
  "toolbar": [
    { "id": "wave", "label": "👋", "title": "Wave" },
    { "id": "page", "label": "H", "title": "Hello page", "href": "/__proxy/x/hello/" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `main` | Server module, `index.js` by default. `null` for client-only plugins. |
| `client` | Script injected into proxied pages. |
| `allFrames` | Also inject the client script, and run `transformHtml`, in frames. Default: top-level pages only. |
| `sites` | Default sites: `*` (all), `example.com` (it and its subdomains), `!ads.example.com` (never). Users can change them on the manager page. |
| `settings` | Form fields shown on the manager page. Types: `string`, `text`, `number` (`min`, `max`, `step`), `boolean`, `select` (`options`), `color` (`#rrggbb`). Values are checked and coerced to these types. `public: true` hands the value to `client.js`. `secret: true` is never sent to a browser, not even to the manager page. |
| `toolbar` | Up to 8 buttons on the proxy toolbar. `label` is up to 4 characters (an emoji works well). With `href` (`/__proxy/...` or `https://...`) the button navigates; without it, `client.js` gets the click. |

## Server hooks (index.js)

Export an object of hooks, or a function that receives the `x70` API and returns one:

```js
module.exports = (x70) => ({
  onEnable() {},                 // switched on (also at startup)
  onDisable() {},                // switched off or reloaded
  onSettings(settings) {},       // settings saved while running

  // Before a request leaves for the site. May be async.
  onRequest(ctx) {
    // ctx: url, method, dest ('document', 'image', 'script', ...), topLevel, initiator (the page
    // that made the request), requestHeaders (from the browser), session, settings,
    // setHeader(name, value), removeHeader(name)   <- edit what is sent to the site
    if (ctx.url.includes('/ads/')) return { block: true };                // 403 page
    // return { block: { status: 451, reason: 'Not here' } }              // custom status/reason
    // return { block: { status: 200, body: '{}', contentType: 'application/json' } }
    // return { redirect: 'https://example.org/' }                        // 307 to another site
    // return { url: 'https://mirror.example/' + path }                   // fetch elsewhere, silently
  },

  // Headers about to be sent to the browser. Must be synchronous. Edit ctx.headers in place;
  // set a header to undefined to remove it. Also: url, status, dest, upstreamHeaders, settings.
  onResponseHeaders(ctx) {
    ctx.headers['x-hello'] = '1';
  },

  // Bodies, before the proxy rewrites them, so links you add are proxied like the site's own.
  // May be async. Return the new text (or the same text to leave it alone).
  // ctx: url, dest, status, contentType, kind, settings
  transformHtml(html, ctx) {
    return html.replace('</body>', `<p>${x70.settings.greeting}</p></body>`);
  },
  transformCss(css, ctx) { return css; },
  transformJs(js, ctx) { return js; },

  // Your own pages and APIs at /__proxy/x/<id>/<path>. May be async.
  route(req, res, ctx) {
    // ctx: path ('/', '/api', ...), url, query, session, settings, storage,
    // fromPage (URL of the proxied page that called, or null), foreign (another website called),
    // readBody(limit), readJson(limit), send(status, body, headers), json(value, status)
    if (ctx.path === '/') return ctx.send(200, '<h1>Hello</h1>', { 'content-type': 'text/html; charset=utf-8' });
    if (ctx.path === '/api') return ctx.json({ greeting: ctx.settings.greeting });
    ctx.send(404, 'Not found');
  },
});
```

The `x70` API:

| | |
| --- | --- |
| `x70.id`, `x70.dir`, `x70.manifest` | The plugin's id, folder and manifest. |
| `x70.settings` | Current settings (always up to date, defaults filled in). |
| `x70.storage` | Key/value store saved to `PLUGIN_DATA_DIR/plugins/<id>.json`: `get(key, fallback)`, `set(key, value)` (JSON values), `delete(key)`, `keys()`, `all()`, `clear()`. |
| `x70.matches(url)` | Whether the plugin is on for that site. |
| `x70.log(...)`, `x70.error(...)` | Log with the plugin's name. |

Rules worth knowing:

- Hooks only run while the plugin is on, and only for its sites.
- Each hook call has `PLUGIN_HOOK_TIMEOUT` ms (3 s). A hook that throws or times out is skipped,
  so the page still loads. After 5 failures in a row the plugin is switched off and the error
  shows on the manager page.
- Responses changed by a plugin are never put in Varnish's shared cache, and their ETags change
  when plugin settings change, so browsers fetch the new version. Varnish can still hold copies
  of CSS and JS from before a `transformCss`/`transformJs` plugin was switched on. Purge them
  (README: "Purge every cached variant") or wait for them to expire.
- WebSocket connections are tunnelled as they are: `onRequest` and the other hooks do not see them.
- Every proxied site runs on the proxy's own origin. A route that changes something should check
  `ctx.fromPage` and `ctx.foreign`, and refuse requests made by proxied pages it does not trust.

## Client scripts (client.js)

The file is wrapped as `(function (x70) { ... })(...)` and loaded right after the proxy's runtime,
before the page's own scripts. Inside it:

| | |
| --- | --- |
| `x70.id`, `x70.name`, `x70.version` | About the plugin. |
| `x70.settings` | The settings marked `"public": true`. |
| `x70.url()` | The real URL of the page (`https://example.com/...`), not the proxied one. |
| `x70.onToolbar(action, fn)` | Called when the plugin's toolbar button with that `id` is clicked. Leave out `action` to get them all. |
| `x70.fetch(path, options)` | `fetch()` to the plugin's own route: `x70.fetch('api')` asks `/__proxy/x/<id>/api`. |
| `x70.endpoint(path)` | The absolute URL of a route, for links and `<img src>`. |
| `x70.storage.get(key, fallback)`, `.set(key, value)` | Per-site browser storage. |

```js
var box = document.createElement('div');
box.textContent = x70.settings.greeting;
x70.onToolbar('wave', function () { document.body.appendChild(box); });
x70.fetch('api').then(function (r) { return r.json(); }).then(console.log);
```

The script runs before `<body>` exists. Wait for `DOMContentLoaded` before touching the page.

## Examples

- [`dark-mode`](dark-mode): client-only, settings, a toolbar button that toggles per site.
- [`request-log`](request-log): `onRequest` plus a `route` that serves a page and a JSON API.
- [`site-blocker`](site-blocker): `onRequest` that blocks, configured by a text setting.
