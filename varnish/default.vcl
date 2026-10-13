vcl 4.1;

# Varnish front end for the web proxy.
#
#   browser ──► Varnish :6081 ──► node server.js :8080 ──► the internet
#
# Varnish adds a shared cache for static assets (images, fonts, scripts, stylesheets) so
# repeat visits are fast, keeps WebSockets working via pipe, and never caches anything
# personal (pages, API calls, anything fetched with the user's cookies).

import std;

backend proxy_app {
    .host = "127.0.0.1";
    .port = "8080";
    .connect_timeout = 5s;
    .first_byte_timeout = 90s;
    .between_bytes_timeout = 120s;
    .max_connections = 1000;
    .probe = {
        .url = "/__proxy/health";
        .interval = 5s;
        .timeout = 2s;
        .window = 5;
        .threshold = 3;
    }
}

acl purge_allowed {
    "127.0.0.1";
    "::1";
}

sub vcl_recv {
    set req.backend_hint = proxy_app;

    # Tell the app the public scheme/host so generated links are correct.
    if (!req.http.X-Forwarded-Proto) {
        if (std.port(server.ip) == 443 || std.port(server.ip) == 8443) {
            set req.http.X-Forwarded-Proto = "https";
        } else {
            set req.http.X-Forwarded-Proto = "http";
        }
    }
    set req.http.X-Forwarded-Host = req.http.Host;

    # PURGE a single URL from the cache:  curl -X PURGE http://localhost:6081/p/https://...
    if (req.method == "PURGE") {
        if (client.ip !~ purge_allowed) {
            return (synth(405, "Not allowed"));
        }
        return (purge);
    }

    # WebSockets are tunnelled straight through.
    if (req.http.Upgrade ~ "(?i)websocket") {
        return (pipe);
    }

    if (req.method != "GET" && req.method != "HEAD" &&
        req.method != "PUT" && req.method != "POST" && req.method != "PATCH" &&
        req.method != "DELETE" && req.method != "OPTIONS" && req.method != "TRACE") {
        return (pipe);
    }
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }

    # Proxy control endpoints (cookie sync, session clear) are always dynamic.
    # The runtime script is versioned and immutable, so it may be cached.
    if (req.url ~ "^/__proxy/" && req.url !~ "^/__proxy/client\.js") {
        return (pass);
    }

    # Streaming / long-lived responses: never buffer.
    if (req.http.Accept ~ "text/event-stream" || req.http.Range) {
        return (pass);
    }

    # Only static assets are candidates for caching. Documents and API calls depend on the
    # user's proxied cookies, so they always go to the app.
    if (req.url ~ "^/__proxy/client\.js" ||
        (req.url ~ "^/p/" &&
         (req.http.Sec-Fetch-Dest ~ "^(image|font|style|script|audio|video|track|manifest)$" ||
          req.url ~ "(?i)\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|woff2?|ttf|otf|eot|css|js|mjs|mp4|webm|mp3|ogg|wav)(\?.*)?$"))) {
        # Key the cache on URL only; the session cookie still reaches the app on a miss.
        return (hash);
    }

    return (pass);
}

sub vcl_hash {
    hash_data(req.url);
    if (req.http.Host) {
        hash_data(req.http.Host);
    }
    # Separate objects for different stream types the app might return (e.g. CSS vs HTML error).
    if (req.http.Sec-Fetch-Dest) {
        hash_data(req.http.Sec-Fetch-Dest);
    }
    return (lookup);
}

sub vcl_pipe {
    # Needed so the backend sees the upgrade request for WebSockets.
    if (req.http.Upgrade) {
        set bereq.http.Upgrade = req.http.Upgrade;
        set bereq.http.Connection = req.http.Connection;
    }
    return (pipe);
}

sub vcl_backend_response {
    # Stream everything to the client as it arrives (large downloads, media, slow sites).
    set beresp.do_stream = true;

    # Responses fetched with the user's cookies, marked personal, or setting cookies are never shared.
    if (beresp.http.X-Proxy-Private ||
        beresp.http.Set-Cookie ||
        beresp.http.Cache-Control ~ "(?i)(private|no-store|no-cache)" ||
        beresp.http.Vary ~ "(?i)(cookie|authorization|\*)" ||
        beresp.status >= 400) {
        set beresp.uncacheable = true;
        set beresp.ttl = 120s;
        return (deliver);
    }

    # Static assets without explicit freshness information: cache briefly.
    if (!beresp.http.Cache-Control && !beresp.http.Expires) {
        set beresp.ttl = 1h;
    }
    # Cap how long anything stays, regardless of what the origin says.
    if (beresp.ttl > 7d) {
        set beresp.ttl = 7d;
    }
    set beresp.grace = 6h;

    # Let Varnish compress text assets the app sent uncompressed.
    if (beresp.http.Content-Type ~ "(?i)^(text/|application/(javascript|json|xml)|image/svg)" && !beresp.http.Content-Encoding) {
        set beresp.do_gzip = true;
    }
    return (deliver);
}

sub vcl_deliver {
    unset resp.http.X-Proxy-Private;
    unset resp.http.Via;
    unset resp.http.X-Varnish;
    if (obj.hits > 0) {
        set resp.http.X-Cache = "HIT";
    } else {
        set resp.http.X-Cache = "MISS";
    }
    return (deliver);
}

sub vcl_backend_error {
    set beresp.http.Content-Type = "text/html; charset=utf-8";
    set beresp.http.Retry-After = "5";
    synthetic({"<!doctype html><html><head><meta charset="utf-8"><title>Proxy unavailable</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:14vh auto;padding:0 16px;color:#16181d}
@media (prefers-color-scheme:dark){body{background:#0f1115;color:#e8eaf0}}</style></head>
<body><h1>Proxy app is not running</h1><p>Varnish could not reach the proxy on 127.0.0.1:8080.
Start it with <code>npm start</code> and reload.</p></body></html>"});
    return (deliver);
}
