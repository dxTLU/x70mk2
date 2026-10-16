# userx70 host server: a self-hosted web proxy

A rewriting web proxy you run on your own machine or lab VM. Open
`http://<server>:6081/`, type an address or search terms, and browse: every page is fetched by
the server and rewritten so its links, images, scripts, forms, `fetch()` calls and WebSockets
keep going through the proxy. A [Varnish](https://varnish-cache.org/) front end (configured in
VCL, `varnish/default.vcl`) caches static assets for everyone and streams everything else.

- Plain Node.js (18 or newer, 22 LTS recommended) with **zero npm dependencies**.
- Works with modern sites: server-side HTML/CSS/JS/SVG rewriting plus a browser runtime that
  hooks `fetch`, XHR, WebSocket, EventSource, workers, `history`, `location`, `document.cookie`,
  `postMessage`, storage and DOM URL properties.
- Server-side cookie jar per browser session, with SameSite and CORS rules re-applied.
- Streams video (with seeking), downloads, uploads and server-sent events; tunnels WebSockets.
- Optional password (`BASIC_AUTH`), HTTPS, outbound upstream proxy, systemd units and Docker.

## Contents

- [Quick start](#quick-start)
- [Using it](#using-it)
- [Running on a remote lab VM or VCL reservation](#running-on-a-remote-lab-vm-or-vcl-reservation)
- [Configuration](#configuration)
- [Plugins](#plugins)
- [How it works](#how-it-works)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

## Quick start

### Node.js only (any OS)

```sh
npm start                      # http://localhost:8080/
```

or `scripts/start-node-only.sh` on Linux/macOS, or on Windows double-click `scripts\start.cmd`
(or run `powershell -ExecutionPolicy Bypass -File scripts\start.ps1`). These print every
address the proxy can be reached at, including the machine's LAN IP.

### With Varnish (Linux)

```sh
sudo apt install varnish       # Debian/Ubuntu; dnf install varnish on Fedora/RHEL
scripts/start.sh               # http://localhost:6081/ and http://<LAN IP>:6081/
```

`scripts/start.sh` starts the app on `127.0.0.1:8080`, waits until it is healthy, then starts
Varnish on port 6081 in front of it with the right runtime parameters, and prints the URLs.
Ctrl+C stops both; so does `scripts/stop.sh` from another terminal. Without `varnishd` it falls
back to the app alone on port 8080. Run it as root (`sudo -E scripts/start.sh`) to let Varnish
drop privileges to its own user, or as a normal user.

### As services (systemd)

```sh
sudo deploy/install.sh
```

Copies the app to `/opt/x70mk2`, installs `x70mk2-proxy.service` (the app, sandboxed, on
`127.0.0.1:8080`) and a drop-in that points the distribution's `varnish.service` at our VCL on
port 6081, then starts both. Settings go in `/etc/default/x70mk2-proxy`
(see `deploy/x70mk2-proxy.env`). Logs: `journalctl -u x70mk2-proxy -u varnish -f`.

### Docker

```sh
docker compose up -d --build                 # http://<host>:6081/ (Varnish in front)
BASIC_AUTH=me:secret docker compose up -d    # with a password
docker build -t x70mk2-proxy . && docker run -p 8080:8080 x70mk2-proxy   # app only
```

The image is `node:22-alpine`, runs as the unprivileged `node` user and keeps the cookie jars
in the `/data` volume. Compose runs the official `varnish:7` image with our VCL, sharing the
app container's network so only Varnish's port is published.

## Using it

- **Address box**: a URL (`example.com`, `https://example.com/path`, `192.168.1.10:8000`) or
  words to search for. A proxy link pasted back in (`http://server/p/https://...`) works too.
- **Direct links**: `http://<server>/p/https://example.com/` opens a site without the home page.
- **Settings** (gear button, saved in your browser): search engine (DuckDuckGo by default,
  Google, Bing, Brave Search, Startpage), open sites in a new tab, remember recent sites, and
  light/dark/system appearance. Without JavaScript the server searches with `SEARCH_URL`.
- **Toolbar**: proxied pages get a small floating widget (back, forward, reload, address, home,
  plugin buttons). Turn it off for everyone with `TOOLBAR=0`.
- **Plugins**: `http://<server>/__proxy/plugins` (puzzle button on the toolbar) switches plugins
  on and off, edits their settings and limits them to sites. See [Plugins](#plugins).
- **Sign out everywhere** on the home page deletes every cookie the proxy stores for your session.
- Press <kbd>/</kbd> on the home page to jump to the address box.

## Running on a remote lab VM or VCL reservation

The proxy runs fine on a remote Linux VM, including a Virtual Computing Lab (VCL) reservation.

1. Connect with SSH and install Node.js (and optionally Varnish):
   `sudo apt install -y nodejs varnish` (NodeSource packages if the distribution's Node.js is
   older than 18).
2. Copy or clone this directory to the VM and run `scripts/start.sh`. It listens on all
   interfaces and prints `http://<VM IP>:6081/` (or `:8080` without Varnish).
3. **Open the port** if a firewall is on: `sudo ufw allow 6081/tcp`, or
   `sudo firewall-cmd --add-port=6081/tcp --permanent && sudo firewall-cmd --reload`. Cloud and lab
   VMs often also have a provider-side firewall or security group to adjust.
4. **Keep it private**: anyone who can reach the port can use your server's connection. Set a
   password with `BASIC_AUTH=user:password scripts/start.sh`; browsers ask for it once.
5. **Keep it running** after you log out: `nohup scripts/start.sh > proxy.log 2>&1 &`, a
   `tmux`/`screen` session, or `sudo deploy/install.sh` for services that survive reboots.

If the lab only lets you reach the VM over SSH, or only from the address you reserved it from,
tunnel the port instead of opening it:

```sh
ssh -L 6081:localhost:6081 you@vm-address     # then browse http://localhost:6081/
```

**HTTPS and secure contexts.** Some site features (Web Crypto, clipboard, camera, some logins)
only work in a *secure context*: an `https://` page, or `http://localhost` /
`http://127.0.0.1`. A plain `http://<VM IP>` address is not one. Options, simplest first:

- Use the SSH tunnel above: `http://localhost:6081/` is a secure context.
- Let the app serve HTTPS itself (node-only; Varnish cannot terminate TLS):

  ```sh
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 -keyout key.pem -out cert.pem \
    -subj "/CN=proxy" -addext "subjectAltName=IP:<VM IP>,DNS:localhost"
  TLS_CERT=cert.pem TLS_KEY=key.pem scripts/start.sh     # https://<VM IP>:8080/
  ```

  Browsers warn about a self-signed certificate until you trust it; a real certificate for a
  host name avoids that.
- Keep Varnish and put a TLS terminator in front of it: nginx or Caddy on the same machine
  forwarding to `127.0.0.1:6081` with `X-Forwarded-Proto: https` (trusted from loopback only), or
  hitch/HAProxy speaking the PROXY protocol to the listener `VARNISH_PROXY_PORT=6086
  scripts/start.sh` adds on `127.0.0.1:6086` (the VCL reads the TLS flag from it).

## Configuration

Everything is set with environment variables (`src/config.js`); none is required.

| Variable | Default | What it does |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Address the app listens on (`scripts/start.sh` uses `127.0.0.1` behind Varnish). |
| `PORT` | `8080` | Port the app listens on. |
| `BASIC_AUTH` | (off) | `user:password` required from every browser (HTTP Basic). Recommended on any network. |
| `ALLOW_PRIVATE` | `0` | `1` allows proxying to localhost and private networks. Off by default: it would let users reach the server's internal network (SSRF). |
| `SEARCH_URL` | `https://duckduckgo.com/?q=%s` | Search used by the server when JavaScript is off or from the toolbar; `%s` is the query. |
| `UPSTREAM_PROXY` | `HTTPS_PROXY`/`HTTP_PROXY` | Send outbound traffic through an HTTP proxy (`http://user:pass@host:port`, tunnels with CONNECT). Loopback is never proxied. |
| `NO_PROXY` | (none) | Hosts that bypass `UPSTREAM_PROXY`: names, `.suffix`, `*.suffix`, IPs, CIDR ranges, `:port`, or `*`. |
| `TLS_CERT`, `TLS_KEY` | (off) | PEM certificate and key: the app serves HTTPS itself. |
| `TRUST_PROXY` | `1` | Trust `X-Forwarded-Proto/Host` (set by Varnish) for the public URL and Secure cookies. Set `0` if the app is exposed directly and you want to ignore them. |
| `PERSIST_SESSIONS` | `1` | Save cookie jars to disk (every minute and on shutdown). |
| `DATA_FILE` | `data/sessions.json` | Where the cookie jars are saved. |
| `SESSION_TTL_HOURS` | `168` | Sessions unused for this long are deleted. |
| `EMULATE_SAMESITE` | `1` | Apply SameSite cookie rules between proxied sites (they all share the proxy's origin). |
| `EMULATE_CORS` | `1` | Apply CORS to cross-origin `fetch`/XHR between proxied sites. |
| `TOOLBAR` | `1` | Show the floating toolbar on proxied pages. |
| `MAX_REWRITE_BYTES` | `33554432` | Larger HTML/CSS/JS responses are streamed unmodified instead of rewritten. |
| `UPSTREAM_TIMEOUT` | `30000` | Milliseconds to wait for a site to connect and answer. |
| `SHUTDOWN_GRACE_MS` | `3000` | On SIGTERM/SIGINT, how long open streams and WebSockets may finish. |
| `LOG_REQUESTS` | `0` | Log every request with status and timing. |
| `NODE_EXTRA_CA_CERTS` | (none) | Node.js: extra CA certificates to trust (internal sites, TLS-inspecting networks). |
| `PLUGINS_ENABLED` | `1` | `0` ignores every plugin. |
| `PLUGINS_DIR` | `plugins/` | Folder with one sub-folder per plugin. |
| `PLUGINS` | (none) | Comma-separated plugin ids to switch on at startup, on top of the saved state. |
| `PLUGIN_DATA_DIR` | folder of `DATA_FILE` | Where `plugins.json` (on/off, settings, sites) and each plugin's storage are saved. |
| `PERSIST_PLUGINS` | `1` | Save plugin state and storage to disk. |
| `PLUGIN_ADMIN` | `1` | `0` makes `/__proxy/plugins` read-only. |
| `PLUGIN_HOOK_TIMEOUT` | `3000` | Milliseconds a plugin hook may take before it is skipped (and counted as a failure). |

`scripts/start.sh` also reads:

| Variable | Default | What it does |
| --- | --- | --- |
| `VARNISH_PORT` | `6081` | Public port of Varnish. |
| `VARNISH_LISTEN` | (all) | Address Varnish listens on. |
| `VARNISH_SIZE` | `256m` | Cache memory. |
| `VARNISH_WORKDIR` | `/var/lib/varnish/x70mk2-proxy` as root, else `data/varnish` | `varnishd -n` directory (use it with `varnishadm -n` and `varnishlog -n`). |
| `VARNISH_PROXY_PORT` | (off) | Also accept the PROXY protocol on `127.0.0.1:<port>`, for a local TLS terminator. |
| `NO_VARNISH` | `0` | `1` runs the app alone. |

## Plugins

Plugins add features without touching the proxy's code. Each one is a folder in `plugins/` with a
`plugin.json` manifest and, optionally, server hooks (`index.js`) and a script that runs in
proxied pages (`client.js`). Three ship with the proxy, switched off:

| Plugin | What it does |
| --- | --- |
| `dark-mode` | Darkens every site; 🌙 on the toolbar switches a site back. Brightness and contrast settings. |
| `request-log` | Logs the requests of your browser session; 📜 on the toolbar opens the log. |
| `site-blocker` | Blocks listed domains (and subdomains) for everyone. |

Open `/__proxy/plugins` to switch them on, change settings or limit them to some sites
(`example.com`, `!ads.example.com`, `*`). Changes apply to the next page load and are saved in
`plugins.json` next to the cookie jars. After adding or editing plugin files press **Reload from
disk**, send the process `SIGHUP`, or run `systemctl reload x70mk2-proxy`.

A plugin that keeps failing (5 errors or timeouts in a row) is switched off and the error is
shown on the manager page. Plugins are ordinary Node.js code running inside the proxy: only
install ones you have read. Every proxied site shares the proxy's origin, so on a shared proxy set
`BASIC_AUTH` (or `PLUGIN_ADMIN=0` to lock the manager page).

[plugins/README.md](plugins/README.md) explains how to write one.

## How it works

```
browser ──► Varnish :6081 ──► node server.js 127.0.0.1:8080 ──► the website
             caches static     rewrites pages, keeps cookies,
             assets            streams everything else
```

**URL scheme.** A proxied URL is the proxy's origin, `/p/`, and the whole target URL:
`http://server:6081/p/https://example.com/a?b=1`. WebSockets use `/p/wss://...`. Root-relative
requests that escape rewriting (`/static/app.js` built at run time) are redirected to the site of
the page that made them (from the `Referer`, or the last site you opened).

**Rewriting.** The server rewrites HTML (URL attributes, `srcset`, inline styles and scripts,
`<base>`, meta refresh, import maps, `srcdoc`), CSS (`url()`, `@import`), SVG and JavaScript (a
tokenizer renames `location` to a proxy-aware `__pLocation`). It removes headers and attributes
that would block a proxied page (CSP, `X-Frame-Options`, HSTS, COOP/COEP, `integrity`) and
rewrites `Location`, `Link` and `Refresh`. Everything else streams through byte for byte, with
`Range` support for media seeking.

**Cookies.** Sites' cookies never reach the browser: each browser gets a `__psid` session cookie
and the server keeps a cookie jar per session (domain/path/expiry/Secure/HttpOnly rules, `__Host-`
and `__Secure-` prefixes). Scripts read and write `document.cookie` through `/__proxy/cookie`.
Because every site shares the proxy's origin, the server re-applies SameSite and CORS rules.

**Browser runtime.** `/__proxy/client.js` is injected at the top of every page. It rewrites URLs
created at run time (`fetch`, XHR, `sendBeacon`, WebSocket, EventSource, workers, `window.open`,
`history`, the Navigation API, element properties and `setAttribute`, CSS), presents the real
site's `location`, `document.referrer`, `document.domain` and `postMessage` origins, keeps
`localStorage`/`sessionStorage` separate per site, and disables service workers.

**Varnish caching policy** (`varnish/default.vcl`):

| Request or response | Varnish |
| --- | --- |
| Static assets: `Sec-Fetch-Dest` image, font, style, script, worker, audio, video, track, manifest, or a static file extension | Cached and shared by all users (ttl from the site, 1 h if none, at most 7 days) |
| `/__proxy/client.js?v=<hash>` (the runtime, immutable) | Cached |
| Documents and frames (navigations), `fetch`/XHR without a static extension, the home page, `/__proxy/*` endpoints, `POST` and other methods | Passed to the app, never cached |
| Responses the app fetched with your cookies (`X-Proxy-Private`), `Set-Cookie`, `private`, `no-store`, `no-cache`, `max-age=0`, `Vary: Cookie`, HTML, attachments, errors and redirects | Never cached |
| Files over 32 MB, or media of unknown length | Streamed through without being stored |
| `Range` and `HEAD` | Answered from the cache when the whole file is there, otherwise by the site |
| Server-sent events | Passed and streamed unbuffered |
| WebSocket upgrades | Piped to the app |
| App down | Friendly 503 page; cached assets keep being served (6 h grace) |

The cache key is the URL, `Host`, scheme, `Sec-Fetch-Dest` and, when present, `Authorization`
(so with `BASIC_AUTH` a cached copy only goes to someone who knows the password). Responses
carry `X-Cache: HIT`, `MISS` or `PASS`. Varnish sets `X-Forwarded-Proto/Host` for the app and
only accepts them from a terminator on the same machine (or the PROXY protocol). Purge from the
VM itself:

```sh
curl -X PURGE http://127.0.0.1:6081/p/https://example.com/logo.png       # every variant of a URL
varnishadm -n /var/lib/varnish/x70mk2-proxy ban obj.http.X-Url '~' '^/p/https://example\.com/'
```

Proxied URLs are long, so Varnish needs bigger header limits and longer stream timeouts than its
defaults: `varnish/varnishd.params` lists them, and `scripts/start.sh`, the systemd drop-in and
`docker-compose.yml` pass them. Node.js gets `--max-http-header-size=65536` for the same reason.

**Endpoints.** `/` and `/__proxy/home` (home page), `/__proxy/go?url=...` (address box without
JavaScript), `/__proxy/health` (health check, open even with `BASIC_AUTH`), `/__proxy/client.js`,
`/__proxy/cookie` and `/__proxy/clear` (used by the runtime and the home page).

## Limitations

- **One origin for every site.** All proxied sites run on the proxy's origin, so the browser
  cannot isolate them from each other; the proxy emulates SameSite and CORS, but a hostile page
  could still script another proxied site opened in a frame or popup. Use the proxy for browsing,
  not as a security boundary, and use **Sign out everywhere** when you are done.
- **No service workers**, so offline modes and web push do not work.
- **Anti-bot and DRM.** Sites that fingerprint the connection or browser (some CAPTCHAs, bot
  challenges, banking), DRM video (Widevine), WebRTC calls and sign-in flows that forbid
  embedded or proxied browsers (Google sign-in) may refuse to work.
- **Not an anonymity tool.** Sites see the server's IP address, and whoever runs the server can
  see the traffic.
- Pages over `MAX_REWRITE_BYTES` are passed through unmodified and may escape the proxy.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "The proxy app is not running" page | Varnish is up but the app is not: check its output (`journalctl -u x70mk2-proxy`), then `scripts/start.sh`. |
| Cannot connect from another machine | Use the LAN address printed at start; open the port in the firewall and in the provider's security group; or use the SSH tunnel. |
| `address already in use` | Another program uses the port: set `PORT` / `VARNISH_PORT`, or `scripts/stop.sh`. |
| "Request blocked" | The address is on a private network or is the proxy itself. On a trusted lab network set `ALLOW_PRIVATE=1`. |
| "Untrusted certificate" | The site's certificate is not trusted by Node.js. Add the CA with `NODE_EXTRA_CA_CERTS=/path/ca.pem`. The proxy never skips verification. |
| Every site fails with DNS or connection errors | The server has no direct internet access: set `UPSTREAM_PROXY` (or `HTTPS_PROXY`). |
| A site looks broken | Reload; try **Sign out everywhere**; check the browser console. Features that need a secure context need HTTPS or `localhost` (see above). |
| Logged out after a restart | Keep `PERSIST_SESSIONS=1` and make `DATA_FILE`'s directory writable. |
| Stale asset after a site update | `curl -X PURGE http://127.0.0.1:6081/p/<url>` on the server. |
| Varnish does not start | Read its output: a port in use, or no C compiler to build the VCL (`sudo apt install gcc`). Check the VCL with `varnishd -C -f varnish/default.vcl`. |
| Debugging requests | `LOG_REQUESTS=1`; `varnishlog -n <workdir> -g request -q 'ReqURL ~ "/p/"'`. |

## Development

```sh
npm test               # unit and integration tests (node --test test/*.test.js)
npm run test:varnish   # the Varnish front end against a real varnishd (skipped if not installed)
npm run test:e2e       # browser tests with Playwright/Chromium (test/e2e)
npm run test:all       # both
NODE_ENV=development npm start   # re-read the runtime and home page on every request
```

Layout: `server.js` (HTTP server), `src/proxy.js` (request handling), `src/rewrite-*.js` (HTML,
CSS and JS rewriters), `src/cookies.js` (cookie jar and sessions), `src/upstream.js` (outbound
connections, SSRF guard, upstream proxy), `src/websocket.js`, `src/pages.js` and
`public/index.html` (home and error pages), `public/client.js` (browser runtime),
`varnish/` (VCL and parameters), `scripts/` (start/stop), `deploy/` (systemd, installer),
`Dockerfile` and `docker-compose.yml`.
