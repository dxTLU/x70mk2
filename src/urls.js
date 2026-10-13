'use strict';

const PREFIX = '/p/';
const SKIP_SCHEME = /^(?:data|blob|javascript|about|mailto|tel|sms|chrome|chrome-extension|moz-extension|intent|vbscript|filesystem|urn|magnet):/i;
const PROXIED_PATH = /^\/p\/(?:https?|wss?):\/\/?/i;

/** Convert the part of a request path after /p/ back into the real target URL. */
function decodeTarget(pathAndQuery) {
  if (!pathAndQuery.startsWith(PREFIX)) return null;
  let raw = pathAndQuery.slice(PREFIX.length);
  // Some intermediaries collapse "//" into "/"; repair "https:/host".
  raw = raw.replace(/^(https?|wss?):\/(?!\/)/i, '$1://');
  // Percent-encoded scheme (e.g. https%3A%2F%2F) from overly eager encoders.
  if (/^(https?|wss?)%3A/i.test(raw)) {
    try { raw = decodeURIComponent(raw); } catch { return null; }
  }
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!/^(https?|wss?):$/.test(url.protocol)) return null;
  if (!url.hostname) return null;
  return url;
}

/** Turn a (possibly relative) URL found in a document into a proxied path. */
function proxify(raw, base) {
  if (raw == null) return raw;
  const s = String(raw).trim();
  if (!s || s[0] === '#' || SKIP_SCHEME.test(s)) return raw;
  let abs;
  try { abs = new URL(s, base); } catch { return raw; }
  if (!/^(https?|wss?):$/.test(abs.protocol)) return raw;
  return PREFIX + abs.href;
}

function isProxiedPath(p) {
  return PROXIED_PATH.test(p);
}

module.exports = { PREFIX, SKIP_SCHEME, decodeTarget, proxify, isProxiedPath };
