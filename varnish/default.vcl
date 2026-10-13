vcl 4.1;

# Varnish front end for the rewriting web proxy.
#
#   browser ──► Varnish :6081 ──► node server.js 127.0.0.1:8080 ──► the web
#
# * Static assets (images, fonts, stylesheets, scripts, media) go into a cache shared by all users,
#   and so does the versioned proxy runtime (/__proxy/client.js?v=...).
# * Nothing personal is ever cached or shared: documents, frames, API calls, the proxy's own
#   endpoints, and any response the app fetched with the user's cookies (X-Proxy-Private), that
#   sets a cookie, is private/no-store/no-cache or varies on Cookie.
# * Everything streams: downloads, video seeking (Range), server-sent events. WebSockets are
#   tunnelled (pipe).
# * The app learns the public scheme and host (X-Forwarded-Proto/Host) for cookies and redirects.
# * A friendly page is served while the app is down.
#
# Requires Varnish 6.6 or newer (7.x recommended). Start it with scripts/start.sh, or pass the
# runtime parameters in varnish/varnishd.params yourself: proxied URLs embed a whole target URL
# and need larger header limits than the defaults, and streams need longer timeouts.
#
# Purge every cached variant of one URL (from this machine only):
#   curl -X PURGE http://127.0.0.1:6081/p/https://example.com/logo.png
# Drop everything cached for a site:
#   varnishadm ban obj.http.X-Url '~' '^/p/https://example\.com/'

import std;
import proxy;

backend proxy_app {
    .host = "127.0.0.1";
    .port = "8080";
    .connect_timeout = 5s;
    # Longer than the app's own upstream timeout, so slow sites get the app's error page.
    .first_byte_timeout = 120s;
    .between_bytes_timeout = 120s;
    .max_connections = 1000;
    .probe = {
        .url = "/__proxy/health";
        .interval = 5s;
        .timeout = 3s;
        .window = 5;
        .threshold = 3;
        # Start healthy: the start scripts only launch Varnish once the app answers.
        .initial = 3;
    }
}

# Clients allowed to PURGE, and to pass on X-Forwarded-Proto/Host (a TLS terminator such as
# nginx, Caddy or hitch on this machine). Terminators elsewhere should use the PROXY protocol.
acl local {
    "127.0.0.1";
    "::1";
}

sub vcl_recv {
    set req.backend_hint = proxy_app;
    unset req.http.X-Cache;
    # httpoxy: never let a client-supplied Proxy header reach the app.
    unset req.http.Proxy;

    # Absolute-form request targets ("GET http://host/path"): keep only the path.
    if (req.url ~ "^[A-Za-z][A-Za-z0-9+.-]*://") {
        set req.url = regsub(req.url, "^[A-Za-z][A-Za-z0-9+.-]*://[^/]*", "");
        if (req.url == "") {
            set req.url = "/";
        }
    }

    # Public scheme and host, so the app sets Secure cookies and builds correct URLs.
    if (proxy.is_ssl()) {
        set req.http.X-Forwarded-Proto = "https";
    } else if (!(client.ip ~ local && req.http.X-Forwarded-Proto ~ "^https?$")) {
        set req.http.X-Forwarded-Proto = "http";
    }
    if (!(client.ip ~ local && req.http.X-Forwarded-Host)) {
        if (req.http.Host) {
            set req.http.X-Forwarded-Host = req.http.Host;
        } else {
            unset req.http.X-Forwarded-Host;
        }
    }

    if (req.method == "PURGE") {
        if (client.ip !~ local) {
            return (synth(403, "Forbidden"));
        }
        # A ban on the URL removes every variant (host, scheme, fetch destination) at once.
        if (std.ban("obj.http.X-Url == " + req.url)) {
            return (synth(200, "Purged"));
        }
        return (synth(400, std.ban_error()));
    }

    # WebSockets are tunnelled straight through to the app.
    if (req.http.Upgrade ~ "(?i)websocket") {
        return (pipe);
    }
    # The app is not a forward proxy.
    if (req.method == "CONNECT") {
        return (synth(405, "Method Not Allowed"));
    }
    # POST and friends (and unusual methods sites may use, e.g. WebDAV) go to the app, bodies
    # streamed.
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # The runtime script is versioned and immutable. Everything else outside /p/ is dynamic: the
    # home page, the proxy's endpoints (cookie sync, session clear) and stray root-relative URLs,
    # which the app redirects based on the Referer and the user's last site.
    if (req.url ~ "^/__proxy/client\.js\?(.*&)?v=") {
        return (hash);
    }
    if (req.url !~ "^/p/") {
        return (pass);
    }

    # Documents and frames carry the user's cookies and session, and event streams are live.
    if (req.http.Sec-Fetch-Mode == "navigate" ||
        req.http.Sec-Fetch-Dest ~ "^(document|iframe|frame|fencedframe|embed|object)$" ||
        req.http.Accept ~ "(?i)text/event-stream") {
        return (pass);
    }

    # Static assets, by fetch destination or by the extension of the target URL's path.
    if (req.http.Sec-Fetch-Dest ~ "^(image|font|style|script|worker|sharedworker|audioworklet|paintworklet|audio|video|track|manifest|xslt)$" ||
        req.url ~ "(?i)^/p/[^?#]*\.(png|jpe?g|jfif|pjpeg|gif|webp|avif|apng|svg|ico|bmp|cur|woff2?|ttf|otf|eot|css|js|mjs|map|wasm|mp4|m4v|webm|ogv|mov|mp3|m4a|aac|oga|ogg|opus|wav|flac|vtt|srt)([?#]|$)") {
        # While the app is healthy only serve copies that went stale moments ago; when it is
        # down, the whole grace period.
        if (std.healthy(req.backend_hint)) {
            set req.grace = 10s;
        }
        return (hash);
    }

    return (pass);
}

sub vcl_hash {
    hash_data(req.url);
    if (req.http.Host) {
        hash_data(req.http.Host);
    }
    hash_data(req.http.X-Forwarded-Proto);
    # The app rewrites by destination (a script request gets script treatment, for example).
    if (req.http.Sec-Fetch-Dest) {
        hash_data(req.http.Sec-Fetch-Dest);
    }
    # With BASIC_AUTH every request carries the gate's credentials: a cached copy must only ever
    # go to someone presenting the same ones, never to an unauthenticated client.
    if (req.http.Authorization) {
        hash_data(req.http.Authorization);
    }
    return (lookup);
}

sub vcl_hit {
    set req.http.X-Cache = "HIT";
}

sub vcl_miss {
    # Media seeking and HEAD are served from the cache when the whole object is there. On a
    # miss the app answers them directly instead of Varnish first downloading the whole file.
    if (req.http.Range || req.method == "HEAD") {
        set req.http.X-Cache = "PASS";
        return (pass);
    }
    set req.http.X-Cache = "MISS";
}

sub vcl_pass {
    set req.http.X-Cache = "PASS";
}

sub vcl_pipe {
    # Hop-by-hop headers are not copied by default; the app needs them for the WebSocket upgrade.
    if (req.http.Upgrade) {
        set bereq.http.Upgrade = req.http.Upgrade;
        set bereq.http.Connection = req.http.Connection;
    }
    return (pipe);
}

sub vcl_backend_fetch {
    unset bereq.http.X-Cache;
    # Event streams may stay quiet for a long time between events.
    if (bereq.http.Accept ~ "(?i)text/event-stream") {
        set bereq.between_bytes_timeout = 1h;
    }
}

sub vcl_backend_response {
    # Send bytes to the client as they arrive: big downloads, media, slow sites, event streams.
    set beresp.do_stream = true;

    # Passed requests are delivered exactly as the app sent them (no compression, which would
    # buffer event streams).
    if (bereq.uncacheable) {
        return (deliver);
    }

    # A failed refresh of a stale copy keeps the stale copy.
    if (bereq.is_bgfetch && beresp.status >= 500) {
        return (abandon);
    }

    # Lets PURGE find every variant of a URL.
    set beresp.http.X-Url = bereq.url;

    if (beresp.http.X-Proxy-Private ||
        beresp.http.Set-Cookie ||
        beresp.http.Cache-Control ~ "(?i)(^|[\s,])(private|no-store|no-cache)" ||
        beresp.http.Vary ~ "(?i)(^|[\s,])(cookie|authorization|\*)" ||
        beresp.http.Content-Type ~ "(?i)^\s*(text/html|application/xhtml|text/event-stream|multipart/)" ||
        beresp.http.Content-Disposition ~ "(?i)^\s*attachment" ||
        (beresp.status != 200 && beresp.status != 203 && beresp.status != 204 &&
         beresp.status != 300 && beresp.status != 301 && beresp.status != 308) ||
        # Big files would evict everything else; stream them through instead.
        std.integer(beresp.http.Content-Length, 0) > 33554432 ||
        (!beresp.http.Content-Length && beresp.http.Content-Type ~ "(?i)^\s*(video/|audio/|application/octet-stream)")) {
        call uncacheable;
    }

    # No freshness information: keep static assets for an hour.
    if (!(beresp.http.Cache-Control ~ "(?i)(s-maxage|max-age)") && !beresp.http.Expires) {
        set beresp.ttl = 1h;
    }
    if (beresp.ttl <= 0s) {
        call uncacheable;
    }
    # Cap how long anything stays, whatever the origin says.
    if (beresp.ttl > 7d) {
        set beresp.ttl = 7d;
    }
    # Stale copies may be served while a fresh one is fetched (or while the app is down), unless
    # the origin says otherwise.
    if (beresp.http.Cache-Control ~ "(?i)(must|proxy)-revalidate") {
        set beresp.grace = 0s;
    } else if (!(beresp.http.Cache-Control ~ "(?i)stale-while-revalidate")) {
        set beresp.grace = 6h;
    }
    # Keep validators around so expired copies are refreshed with conditional requests.
    set beresp.keep = 1d;

    # Compress text assets the app sent uncompressed.
    if (!beresp.http.Content-Encoding &&
        beresp.http.Content-Type ~ "(?i)^\s*(text/|application/([\w.+-]*(javascript|ecmascript|json|xml))|application/wasm|image/(svg\+xml|x-icon|vnd\.microsoft\.icon|bmp)|font/(ttf|otf|collection)|application/vnd\.ms-fontobject)") {
        set beresp.do_gzip = true;
    }
    return (deliver);
}

# Remember for two minutes that this URL is not cacheable (hit-for-miss): later requests go to
# the app in parallel instead of queueing, and a cacheable answer can still replace it.
sub uncacheable {
    set beresp.uncacheable = true;
    set beresp.ttl = 120s;
    set beresp.grace = 0s;
    return (deliver);
}

sub vcl_deliver {
    unset resp.http.X-Proxy-Private;
    unset resp.http.X-Url;
    unset resp.http.Via;
    unset resp.http.X-Varnish;
    if (req.http.X-Cache) {
        set resp.http.X-Cache = req.http.X-Cache;
    } else {
        set resp.http.X-Cache = "MISS";
    }
    return (deliver);
}

sub vcl_synth {
    set resp.http.Content-Type = "text/plain; charset=utf-8";
    set resp.http.Cache-Control = "no-store";
    if (resp.status == 405) {
        set resp.http.Allow = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
    }
    synthetic(resp.reason + {"
"});
    return (deliver);
}

sub vcl_backend_error {
    # A failed refresh of a stale copy keeps the stale copy.
    if (bereq.is_bgfetch) {
        return (abandon);
    }
    set beresp.ttl = 0s;
    set beresp.grace = 0s;
    set beresp.uncacheable = true;
    set beresp.http.Content-Type = "text/html; charset=utf-8";
    set beresp.http.Cache-Control = "no-store";
    set beresp.http.Retry-After = "5";
    synthetic({"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Proxy unavailable</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --text:#16181d; --muted:#5d6474; --border:#dde1ea; --accent:#3b5bdb; --accent-text:#fff; --chip:#eef1f8; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#171a21; --text:#e8eaf0; --muted:#9aa3b5; --border:#2a2f3a; --accent:#748ffc; --accent-text:#0f1115; --chip:#20242d; } }
  body { margin:0; background:var(--bg); color:var(--text); font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; display:flex; justify-content:center; padding:14vh 16px; }
  .card { max-width:560px; width:100%; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:28px; box-sizing:border-box; }
  .code { color:var(--muted); font-size:13px; font-weight:600; letter-spacing:.05em; }
  h1 { margin:4px 0 8px; font-size:22px; }
  p { color:var(--muted); margin:0 0 16px; }
  code { background:var(--chip); padding:1px 6px; border-radius:6px; }
  a { display:inline-block; text-decoration:none; padding:8px 16px; border-radius:10px; background:var(--accent); color:var(--accent-text); font-weight:600; }
</style></head>
<body><main class="card">
  <div class="code">ERROR 503</div>
  <h1>The proxy app is not running</h1>
  <p>Varnish is up, but the Node.js proxy behind it did not answer. It may be restarting; this
  page retries every few seconds.</p>
  <p>If it stays down, start it with <code>scripts/start.sh</code> (or <code>npm start</code>)
  and check its log.</p>
  <a href="">Try again</a>
</main></body></html>
"});
    return (deliver);
}
