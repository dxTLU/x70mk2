'use strict';

const path = require('path');

function bool(v, dflt) {
  if (v === undefined || v === '') return dflt;
  return /^(1|true|yes|on)$/i.test(v);
}

function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}

const env = process.env;
const dataFile = env.DATA_FILE || path.join(__dirname, '..', 'data', 'sessions.json');

module.exports = {
  host: env.HOST || '0.0.0.0',
  port: int(env.PORT, 8080),
  // Path prefix under which proxied URLs live: /p/https://example.com/
  prefix: '/p/',
  // Allow proxying to localhost / private networks (off by default to prevent SSRF).
  allowPrivate: bool(env.ALLOW_PRIVATE, false),
  // Optional upstream HTTP proxy for outbound traffic (http://user:pass@host:port).
  upstreamProxy: env.UPSTREAM_PROXY || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '',
  noProxy: env.NO_PROXY || env.no_proxy || '',
  // Search engine used when the user types words instead of a URL. %s is replaced by the query.
  searchUrl: env.SEARCH_URL || 'https://duckduckgo.com/?q=%s',
  // Max response size (bytes) that will be buffered for HTML/CSS rewriting.
  maxRewriteBytes: int(env.MAX_REWRITE_BYTES, 32 * 1024 * 1024),
  // Upstream connect/header timeout in ms.
  upstreamTimeout: int(env.UPSTREAM_TIMEOUT, 30000),
  // Cookie jar persistence.
  dataFile,
  persistSessions: bool(env.PERSIST_SESSIONS, true),
  sessionTtlMs: int(env.SESSION_TTL_HOURS, 24 * 7) * 3600 * 1000,
  // Optional TLS for serving the proxy itself over HTTPS.
  tlsCert: env.TLS_CERT || '',
  tlsKey: env.TLS_KEY || '',
  // Trust X-Forwarded-Proto/Host from a fronting cache such as Varnish.
  trustProxy: bool(env.TRUST_PROXY, true),
  // Browser isolation emulation. Every proxied site shares the proxy's single origin, so the
  // server re-applies the rules the browser can no longer apply itself: SameSite cookie
  // restrictions and CORS (preflights and response checks) for cross-origin fetch/XHR.
  emulateSameSite: bool(env.EMULATE_SAMESITE, true),
  emulateCors: bool(env.EMULATE_CORS, true),
  // Show the floating navigation widget on proxied pages.
  toolbar: bool(env.TOOLBAR, true),
  // Optional HTTP Basic auth to keep the proxy private: "user:password".
  basicAuth: env.BASIC_AUTH || '',
  logRequests: bool(env.LOG_REQUESTS, false),
  // On SIGTERM/SIGINT: how long open streams, uploads and WebSockets may finish before exit.
  shutdownGraceMs: int(env.SHUTDOWN_GRACE_MS, 3000),
  // Plugins: one folder per plugin under pluginsDir (see src/plugins.js and plugins/README.md).
  pluginsEnabled: bool(env.PLUGINS_ENABLED, true),
  pluginsDir: env.PLUGINS_DIR || path.join(__dirname, '..', 'plugins'),
  // Plugin on/off state, settings and per-plugin storage. Defaults to next to the cookie jars.
  pluginDataDir: env.PLUGIN_DATA_DIR || path.dirname(dataFile),
  persistPlugins: bool(env.PERSIST_PLUGINS, true),
  // Comma-separated plugin ids switched on at startup (in addition to the saved state).
  plugins: (env.PLUGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Whether /__proxy/plugins may change anything (off: the page is read-only).
  pluginAdmin: bool(env.PLUGIN_ADMIN, true),
  pluginHookTimeoutMs: int(env.PLUGIN_HOOK_TIMEOUT, 3000),
};
