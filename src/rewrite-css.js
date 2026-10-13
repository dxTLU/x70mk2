'use strict';

const { proxify, isProxiedPath } = require('./urls');

/*
 * CSS URL rewriter.
 *
 * A single-pass scanner that follows the CSS Syntax tokenizer closely enough to know where URLs
 * are: url() tokens and url("...") functions, the first string after @import, and strings
 * directly inside image-set() / src(). Comments, other strings (content: "url(x)"), look-alike
 * functions (myurl(), 5url()) and @namespace URIs are left alone, and everything that is not
 * rewritten is copied through unchanged.
 */

// Functions whose direct string arguments are image URLs.
const STRING_URL_FNS = new Set(['image-set', '-webkit-image-set', '-moz-image-set', '-o-image-set', 'src']);

// Cheap pre-check: style sheets without any of these cannot contain a URL we rewrite.
const MAYBE_URL = /url|import|image-set|src|\\/i;

const NON_ASCII = /[^\0-\x7f]/;
const NON_ASCII_ALL = /[^\0-\x7f]/gu;
// Stand-ins for non-ASCII runs while a URL is parsed: "_", lowercase letters and digits, which
// the URL parser leaves unchanged in every component (hosts are lowercased), and which cannot
// start a scheme ("é:x" is a relative path, so must its stand-in be).
const HELD = /_zq(\d+)_/g;
const HELD_ONE = /_zq\d+_/;

/** Holds a client-side template placeholder: {{x}} (Angular, Vue, Mustache), [[x]] (Polymer), ${x}. */
function isTemplate(s) {
  const pair = (open, close) => {
    const k = s.indexOf(open);
    return k !== -1 && s.indexOf(close, k + 2) !== -1;
  };
  return pair('{{', '}}') || pair('[[', ']]') || pair('${', '}');
}

/**
 * proxify() for URLs found in documents and style sheets.
 *
 * Characters outside ASCII stay as they are instead of being percent-encoded as UTF-8: the page
 * may be in a legacy encoding that the proxy passes through byte for byte (Shift_JIS, GBK,
 * windows-1251...), and left alone the browser encodes them exactly as it would have for the
 * original URL (paths and hosts as UTF-8, queries in the page's own encoding).
 *
 * URLs holding client-side template placeholders are left alone, so the framework or script
 * can still substitute them; the runtime proxies whatever URL they produce. So are URLs that
 * are proxied already (markup a page saved from its own DOM, e.g. a rich-text editor): wrapped
 * twice they would ask the site for "/p/https://...".
 */
function proxifyUrl(raw, base) {
  if (raw == null) return raw;
  const s = String(raw);
  if (isTemplate(s) || isProxiedPath(s.replace(/^[\0- ]+/, ''))) return raw;
  if (!NON_ASCII.test(s) || HELD_ONE.test(s) || HELD_ONE.test(base)) return proxify(s, base);
  const held = [];
  const masked = s.replace(/[^\0-\x7f]+/g, (m) => '_zq' + (held.push(m) - 1) + '_');
  const out = proxify(masked, base);
  if (out === masked) return raw;
  return out.replace(HELD, (m, k) => (k < held.length ? held[k] : m));
}

/**
 * Non-ASCII characters of `text` that do not appear literally in `source` (they came from an
 * escape or a character reference) are passed to `escape`; the others are kept, so bytes of a
 * legacy-encoded page round-trip unchanged and escaped characters stay escaped.
 */
function keepSourceChars(text, source, escape) {
  source = String(source || '');
  // Without a reference ("&") or an escape ("\\") every character was written literally.
  if (!NON_ASCII.test(text) || (source.indexOf('&') === -1 && source.indexOf('\\') === -1)) return text;
  let chars = null;
  return text.replace(NON_ASCII_ALL, (c) => {
    if (!chars) {
      chars = new Set();
      for (const ch of source) if (ch.charCodeAt(0) > 0x7f) chars.add(ch);
    }
    return chars.has(c) ? c : escape(c);
  });
}

function isWs(c) {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

function isNewline(c) {
  return c === 10 || c === 13 || c === 12;
}

function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
}

function isNameStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c >= 128;
}

function isName(c) {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45;
}

/** A backslash starts an escape unless a newline follows it. */
function validEscape(s, i) {
  return s.charCodeAt(i) === 92 && !isNewline(s.charCodeAt(i + 1));
}

function startsIdent(s, i) {
  const c = s.charCodeAt(i);
  if (c === 45) {
    const d = s.charCodeAt(i + 1);
    return isNameStart(d) || d === 45 || validEscape(s, i + 1);
  }
  return isNameStart(c) || validEscape(s, i);
}

let escEnd = 0;
/** Decode the escape whose backslash is at i - 1; sets escEnd to the index after it. */
function readEscape(s, i) {
  const n = s.length;
  if (i >= n) {
    escEnd = n;
    return '\ufffd';
  }
  if (isHex(s.charCodeAt(i))) {
    let j = i + 1;
    while (j < n && j < i + 6 && isHex(s.charCodeAt(j))) j++;
    const cp = parseInt(s.slice(i, j), 16);
    if (s.charCodeAt(j) === 13 && s.charCodeAt(j + 1) === 10) j += 2;
    else if (isWs(s.charCodeAt(j))) j++;
    escEnd = j;
    return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\ufffd' : String.fromCodePoint(cp);
  }
  const cp = s.codePointAt(i);
  escEnd = i + (cp > 0xffff ? 2 : 1);
  return String.fromCodePoint(cp);
}

let tokEnd = 0;
let tokOk = true;

/** Read an identifier starting at i; sets tokEnd. */
function readName(s, i) {
  const n = s.length;
  let name = '';
  let start = i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (isName(c)) {
      i++;
    } else if (c === 92 && validEscape(s, i)) {
      name += s.slice(start, i) + readEscape(s, i + 1);
      i = start = escEnd;
    } else {
      break;
    }
  }
  tokEnd = i;
  return name + s.slice(start, i);
}

/** Read the string whose opening quote is at i; sets tokEnd, and tokOk = false for a bad string. */
function readString(s, i) {
  const n = s.length;
  const q = s.charCodeAt(i);
  let value = '';
  let start = ++i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === q) {
      tokEnd = i + 1;
      tokOk = true;
      return value + s.slice(start, i);
    }
    if (isNewline(c)) break; // bad string: the newline is not part of it
    if (c === 92) {
      value += s.slice(start, i);
      const d = s.charCodeAt(i + 1);
      if (i + 1 >= n) {
        i++;
      } else if (isNewline(d)) {
        i += d === 13 && s.charCodeAt(i + 2) === 10 ? 3 : 2; // line continuation
      } else {
        value += readEscape(s, i + 1);
        i = escEnd;
      }
      start = i;
      continue;
    }
    i++;
  }
  tokEnd = i;
  tokOk = i >= n; // end of input closes a string; a newline breaks it
  return value + s.slice(start, i);
}

/** Skip the rest of a malformed url( token, honouring escapes. */
function skipBadUrl(s, i) {
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 41) return i + 1;
    if (c === 92 && validEscape(s, i)) {
      readEscape(s, i + 1);
      i = escEnd;
    } else {
      i++;
    }
  }
  return n;
}

/** Read an unquoted url( token body starting at i (after leading whitespace); sets tokEnd/tokOk. */
function readUrl(s, i) {
  const n = s.length;
  let value = '';
  let start = i;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 41) {
      tokEnd = i + 1;
      tokOk = true;
      return value + s.slice(start, i);
    }
    if (isWs(c)) {
      value += s.slice(start, i);
      while (i < n && isWs(s.charCodeAt(i))) i++;
      if (i >= n || s.charCodeAt(i) === 41) {
        tokEnd = i >= n ? n : i + 1;
        tokOk = true;
        return value;
      }
      break;
    }
    if (c === 34 || c === 39 || c === 40 || c <= 8 || c === 11 || (c >= 14 && c <= 31) || c === 127) break;
    if (c === 92) {
      if (!validEscape(s, i)) break;
      value += s.slice(start, i) + readEscape(s, i + 1);
      i = start = escEnd;
      continue;
    }
    i++;
  }
  if (i >= n) {
    tokEnd = n;
    tokOk = true; // end of input closes the token
    return value + s.slice(start, i);
  }
  tokEnd = skipBadUrl(s, i);
  tokOk = false;
  return '';
}

const cssEscape = (c) => '\\' + c.codePointAt(0).toString(16) + ' ';

/** A CSS string for a rewritten URL; `source` is the token it replaces (see keepSourceChars). */
function quote(url, source) {
  const s = url.replace(/["\\\n\r\f]/g, (c) => (c === '"' || c === '\\' ? '\\' + c : cssEscape(c)));
  return '"' + keepSourceChars(s, source, cssEscape) + '"';
}

/**
 * Rewrite every URL in a style sheet (or a style attribute / declaration list) so it points back
 * through the proxy. Relative URLs resolve against `base`.
 * @param {string} css
 * @param {string} base
 * @returns {string}
 */
function rewriteCss(css, base) {
  if (!css || !MAYBE_URL.test(css)) return css;
  const n = css.length;
  let out = '';
  let last = 0;
  let i = 0;
  const fns = []; // open function / parenthesis names ('' for a plain parenthesis)
  // Prelude state of the at-rule being read: 'import' until its URL has been seen, 'namespace'
  // (whose URIs are identifiers, never fetched), or ''.
  let atRule = '';

  const urlFor = (raw) => {
    if (atRule === 'namespace') return null;
    const p = proxifyUrl(raw, base);
    return p == null || p === raw ? null : p;
  };
  const replace = (from, to, text) => {
    out += css.slice(last, from) + text;
    last = to;
  };

  while (i < n) {
    const c = css.charCodeAt(i);

    if (c === 47 && css.charCodeAt(i + 1) === 42) {
      const e = css.indexOf('*/', i + 2);
      i = e === -1 ? n : e + 2;
      continue;
    }

    if (c === 34 || c === 39) {
      const start = i;
      const value = readString(css, i);
      i = tokEnd;
      const fn = fns.length ? fns[fns.length - 1] : null;
      const isUrl = fn === null ? atRule === 'import' : fn === 'url' || STRING_URL_FNS.has(fn);
      if (isUrl && tokOk) {
        const p = urlFor(value);
        if (p) replace(start, i, quote(p, css.slice(start, i)));
      }
      if (fn === 'url') fns[fns.length - 1] = 'url-done';
      if (atRule === 'import' && (fn === null || fn === 'url')) atRule = 'imported';
      continue;
    }

    if (c === 64 /* @ */) {
      if (startsIdent(css, i + 1)) {
        const kw = readName(css, i + 1).toLowerCase();
        i = tokEnd;
        atRule = kw === 'import' || kw === 'namespace' ? kw : '';
      } else {
        i++;
      }
      continue;
    }

    if (c === 59 || c === 123 || c === 125) { // ; { }
      atRule = '';
      if (c !== 59) fns.length = 0;
      i++;
      continue;
    }

    if (c === 40) {
      fns.push('');
      i++;
      continue;
    }

    if (c === 41) {
      fns.pop();
      i++;
      continue;
    }

    if ((c >= 48 && c <= 57) || c === 35) {
      // Numbers / dimensions (5url) and hashes (#url) are never function names.
      i++;
      while (i < n) {
        const d = css.charCodeAt(i);
        if (isName(d)) i++;
        else if (d === 92 && validEscape(css, i)) { readEscape(css, i + 1); i = escEnd; }
        else break;
      }
      continue;
    }

    if ((isNameStart(c) || c === 45 || c === 92) && startsIdent(css, i)) {
      const start = i;
      const name = readName(css, i).toLowerCase();
      i = tokEnd;
      if (css.charCodeAt(i) !== 40) continue;
      i++;
      if (name !== 'url') {
        fns.push(name);
        continue;
      }
      let j = i;
      while (j < n && isWs(css.charCodeAt(j))) j++;
      const q = css.charCodeAt(j);
      if (q === 34 || q === 39) {
        // url("...") is an ordinary function whose string argument is the URL.
        fns.push('url');
        i = j;
        continue;
      }
      const value = readUrl(css, j);
      i = tokEnd;
      if (tokOk && value) {
        const p = urlFor(value);
        if (p) replace(start, i, 'url(' + quote(p, css.slice(start, i)) + ')');
      }
      if (atRule === 'import') atRule = 'imported';
      continue;
    }

    i++;
  }

  return last === 0 ? css : out + css.slice(last);
}

module.exports = { rewriteCss, proxifyUrl, keepSourceChars };
