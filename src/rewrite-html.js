'use strict';

const { PREFIX, proxify } = require('./urls');
const { rewriteCss } = require('./rewrite-css');
const { rewriteJs, rewriteScript, GUARD } = require('./rewrite-js');

/*
 * HTML / XHTML / SVG rewriter.
 *
 * A single-pass tokenizer that follows the WHATWG tokenizer wherever it decides where URLs are:
 * attribute syntax, character references (full named table, legacy attribute rule), comments
 * (including the endings browsers accept: <!-->, --!>), raw text elements (with the <script>
 * escape states), foreign content (inline SVG / MathML honour self-closing tags and CDATA) and
 * <base>. Only attributes and elements that are rewritten change; everything else is copied
 * through byte for byte.
 */

// <script type> values browsers execute as script, plus in-browser transpiler types whose output
// is evaluated as page script.
const JS_TYPES = new Set([
  '', 'module', 'text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript',
  'application/ecmascript', 'application/x-ecmascript', 'text/x-ecmascript', 'text/x-javascript', 'text/jscript',
  'text/livescript', 'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3',
  'text/javascript1.4', 'text/javascript1.5', 'text/babel', 'text/jsx',
]);

// HTML elements whose content is not markup (with scripting enabled), and what it holds.
const RAW_TEXT = {
  script: 'script', style: 'css', noscript: 'html', plaintext: 'text', title: 'text', textarea: 'text',
  xmp: 'text', iframe: 'text', noembed: 'text', noframes: 'text',
};

const VOID = new Set([
  'area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// HTML start tags that close any open SVG / MathML elements.
const BREAKOUT = new Set([
  'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre',
  'ruby', 's', 'small', 'span', 'strong', 'strike', 'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
]);

// Attributes holding one URL that is fetched or navigated to.
const URL_ATTRS = new Set([
  'src', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'longdesc', 'lowsrc', 'dynsrc',
  'manifest', 'icon', 'codebase',
]);
// Attributes holding whitespace-separated URLs.
const URL_LIST_ATTRS = new Set(['ping', 'archive', 'attributionsrc']);
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
// SVG presentation attributes that can reference another document with url().
const CSS_URL_ATTRS = new Set(['fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
// Attributes that would break a rewritten / re-hosted page.
const DROP_ATTRS = new Set(['integrity', 'referrerpolicy']);
const HANDLER = /^on[a-z]+$/;

// Recursion limits for nested documents (srcdoc) and nested fragments (noscript, conditional comments).
const MAX_SRCDOC_DEPTH = 8;
const MAX_FRAGMENT_DEPTH = 3;
// Browsers limit tree depth too; this keeps end-tag matching cheap on hostile input.
const MAX_STACK = 512;

const NON_WS = /[^\t\n\f\r ]/;

// Script text in SVG / XML is parsed as XML: keep the guard well-formed whatever it contains.
const XML_GUARD = /[<&]/.test(GUARD) ? '<![CDATA[' + GUARD + ']]>' : GUARD;

function isWs(c) {
  return c === 32 || c === 10 || c === 9 || c === 13 || c === 12;
}

function isAlpha(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
}

function isTagEnd(c) {
  return isWs(c) || c === 47 || c === 62;
}

// ---------------------------------------------------------------------------------------
// Character references

// Numeric references to C1 controls mean the windows-1252 character (0 = keep the code point).
const C1 = [
  0x20ac, 0, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0, 0x017d, 0,
  0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0, 0x017e, 0x0178,
];

// Named references browsers also accept without the trailing semicolon.
const LEGACY = new Set(`
AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute Ecirc Egrave Euml GT Iacute
Icirc Igrave Iuml LT Ntilde Oacute Ocirc Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc
Ugrave Uuml Yacute aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil cedil cent
copy curren deg divide eacute ecirc egrave eth euml frac12 frac14 frac34 gt iacute icirc iexcl
igrave iquest iuml laquo lt macr micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash
otilde ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig thorn times uacute ucirc
ugrave uml uuml yacute yen yuml
`.trim().split(/\s+/));

let entityMap = null;
function entities() {
  if (entityMap) return entityMap;
  entityMap = new Map([['Tab', '\t'], ['NewLine', '\n']]);
  for (const entry of ENTITY_DATA.split(/[ \n]+/)) {
    const k = entry.indexOf(':');
    if (k > 0) entityMap.set(entry.slice(0, k), entry.slice(k + 1));
  }
  return entityMap;
}

function numericRef(cp) {
  if (!(cp > 0) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
  if (cp >= 0x80 && cp <= 0x9f && C1[cp - 0x80]) return String.fromCharCode(C1[cp - 0x80]);
  return String.fromCodePoint(cp);
}

const CHAR_REF = /&(?:#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?|([a-zA-Z][a-zA-Z0-9]*)(;?))/g;

/**
 * Decode character references the way the HTML tokenizer does.
 * @param {string} s
 * @param {boolean} [inAttribute=true] apply the attribute-value rule that keeps legacy references
 *   without a semicolon literal when an alphanumeric or "=" follows (so "?a=1&copy=2" survives)
 */
function decodeEntities(s, inAttribute = true) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(CHAR_REF, (m, hex, dec, name, semi, offset) => {
    if (name === undefined) return numericRef(hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10));
    const table = entities();
    if (semi) {
      const v = table.get(name);
      if (v !== undefined) return v;
    }
    // Longest prefix that is a legacy (semicolon-less) reference.
    for (let k = Math.min(name.length, 6); k >= 2; k--) {
      const pre = k === name.length ? name : name.slice(0, k);
      if (!LEGACY.has(pre)) continue;
      if (k < name.length) return inAttribute ? m : table.get(pre) + name.slice(k) + semi;
      if (inAttribute && s.charCodeAt(offset + m.length) === 61) return m;
      return table.get(pre);
    }
    return m;
  });
}

const ATTR_ESCAPES = { '&': '&amp;', '"': '&quot;', '<': '&lt;', '\t': '&#9;', '\n': '&#10;', '\r': '&#13;' };

// For a double-quoted attribute. "<" and whitespace are escaped so XML parsers (SVG, XHTML) read
// the value back unchanged; characters outside Latin-1 become references so the value survives
// pages the proxy re-encodes byte for byte.
const NEEDS_ESCAPE = /[&"<\t\n\r\u0100-\uffff]/;

function escapeAttr(s) {
  s = String(s);
  if (!NEEDS_ESCAPE.test(s)) return s;
  return s.replace(/[&"<\t\n\r]|[^\0-\xff]/gu, (c) => ATTR_ESCAPES[c] || '&#' + c.codePointAt(0) + ';');
}

// ---------------------------------------------------------------------------------------
// Attribute value rewriters

/** Rewrite every candidate URL in a srcset / imagesrcset value. */
function rewriteSrcset(value, base) {
  const out = [];
  const n = value.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isWs(value.charCodeAt(i)) || value.charCodeAt(i) === 44)) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !isWs(value.charCodeAt(i))) i++;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      let depth = 0;
      for (; i < n; i++) {
        const c = value.charCodeAt(i);
        if (c === 40) depth++;
        else if (c === 41) depth--;
        else if (c === 44 && depth <= 0) break;
      }
      descriptor = value.slice(start, i).trim();
    }
    if (url) out.push(proxify(url, base) + (descriptor ? ' ' + descriptor : ''));
  }
  return out.join(', ');
}

/** <meta http-equiv=refresh content>, parsed like the HTML "shared declarative refresh steps". */
function rewriteRefresh(content, base) {
  const n = content.length;
  const skipWs = (k) => {
    while (k < n && isWs(content.charCodeAt(k))) k++;
    return k;
  };
  let i = skipWs(0);
  const t0 = i;
  while (i < n && content.charCodeAt(i) >= 48 && content.charCodeAt(i) <= 57) i++;
  if (i === t0 && content.charCodeAt(i) !== 46) return content;
  while (i < n && ((content.charCodeAt(i) >= 48 && content.charCodeAt(i) <= 57) || content.charCodeAt(i) === 46)) i++;
  if (i >= n) return content;
  let c = content.charCodeAt(i);
  if (c !== 59 && c !== 44 && !isWs(c)) return content;
  i = skipWs(i);
  c = content.charCodeAt(i);
  if (c === 59 || c === 44) i = skipWs(i + 1);
  if (i >= n) return content;

  let start = i;
  let quotes = true;
  if ((content.charCodeAt(i) | 32) === 117) { // u
    if ((content.charCodeAt(i + 1) | 32) === 114 && (content.charCodeAt(i + 2) | 32) === 108) { // r l
      const j = skipWs(i + 3);
      if (content.charCodeAt(j) === 61) start = skipWs(j + 1);
      else quotes = false;
    } else {
      quotes = false;
    }
  }
  let end = n;
  if (quotes) {
    const q = content.charCodeAt(start);
    if (q === 34 || q === 39) {
      start++;
      const k = content.indexOf(String.fromCharCode(q), start);
      if (k !== -1) end = k;
    }
  }
  const url = content.slice(start, end);
  const p = proxify(url, base);
  if (!url.trim() || p === url) return content;
  return content.slice(0, start) + p + content.slice(end);
}

// JSON placed back inside <script> must not be able to close the element.
function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const URL_LIKE = /^(?:\.{0,2}\/|[a-z][a-z0-9+.-]*:)/i;

function rewriteImportMap(json, base) {
  let map;
  try { map = JSON.parse(json); } catch { return json; }
  if (!map || typeof map !== 'object' || Array.isArray(map)) return json;
  const fix = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
    const res = {};
    for (const [k, v] of Object.entries(obj)) {
      res[URL_LIKE.test(k) ? proxify(k, base) : k] = typeof v === 'string' && URL_LIKE.test(v) ? proxify(v, base) : v;
    }
    return res;
  };
  if (map.imports) map.imports = fix(map.imports);
  if (map.scopes && typeof map.scopes === 'object') {
    const scopes = {};
    for (const [k, v] of Object.entries(map.scopes)) scopes[proxify(k, base)] = fix(v);
    map.scopes = scopes;
  }
  // The proxy rewrites scripts, so their hashes would no longer match.
  delete map.integrity;
  return scriptJson(map);
}

function escapeUrlPattern(s) {
  return s.replace(/[\\:*?+(){}]/g, '\\$&');
}

/**
 * Speculation rules: proxy the URL lists and map href_matches patterns onto proxied URLs, so
 * exclusions such as "/wp-login.php*" keep excluding (prefetching a logout link logs users out).
 */
function rewriteSpeculationRules(json, base) {
  let rules;
  let origin;
  try {
    rules = JSON.parse(json);
    origin = new URL(base).origin;
  } catch {
    return json;
  }
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) return json;
  const prefix = PREFIX + escapeUrlPattern(origin);
  const pattern = (p) => {
    if (typeof p === 'string') {
      if (p[0] === '/' && p[1] !== '/') return prefix + p;
      const m = /^(https?:\/\/[^/?#*:(){}+\\]+(?::\d+)?)(\/.*)$/i.exec(p);
      return m ? PREFIX + escapeUrlPattern(m[1].toLowerCase()) + m[2] : p;
    }
    if (p && typeof p === 'object' && typeof p.pathname === 'string' && p.pathname[0] === '/' &&
        !('protocol' in p) && !('hostname' in p) && !('port' in p) && !('baseURL' in p)) {
      return { ...p, pathname: prefix + p.pathname };
    }
    return p;
  };
  const walk = (cond) => {
    if (!cond || typeof cond !== 'object') return;
    if (Array.isArray(cond)) {
      cond.forEach(walk);
      return;
    }
    if ('href_matches' in cond) {
      cond.href_matches = Array.isArray(cond.href_matches) ? cond.href_matches.map(pattern) : pattern(cond.href_matches);
    }
    for (const k of ['and', 'or', 'not']) if (k in cond) walk(cond[k]);
  };
  for (const list of Object.values(rules)) {
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (!rule || typeof rule !== 'object') continue;
      if (Array.isArray(rule.urls)) rule.urls = rule.urls.map((u) => (typeof u === 'string' ? proxify(u, base) : u));
      if (rule.where) walk(rule.where);
    }
  }
  return scriptJson(rules);
}

// A rewriter failing on one odd script or style sheet must not cost the whole page its rewriting.
function safe(fn, input, ...args) {
  try {
    return fn(input, ...args);
  } catch {
    return input;
  }
}

function isJavascriptUrl(v) {
  const colon = v.indexOf(':');
  if (colon < 10) return false;
  return /^[\0- ]*javascript$/i.test(v.slice(0, colon).replace(/[\t\n\r]/g, ''));
}

// ---------------------------------------------------------------------------------------
// Tokenizer helpers

/** Case-insensitive compare of `name` (lowercase) at html[p]. */
function nameAt(html, p, name) {
  for (let k = 0; k < name.length; k++) {
    let c = html.charCodeAt(p + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== name.charCodeAt(k)) return false;
  }
  return true;
}

/** Index of the end tag that closes a raw text element, or the end of input. */
function rawTextEnd(html, from, name) {
  for (let i = from; ;) {
    const p = html.indexOf('</', i);
    if (p === -1) return html.length;
    if (nameAt(html, p + 2, name) && isTagEnd(html.charCodeAt(p + 2 + name.length))) return p;
    i = p + 2;
  }
}

/**
 * End of <script> content, following the script data escape states: after "<!--", a "<script"
 * makes the next "</script>" part of the content (document.write('<!--<script>...</script>-->')).
 */
function scriptEnd(html, from) {
  const n = html.length;
  let i = from;
  for (;;) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return n;
    if (html.charCodeAt(lt + 1) === 47 && nameAt(html, lt + 2, 'script') && isTagEnd(html.charCodeAt(lt + 8))) return lt;
    if (!html.startsWith('<!--', lt)) {
      i = lt + 1;
      continue;
    }
    // Escaped state; "-->" (which may overlap the "<!--": "<!-->") goes back to script data.
    const dash = html.indexOf('-->', lt + 2);
    let doubleEscaped = false;
    let j = lt + 4;
    for (;;) {
      const l2 = html.indexOf('<', j);
      if (dash !== -1 && (l2 === -1 || dash < l2)) {
        i = dash + 3;
        break;
      }
      if (l2 === -1) return n;
      if (html.charCodeAt(l2 + 1) === 47) {
        if (nameAt(html, l2 + 2, 'script') && isTagEnd(html.charCodeAt(l2 + 8))) {
          if (!doubleEscaped) return l2;
          doubleEscaped = false;
        }
      } else if (!doubleEscaped && nameAt(html, l2 + 1, 'script') && isTagEnd(html.charCodeAt(l2 + 7))) {
        doubleEscaped = true;
      }
      j = l2 + 1;
    }
  }
}

/** True when html[from, to) holds no markup other than CDATA sections. */
function isPlainText(html, from, to) {
  let i = html.indexOf('<', from);
  while (i !== -1 && i < to) {
    if (html.startsWith('<![CDATA[', i)) {
      const e = html.indexOf(']]>', i + 9);
      if (e === -1 || e + 3 > to) return false;
      i = html.indexOf('<', e + 3);
      continue;
    }
    const c = html.charCodeAt(i + 1);
    if (isAlpha(c) || c === 47 || c === 33 || c === 63) return false;
    i = html.indexOf('<', i + 1);
  }
  return true;
}

const COMMENT_END = /--!?>/g;

/** End of a comment whose "<!--" ends at p; returns [contentEnd, end]. */
function commentEnd(html, p) {
  if (html.charCodeAt(p) === 62) return [p, p + 1]; // <!-->
  if (html.charCodeAt(p) === 45 && html.charCodeAt(p + 1) === 62) return [p, p + 2]; // <!--->
  COMMENT_END.lastIndex = p;
  const m = COMMENT_END.exec(html);
  return m ? [m.index, m.index + m[0].length] : [html.length, html.length];
}

/** End of a <!DOCTYPE ...>, skipping an XML internal subset ([ ... ]) if there is one. */
function doctypeEnd(html, lt) {
  const n = html.length;
  const gt = html.indexOf('>', lt);
  if (gt === -1) return n;
  const br = html.indexOf('[', lt);
  if (br === -1 || br > gt) return gt + 1;
  for (let i = br + 1; i < n;) {
    const c = html.charCodeAt(i);
    if (c === 34 || c === 39) {
      const q = html.indexOf(c === 34 ? '"' : "'", i + 1);
      if (q === -1) break;
      i = q + 1;
    } else if (c === 60 && html.startsWith('<!--', i)) {
      const e = html.indexOf('-->', i + 4);
      if (e === -1) break;
      i = e + 3;
    } else if (c === 93) {
      let k = i + 1;
      while (k < n && isWs(html.charCodeAt(k))) k++;
      if (html.charCodeAt(k) === 62) return k + 1;
      i = k;
    } else {
      i++;
    }
  }
  return gt + 1;
}

/**
 * Parse the attributes of a tag whose name ends at i, following the tokenizer's attribute states.
 * Returns { attrs: [{name, raw, value, start, nameStart, end}], end, selfClosing, eof }.
 * `start` includes the whitespace (and stray "/") before the attribute.
 */
function parseAttrs(html, i) {
  const n = html.length;
  const attrs = [];
  for (;;) {
    const start = i;
    let c = html.charCodeAt(i);
    while (isWs(c) || c === 47) {
      if (c === 47 && html.charCodeAt(i + 1) === 62) return { attrs, end: i + 2, selfClosing: true, eof: false };
      c = html.charCodeAt(++i);
    }
    if (i >= n) return { attrs, end: n, selfClosing: false, eof: true };
    if (c === 62) return { attrs, end: i + 1, selfClosing: false, eof: false };
    // The first character always belongs to the name, even "=" ('<a =x>' has an attribute "=x").
    const nameStart = i++;
    while (i < n) {
      c = html.charCodeAt(i);
      if (isWs(c) || c === 47 || c === 62 || c === 61) break;
      i++;
    }
    const nameEnd = i;
    let j = i;
    while (isWs(html.charCodeAt(j))) j++;
    let value = null;
    if (html.charCodeAt(j) === 61) {
      j++;
      while (isWs(html.charCodeAt(j))) j++;
      const q = html.charCodeAt(j);
      if (q === 34 || q === 39) {
        const close = html.indexOf(q === 34 ? '"' : "'", j + 1);
        if (close === -1) return { attrs, end: n, selfClosing: false, eof: true };
        value = html.slice(j + 1, close);
        i = close + 1;
      } else {
        const vs = j;
        while (j < n) {
          c = html.charCodeAt(j);
          if (isWs(c) || c === 62) break;
          j++;
        }
        value = html.slice(vs, j);
        i = j;
      }
    }
    const raw = html.slice(nameStart, nameEnd);
    attrs.push({ name: raw.toLowerCase(), raw, value, start, nameStart, end: i });
  }
}

function attrValue(attrs, name) {
  for (const a of attrs) if (a.name === name) return a.value == null ? '' : decodeEntities(a.value);
  return null;
}

function scriptKind(attrs) {
  let type = attrValue(attrs, 'type');
  if (type === null) {
    const lang = attrValue(attrs, 'language');
    type = lang ? 'text/' + lang : '';
  }
  type = type.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
  if (type === 'importmap' || type === 'speculationrules') return type;
  return JS_TYPES.has(type.split(';')[0].trim()) ? 'js' : null;
}

// Hyperlink-ish URLs are resolved when followed, so a <base> later in the document applies to them.
function isLazy(tag, attr) {
  if (attr === 'href') return tag === 'a' || tag === 'area';
  return (attr === 'action' && tag === 'form') || attr === 'formaction' || attr === 'ping';
}

// ---------------------------------------------------------------------------------------

/**
 * One pass over a document or fragment.
 * @param {string} html
 * @param {string} pageUrl the document URL (fragments: the base in effect where they sit)
 * @param {object} o internal options: inject (markup for this run), docInject (for nested
 *   documents), xml, runtime (the page has the client runtime), depth, fragment
 * @param {string|null} linkBase base for lazily resolved URLs, when known in advance
 * @returns {{out: string, base: string, lazyBeforeBase: boolean}}
 */
function run(html, pageUrl, o, linkBase) {
  const n = html.length;
  // Output is the input with replacements spliced in; unchanged stretches are copied in bulk.
  const parts = [];
  let copied = 0;
  const splice = (from, to, text) => {
    if (from > copied) parts.push(html.slice(copied, from));
    if (text) parts.push(text);
    copied = to;
  };
  let i = 0;
  let injected = !o.inject;
  let base = pageUrl;
  let baseSeen = o.fragment;
  let lazyBeforeBase = false;
  // Open SVG / MathML elements, and HTML elements inside their HTML integration points.
  const stack = [];

  const inject = (at) => {
    if (!injected) {
      splice(at, at, o.inject);
      injected = true;
    }
  };
  const jsCode = (code) => {
    const js = safe(rewriteJs, code);
    return js === code || o.runtime ? js : GUARD + js;
  };
  const top = () => stack[stack.length - 1];
  const inForeign = () => stack.length > 0 && top().ns !== 'html' && !top().ip;
  const nested = (content, docBase) =>
    run(content, docBase, { ...o, inject: '', depth: o.depth + 1, fragment: true }, linkBase || base);

  function rewriteAttr(at, tag, refresh) {
    const ln = at.name;
    if (DROP_ATTRS.has(ln)) return '';
    if (at.value === null) return undefined;
    let kind = 0;
    if (URL_ATTRS.has(ln) || (ln === 'data' && tag === 'object')) kind = 1;
    else if (SRCSET_ATTRS.has(ln)) kind = 2;
    else if (ln === 'style') kind = 3;
    else if (ln.charCodeAt(0) === 111 && ln.charCodeAt(1) === 110 && HANDLER.test(ln)) kind = 4; // on*
    else if (URL_LIST_ATTRS.has(ln)) kind = 5;
    else if (ln === 'srcdoc') kind = 6;
    else if (ln === 'content' && refresh) kind = 7;
    else if (ln === 'rel') kind = 8;
    else if (CSS_URL_ATTRS.has(ln)) kind = 9;
    else return undefined;

    const v = decodeEntities(at.value);
    let nv = v;
    switch (kind) {
      case 1:
        if (isJavascriptUrl(v)) {
          const colon = v.indexOf(':') + 1;
          nv = v.slice(0, colon) + jsCode(v.slice(colon));
        } else if (tag === 'base' && ln === 'href') {
          nv = proxify(v, pageUrl);
        } else if (isLazy(tag, ln)) {
          nv = proxify(v, linkBase || base);
          if (!baseSeen && nv !== v) lazyBeforeBase = true;
        } else {
          nv = proxify(v, base);
        }
        break;
      case 2:
        nv = rewriteSrcset(v, base);
        break;
      case 3:
        nv = safe(rewriteCss, v, base);
        break;
      case 4:
        nv = jsCode(v);
        break;
      case 5: {
        const lazy = isLazy(tag, ln);
        const b = lazy ? linkBase || base : base;
        nv = v.replace(/[^\t\n\f\r ]+/g, (u) => proxify(u, b));
        if (lazy && !baseSeen && nv !== v) lazyBeforeBase = true;
        break;
      }
      case 6:
        if (o.depth < MAX_SRCDOC_DEPTH) {
          const inject = o.docInject;
          nv = rewriteDocument(v, base, { inject, docInject: inject, xml: false, runtime: Boolean(inject), depth: o.depth + 1, fragment: false });
        }
        break;
      case 7:
        nv = rewriteRefresh(v, base);
        break;
      case 8:
        if (/noreferrer/i.test(v)) nv = v.split(/[\t\n\f\r ]+/).filter((t) => t && t.toLowerCase() !== 'noreferrer').join(' ');
        break;
      case 9:
        if (/url\(/i.test(v)) nv = safe(rewriteCss, v, base);
        break;
    }
    if (nv === v) return undefined;
    return (at.nameStart > at.start ? html.slice(at.start, at.nameStart) : ' ') + at.raw + '="' + escapeAttr(nv) + '"';
  }

  function startTag(lt) {
    let j = lt + 1;
    while (j < n && !isTagEnd(html.charCodeAt(j))) j++;
    const name = html.slice(lt + 1, j).toLowerCase();
    const t = parseAttrs(html, j);
    if (t.eof) {
      // Browsers drop a tag cut off by the end of the input.
      inject(lt);
      return n;
    }
    const { attrs, selfClosing } = t;

    // Namespace: HTML, SVG / MathML (foreign content) or XML (every element behaves like foreign).
    let ns;
    if (o.xml) {
      ns = 'xml';
    } else {
      if (inForeign() && (BREAKOUT.has(name) || (name === 'font' && attrs.some((a) => a.name === 'color' || a.name === 'face' || a.name === 'size')))) {
        while (inForeign()) stack.pop();
      }
      if (inForeign()) ns = top().ns === 'math' && top().name === 'annotation-xml' && name === 'svg' ? 'svg' : top().ns;
      else ns = name === 'svg' ? 'svg' : name === 'math' ? 'math' : 'html';
      if (!selfClosing || ns === 'html') {
        if (ns !== 'html') {
          const ip = ns === 'svg'
            ? name === 'foreignobject' || name === 'desc' || name === 'title'
            : name === 'mi' || name === 'mo' || name === 'mn' || name === 'ms' || name === 'mtext' ||
              (name === 'annotation-xml' && /^(text\/html|application\/xhtml\+xml)$/i.test((attrValue(attrs, 'encoding') || '').trim()));
          if (stack.length < MAX_STACK) stack.push({ name, ns, ip });
        } else if (stack.length && !VOID.has(name) && !RAW_TEXT[name] && stack.length < MAX_STACK) {
          stack.push({ name, ns, ip: false });
        }
      }
    }
    const isHtml = ns === 'html' || ns === 'xml';

    // The runtime goes before the first thing that could run or render, but after a charset <meta>.
    if (!injected && name !== 'html' && name !== 'head' &&
        !(name === 'meta' && attrs.some((a) => a.name === 'charset' || (a.name === 'http-equiv' && /^\s*content-type\s*$/i.test(decodeEntities(a.value || '')))))) {
      inject(lt);
    }

    let drop = false;
    let refresh = false;
    if (name === 'meta' && isHtml) {
      const equiv = (attrValue(attrs, 'http-equiv') || '').trim().toLowerCase();
      const metaName = (attrValue(attrs, 'name') || '').trim().toLowerCase();
      drop = equiv === 'content-security-policy' || equiv === 'content-security-policy-report-only' || equiv === 'x-frame-options' || metaName === 'referrer';
      refresh = equiv === 'refresh';
    }

    if (drop) {
      splice(lt, t.end, '');
    } else {
      for (const at of attrs) {
        const r = rewriteAttr(at, name, refresh);
        if (r !== undefined) splice(at.start, at.end, r);
      }
    }
    let i2 = t.end;

    if (name === 'base' && isHtml && !baseSeen) {
      const href = attrValue(attrs, 'href');
      if (href !== null) {
        baseSeen = true;
        try {
          const u = new URL(href.replace(/^[\0- ]+|[\0- ]+$/g, ''), pageUrl);
          if (u.protocol === 'http:' || u.protocol === 'https:') base = u.href;
        } catch { /* invalid: the document URL stays the base */ }
      }
    }

    // Element content that is not markup.
    let kind = null;
    let stop;
    if (ns === 'html') {
      kind = RAW_TEXT[name] || null;
      if (kind === 'script') stop = scriptEnd(html, i2);
      else if (name === 'plaintext') stop = n;
      else if (kind) stop = rawTextEnd(html, i2, name);
    } else if ((name === 'script' || name === 'style') && !selfClosing) {
      // SVG / MathML / XML script and style hold markup; rewrite them as code only when they are
      // plain text (CDATA allowed), otherwise their tags are parsed like any others.
      const end = rawTextEnd(html, i2, name);
      if (isPlainText(html, i2, end)) {
        kind = name === 'script' ? 'script' : 'css';
        stop = end;
      }
    }
    if (kind) {
      const content = html.slice(i2, stop);
      let next = content;
      if (kind === 'script') {
        const type = scriptKind(attrs);
        if (type === 'js') {
          next = o.runtime ? safe(rewriteJs, content) : safe(rewriteScript, content);
          if (ns !== 'html' && next !== content && XML_GUARD !== GUARD) next = next.replace(GUARD, () => XML_GUARD);
        } else if (type === 'importmap') {
          next = rewriteImportMap(content, base);
        } else if (type === 'speculationrules') {
          next = rewriteSpeculationRules(content, base);
        }
      } else if (kind === 'css') {
        next = safe(rewriteCss, content, base);
      } else if (kind === 'html' && o.depth < MAX_FRAGMENT_DEPTH) {
        // Shown when scripting is off, and read back by lazy-loaders; it never runs past </noscript>.
        const r = nested(content, base);
        if (r.lazyBeforeBase && !baseSeen) lazyBeforeBase = true;
        next = r.out;
      }
      if (next !== content) splice(i2, stop, next);
      i2 = stop;
    }
    return i2;
  }

  function endTag(lt) {
    let j = lt + 2;
    while (j < n && !isTagEnd(html.charCodeAt(j))) j++;
    const name = html.slice(lt + 2, j).toLowerCase();
    const t = parseAttrs(html, j);
    inject(lt);
    if (stack.length && !o.xml) {
      if ((name === 'p' || name === 'br') && inForeign()) {
        while (inForeign()) stack.pop();
      } else {
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].name === name) {
            stack.length = k;
            break;
          }
        }
      }
    }
    return t.end;
  }

  function markupDeclaration(lt) {
    if (html.startsWith('<!--', lt)) {
      const [contentEnd, end] = commentEnd(html, lt + 4);
      if (o.depth < MAX_FRAGMENT_DEPTH && /^\[if\b/i.test(html.slice(lt + 4, lt + 12))) {
        // Conditional comment: keep what is inside rewritten too.
        const content = html.slice(lt + 4, contentEnd);
        const inner = nested(content, base).out;
        if (inner !== content) splice(lt + 4, contentEnd, inner);
      }
      return end;
    }
    if (nameAt(html, lt + 2, 'doctype')) return doctypeEnd(html, lt);
    if (html.startsWith('<![CDATA[', lt) && (o.xml || (stack.length && top().ns !== 'html'))) {
      const e = html.indexOf(']]>', lt + 9);
      return e === -1 ? n : e + 3;
    }
    return bogusComment(lt);
  }

  function bogusComment(lt) {
    const gt = html.indexOf('>', lt + 2);
    return gt === -1 ? n : gt + 1;
  }

  if (html.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const lt = html.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (!injected && textEnd > i && NON_WS.test(html.slice(i, textEnd))) inject(i);
    if (lt === -1) break;
    const c = html.charCodeAt(lt + 1);
    if (isAlpha(c)) {
      i = startTag(lt);
    } else if (c === 47) {
      const d = html.charCodeAt(lt + 2);
      if (isAlpha(d)) i = endTag(lt);
      else if (d === 62) i = lt + 3; // "</>" is ignored by browsers
      else if (lt + 2 >= n) i = n;
      else i = bogusComment(lt);
    } else if (c === 33) {
      i = markupDeclaration(lt);
    } else if (c === 63) {
      i = bogusComment(lt);
    } else {
      i = lt + 1;
    }
  }
  inject(n);
  if (copied === 0 && parts.length === 0) return { out: html, base, lazyBeforeBase };
  splice(n, n, '');
  return { out: parts.join(''), base, lazyBeforeBase };
}

function rewriteDocument(html, pageUrl, o) {
  const first = run(html, pageUrl, o, null);
  // A <base> came after links that were resolved without it: redo them with the final base.
  if (first.lazyBeforeBase && first.base !== pageUrl) return run(html, pageUrl, o, first.base).out;
  return first.out;
}

/**
 * Rewrite an HTML (or SVG / XHTML) document so every URL points back through the proxy.
 * @param {string} html
 * @param {string} pageUrl the real URL of the document
 * @param {object} [opts]
 * @param {string|null} [opts.inject] markup inserted at the top of <head> (the client runtime);
 *   without it, rewritten inline code carries its own `__pLocation` guard
 * @param {boolean} [opts.xml] parse as XML (application/xhtml+xml): self-closing tags are honoured
 *   everywhere and nothing but <script>/<style> is raw text
 * @returns {string}
 */
function rewriteHtml(html, pageUrl, opts = {}) {
  const src = html == null ? '' : String(html);
  const inject = opts.inject || '';
  return rewriteDocument(src, pageUrl, { inject, docInject: inject, xml: Boolean(opts.xml), runtime: Boolean(inject), depth: 0, fragment: false });
}

module.exports = { rewriteHtml, rewriteSrcset, decodeEntities };

// ---------------------------------------------------------------------------------------
// WHATWG named character references ("name:value", without the trailing semicolon; Tab and
// NewLine are added in entities()). Generated from https://html.spec.whatwg.org/entities.json.
const ENTITY_DATA = `
AElig:Æ AMP:& Aacute:Á Abreve:Ă Acirc:Â Acy:А Afr:𝔄 Agrave:À Alpha:Α Amacr:Ā And:⩓ Aogon:Ą Aopf:𝔸
ApplyFunction:\u2061 Aring:Å Ascr:𝒜 Assign:≔ Atilde:Ã Auml:Ä Backslash:∖ Barv:⫧ Barwed:⌆ Bcy:Б Because:∵
Bernoullis:ℬ Beta:Β Bfr:𝔅 Bopf:𝔹 Breve:˘ Bscr:ℬ Bumpeq:≎ CHcy:Ч COPY:© Cacute:Ć Cap:⋒ CapitalDifferentialD:ⅅ
Cayleys:ℭ Ccaron:Č Ccedil:Ç Ccirc:Ĉ Cconint:∰ Cdot:Ċ Cedilla:¸ CenterDot:· Cfr:ℭ Chi:Χ CircleDot:⊙
CircleMinus:⊖ CirclePlus:⊕ CircleTimes:⊗ ClockwiseContourIntegral:∲ CloseCurlyDoubleQuote:” CloseCurlyQuote:’
Colon:∷ Colone:⩴ Congruent:≡ Conint:∯ ContourIntegral:∮ Copf:ℂ Coproduct:∐ CounterClockwiseContourIntegral:∳
Cross:⨯ Cscr:𝒞 Cup:⋓ CupCap:≍ DD:ⅅ DDotrahd:⤑ DJcy:Ђ DScy:Ѕ DZcy:Џ Dagger:‡ Darr:↡ Dashv:⫤ Dcaron:Ď Dcy:Д
Del:∇ Delta:Δ Dfr:𝔇 DiacriticalAcute:´ DiacriticalDot:˙ DiacriticalDoubleAcute:˝ DiacriticalGrave:\`
DiacriticalTilde:˜ Diamond:⋄ DifferentialD:ⅆ Dopf:𝔻 Dot:¨ DotDot:\u20dc DotEqual:≐ DoubleContourIntegral:∯
DoubleDot:¨ DoubleDownArrow:⇓ DoubleLeftArrow:⇐ DoubleLeftRightArrow:⇔ DoubleLeftTee:⫤ DoubleLongLeftArrow:⟸
DoubleLongLeftRightArrow:⟺ DoubleLongRightArrow:⟹ DoubleRightArrow:⇒ DoubleRightTee:⊨ DoubleUpArrow:⇑
DoubleUpDownArrow:⇕ DoubleVerticalBar:∥ DownArrow:↓ DownArrowBar:⤓ DownArrowUpArrow:⇵ DownBreve:\u0311
DownLeftRightVector:⥐ DownLeftTeeVector:⥞ DownLeftVector:↽ DownLeftVectorBar:⥖ DownRightTeeVector:⥟
DownRightVector:⇁ DownRightVectorBar:⥗ DownTee:⊤ DownTeeArrow:↧ Downarrow:⇓ Dscr:𝒟 Dstrok:Đ ENG:Ŋ ETH:Ð
Eacute:É Ecaron:Ě Ecirc:Ê Ecy:Э Edot:Ė Efr:𝔈 Egrave:È Element:∈ Emacr:Ē EmptySmallSquare:◻
EmptyVerySmallSquare:▫ Eogon:Ę Eopf:𝔼 Epsilon:Ε Equal:⩵ EqualTilde:≂ Equilibrium:⇌ Escr:ℰ Esim:⩳ Eta:Η Euml:Ë
Exists:∃ ExponentialE:ⅇ Fcy:Ф Ffr:𝔉 FilledSmallSquare:◼ FilledVerySmallSquare:▪ Fopf:𝔽 ForAll:∀ Fouriertrf:ℱ
Fscr:ℱ GJcy:Ѓ GT:> Gamma:Γ Gammad:Ϝ Gbreve:Ğ Gcedil:Ģ Gcirc:Ĝ Gcy:Г Gdot:Ġ Gfr:𝔊 Gg:⋙ Gopf:𝔾 GreaterEqual:≥
GreaterEqualLess:⋛ GreaterFullEqual:≧ GreaterGreater:⪢ GreaterLess:≷ GreaterSlantEqual:⩾ GreaterTilde:≳ Gscr:𝒢
Gt:≫ HARDcy:Ъ Hacek:ˇ Hat:^ Hcirc:Ĥ Hfr:ℌ HilbertSpace:ℋ Hopf:ℍ HorizontalLine:─ Hscr:ℋ Hstrok:Ħ
HumpDownHump:≎ HumpEqual:≏ IEcy:Е IJlig:Ĳ IOcy:Ё Iacute:Í Icirc:Î Icy:И Idot:İ Ifr:ℑ Igrave:Ì Im:ℑ Imacr:Ī
ImaginaryI:ⅈ Implies:⇒ Int:∬ Integral:∫ Intersection:⋂ InvisibleComma:\u2063 InvisibleTimes:\u2062 Iogon:Į
Iopf:𝕀 Iota:Ι Iscr:ℐ Itilde:Ĩ Iukcy:І Iuml:Ï Jcirc:Ĵ Jcy:Й Jfr:𝔍 Jopf:𝕁 Jscr:𝒥 Jsercy:Ј Jukcy:Є KHcy:Х KJcy:Ќ
Kappa:Κ Kcedil:Ķ Kcy:К Kfr:𝔎 Kopf:𝕂 Kscr:𝒦 LJcy:Љ LT:< Lacute:Ĺ Lambda:Λ Lang:⟪ Laplacetrf:ℒ Larr:↞ Lcaron:Ľ
Lcedil:Ļ Lcy:Л LeftAngleBracket:⟨ LeftArrow:← LeftArrowBar:⇤ LeftArrowRightArrow:⇆ LeftCeiling:⌈
LeftDoubleBracket:⟦ LeftDownTeeVector:⥡ LeftDownVector:⇃ LeftDownVectorBar:⥙ LeftFloor:⌊ LeftRightArrow:↔
LeftRightVector:⥎ LeftTee:⊣ LeftTeeArrow:↤ LeftTeeVector:⥚ LeftTriangle:⊲ LeftTriangleBar:⧏
LeftTriangleEqual:⊴ LeftUpDownVector:⥑ LeftUpTeeVector:⥠ LeftUpVector:↿ LeftUpVectorBar:⥘ LeftVector:↼
LeftVectorBar:⥒ Leftarrow:⇐ Leftrightarrow:⇔ LessEqualGreater:⋚ LessFullEqual:≦ LessGreater:≶ LessLess:⪡
LessSlantEqual:⩽ LessTilde:≲ Lfr:𝔏 Ll:⋘ Lleftarrow:⇚ Lmidot:Ŀ LongLeftArrow:⟵ LongLeftRightArrow:⟷
LongRightArrow:⟶ Longleftarrow:⟸ Longleftrightarrow:⟺ Longrightarrow:⟹ Lopf:𝕃 LowerLeftArrow:↙
LowerRightArrow:↘ Lscr:ℒ Lsh:↰ Lstrok:Ł Lt:≪ Map:⤅ Mcy:М MediumSpace:\u205f Mellintrf:ℳ Mfr:𝔐 MinusPlus:∓
Mopf:𝕄 Mscr:ℳ Mu:Μ NJcy:Њ Nacute:Ń Ncaron:Ň Ncedil:Ņ Ncy:Н NegativeMediumSpace:\u200b
NegativeThickSpace:\u200b NegativeThinSpace:\u200b NegativeVeryThinSpace:\u200b NestedGreaterGreater:≫
NestedLessLess:≪ Nfr:𝔑 NoBreak:\u2060 NonBreakingSpace:\u00a0 Nopf:ℕ Not:⫬ NotCongruent:≢ NotCupCap:≭
NotDoubleVerticalBar:∦ NotElement:∉ NotEqual:≠ NotEqualTilde:≂\u0338 NotExists:∄ NotGreater:≯
NotGreaterEqual:≱ NotGreaterFullEqual:≧\u0338 NotGreaterGreater:≫\u0338 NotGreaterLess:≹
NotGreaterSlantEqual:⩾\u0338 NotGreaterTilde:≵ NotHumpDownHump:≎\u0338 NotHumpEqual:≏\u0338 NotLeftTriangle:⋪
NotLeftTriangleBar:⧏\u0338 NotLeftTriangleEqual:⋬ NotLess:≮ NotLessEqual:≰ NotLessGreater:≸
NotLessLess:≪\u0338 NotLessSlantEqual:⩽\u0338 NotLessTilde:≴ NotNestedGreaterGreater:⪢\u0338
NotNestedLessLess:⪡\u0338 NotPrecedes:⊀ NotPrecedesEqual:⪯\u0338 NotPrecedesSlantEqual:⋠ NotReverseElement:∌
NotRightTriangle:⋫ NotRightTriangleBar:⧐\u0338 NotRightTriangleEqual:⋭ NotSquareSubset:⊏\u0338
NotSquareSubsetEqual:⋢ NotSquareSuperset:⊐\u0338 NotSquareSupersetEqual:⋣ NotSubset:⊂\u20d2 NotSubsetEqual:⊈
NotSucceeds:⊁ NotSucceedsEqual:⪰\u0338 NotSucceedsSlantEqual:⋡ NotSucceedsTilde:≿\u0338 NotSuperset:⊃\u20d2
NotSupersetEqual:⊉ NotTilde:≁ NotTildeEqual:≄ NotTildeFullEqual:≇ NotTildeTilde:≉ NotVerticalBar:∤ Nscr:𝒩
Ntilde:Ñ Nu:Ν OElig:Œ Oacute:Ó Ocirc:Ô Ocy:О Odblac:Ő Ofr:𝔒 Ograve:Ò Omacr:Ō Omega:Ω Omicron:Ο Oopf:𝕆
OpenCurlyDoubleQuote:“ OpenCurlyQuote:‘ Or:⩔ Oscr:𝒪 Oslash:Ø Otilde:Õ Otimes:⨷ Ouml:Ö OverBar:‾ OverBrace:⏞
OverBracket:⎴ OverParenthesis:⏜ PartialD:∂ Pcy:П Pfr:𝔓 Phi:Φ Pi:Π PlusMinus:± Poincareplane:ℌ Popf:ℙ Pr:⪻
Precedes:≺ PrecedesEqual:⪯ PrecedesSlantEqual:≼ PrecedesTilde:≾ Prime:″ Product:∏ Proportion:∷ Proportional:∝
Pscr:𝒫 Psi:Ψ QUOT:" Qfr:𝔔 Qopf:ℚ Qscr:𝒬 RBarr:⤐ REG:® Racute:Ŕ Rang:⟫ Rarr:↠ Rarrtl:⤖ Rcaron:Ř Rcedil:Ŗ Rcy:Р
Re:ℜ ReverseElement:∋ ReverseEquilibrium:⇋ ReverseUpEquilibrium:⥯ Rfr:ℜ Rho:Ρ RightAngleBracket:⟩ RightArrow:→
RightArrowBar:⇥ RightArrowLeftArrow:⇄ RightCeiling:⌉ RightDoubleBracket:⟧ RightDownTeeVector:⥝
RightDownVector:⇂ RightDownVectorBar:⥕ RightFloor:⌋ RightTee:⊢ RightTeeArrow:↦ RightTeeVector:⥛
RightTriangle:⊳ RightTriangleBar:⧐ RightTriangleEqual:⊵ RightUpDownVector:⥏ RightUpTeeVector:⥜ RightUpVector:↾
RightUpVectorBar:⥔ RightVector:⇀ RightVectorBar:⥓ Rightarrow:⇒ Ropf:ℝ RoundImplies:⥰ Rrightarrow:⇛ Rscr:ℛ
Rsh:↱ RuleDelayed:⧴ SHCHcy:Щ SHcy:Ш SOFTcy:Ь Sacute:Ś Sc:⪼ Scaron:Š Scedil:Ş Scirc:Ŝ Scy:С Sfr:𝔖
ShortDownArrow:↓ ShortLeftArrow:← ShortRightArrow:→ ShortUpArrow:↑ Sigma:Σ SmallCircle:∘ Sopf:𝕊 Sqrt:√
Square:□ SquareIntersection:⊓ SquareSubset:⊏ SquareSubsetEqual:⊑ SquareSuperset:⊐ SquareSupersetEqual:⊒
SquareUnion:⊔ Sscr:𝒮 Star:⋆ Sub:⋐ Subset:⋐ SubsetEqual:⊆ Succeeds:≻ SucceedsEqual:⪰ SucceedsSlantEqual:≽
SucceedsTilde:≿ SuchThat:∋ Sum:∑ Sup:⋑ Superset:⊃ SupersetEqual:⊇ Supset:⋑ THORN:Þ TRADE:™ TSHcy:Ћ TScy:Ц
Tau:Τ Tcaron:Ť Tcedil:Ţ Tcy:Т Tfr:𝔗 Therefore:∴ Theta:Θ ThickSpace:\u205f\u200a ThinSpace:\u2009 Tilde:∼
TildeEqual:≃ TildeFullEqual:≅ TildeTilde:≈ Topf:𝕋 TripleDot:\u20db Tscr:𝒯 Tstrok:Ŧ Uacute:Ú Uarr:↟ Uarrocir:⥉
Ubrcy:Ў Ubreve:Ŭ Ucirc:Û Ucy:У Udblac:Ű Ufr:𝔘 Ugrave:Ù Umacr:Ū UnderBar:_ UnderBrace:⏟ UnderBracket:⎵
UnderParenthesis:⏝ Union:⋃ UnionPlus:⊎ Uogon:Ų Uopf:𝕌 UpArrow:↑ UpArrowBar:⤒ UpArrowDownArrow:⇅ UpDownArrow:↕
UpEquilibrium:⥮ UpTee:⊥ UpTeeArrow:↥ Uparrow:⇑ Updownarrow:⇕ UpperLeftArrow:↖ UpperRightArrow:↗ Upsi:ϒ
Upsilon:Υ Uring:Ů Uscr:𝒰 Utilde:Ũ Uuml:Ü VDash:⊫ Vbar:⫫ Vcy:В Vdash:⊩ Vdashl:⫦ Vee:⋁ Verbar:‖ Vert:‖
VerticalBar:∣ VerticalLine:| VerticalSeparator:❘ VerticalTilde:≀ VeryThinSpace:\u200a Vfr:𝔙 Vopf:𝕍 Vscr:𝒱
Vvdash:⊪ Wcirc:Ŵ Wedge:⋀ Wfr:𝔚 Wopf:𝕎 Wscr:𝒲 Xfr:𝔛 Xi:Ξ Xopf:𝕏 Xscr:𝒳 YAcy:Я YIcy:Ї YUcy:Ю Yacute:Ý Ycirc:Ŷ
Ycy:Ы Yfr:𝔜 Yopf:𝕐 Yscr:𝒴 Yuml:Ÿ ZHcy:Ж Zacute:Ź Zcaron:Ž Zcy:З Zdot:Ż ZeroWidthSpace:\u200b Zeta:Ζ Zfr:ℨ
Zopf:ℤ Zscr:𝒵 aacute:á abreve:ă ac:∾ acE:∾\u0333 acd:∿ acirc:â acute:´ acy:а aelig:æ af:\u2061 afr:𝔞 agrave:à
alefsym:ℵ aleph:ℵ alpha:α amacr:ā amalg:⨿ amp:& and:∧ andand:⩕ andd:⩜ andslope:⩘ andv:⩚ ang:∠ ange:⦤ angle:∠
angmsd:∡ angmsdaa:⦨ angmsdab:⦩ angmsdac:⦪ angmsdad:⦫ angmsdae:⦬ angmsdaf:⦭ angmsdag:⦮ angmsdah:⦯ angrt:∟
angrtvb:⊾ angrtvbd:⦝ angsph:∢ angst:Å angzarr:⍼ aogon:ą aopf:𝕒 ap:≈ apE:⩰ apacir:⩯ ape:≊ apid:≋ apos:'
approx:≈ approxeq:≊ aring:å ascr:𝒶 ast:* asymp:≈ asympeq:≍ atilde:ã auml:ä awconint:∳ awint:⨑ bNot:⫭
backcong:≌ backepsilon:϶ backprime:‵ backsim:∽ backsimeq:⋍ barvee:⊽ barwed:⌅ barwedge:⌅ bbrk:⎵ bbrktbrk:⎶
bcong:≌ bcy:б bdquo:„ becaus:∵ because:∵ bemptyv:⦰ bepsi:϶ bernou:ℬ beta:β beth:ℶ between:≬ bfr:𝔟 bigcap:⋂
bigcirc:◯ bigcup:⋃ bigodot:⨀ bigoplus:⨁ bigotimes:⨂ bigsqcup:⨆ bigstar:★ bigtriangledown:▽ bigtriangleup:△
biguplus:⨄ bigvee:⋁ bigwedge:⋀ bkarow:⤍ blacklozenge:⧫ blacksquare:▪ blacktriangle:▴ blacktriangledown:▾
blacktriangleleft:◂ blacktriangleright:▸ blank:␣ blk12:▒ blk14:░ blk34:▓ block:█ bne:=\u20e5 bnequiv:≡\u20e5
bnot:⌐ bopf:𝕓 bot:⊥ bottom:⊥ bowtie:⋈ boxDL:╗ boxDR:╔ boxDl:╖ boxDr:╓ boxH:═ boxHD:╦ boxHU:╩ boxHd:╤ boxHu:╧
boxUL:╝ boxUR:╚ boxUl:╜ boxUr:╙ boxV:║ boxVH:╬ boxVL:╣ boxVR:╠ boxVh:╫ boxVl:╢ boxVr:╟ boxbox:⧉ boxdL:╕
boxdR:╒ boxdl:┐ boxdr:┌ boxh:─ boxhD:╥ boxhU:╨ boxhd:┬ boxhu:┴ boxminus:⊟ boxplus:⊞ boxtimes:⊠ boxuL:╛ boxuR:╘
boxul:┘ boxur:└ boxv:│ boxvH:╪ boxvL:╡ boxvR:╞ boxvh:┼ boxvl:┤ boxvr:├ bprime:‵ breve:˘ brvbar:¦ bscr:𝒷
bsemi:⁏ bsim:∽ bsime:⋍ bsol:\\ bsolb:⧅ bsolhsub:⟈ bull:• bullet:• bump:≎ bumpE:⪮ bumpe:≏ bumpeq:≏ cacute:ć
cap:∩ capand:⩄ capbrcup:⩉ capcap:⩋ capcup:⩇ capdot:⩀ caps:∩\ufe00 caret:⁁ caron:ˇ ccaps:⩍ ccaron:č ccedil:ç
ccirc:ĉ ccups:⩌ ccupssm:⩐ cdot:ċ cedil:¸ cemptyv:⦲ cent:¢ centerdot:· cfr:𝔠 chcy:ч check:✓ checkmark:✓ chi:χ
cir:○ cirE:⧃ circ:ˆ circeq:≗ circlearrowleft:↺ circlearrowright:↻ circledR:® circledS:Ⓢ circledast:⊛
circledcirc:⊚ circleddash:⊝ cire:≗ cirfnint:⨐ cirmid:⫯ cirscir:⧂ clubs:♣ clubsuit:♣ colon:: colone:≔ coloneq:≔
comma:, commat:@ comp:∁ compfn:∘ complement:∁ complexes:ℂ cong:≅ congdot:⩭ conint:∮ copf:𝕔 coprod:∐ copy:©
copysr:℗ crarr:↵ cross:✗ cscr:𝒸 csub:⫏ csube:⫑ csup:⫐ csupe:⫒ ctdot:⋯ cudarrl:⤸ cudarrr:⤵ cuepr:⋞ cuesc:⋟
cularr:↶ cularrp:⤽ cup:∪ cupbrcap:⩈ cupcap:⩆ cupcup:⩊ cupdot:⊍ cupor:⩅ cups:∪\ufe00 curarr:↷ curarrm:⤼
curlyeqprec:⋞ curlyeqsucc:⋟ curlyvee:⋎ curlywedge:⋏ curren:¤ curvearrowleft:↶ curvearrowright:↷ cuvee:⋎
cuwed:⋏ cwconint:∲ cwint:∱ cylcty:⌭ dArr:⇓ dHar:⥥ dagger:† daleth:ℸ darr:↓ dash:‐ dashv:⊣ dbkarow:⤏ dblac:˝
dcaron:ď dcy:д dd:ⅆ ddagger:‡ ddarr:⇊ ddotseq:⩷ deg:° delta:δ demptyv:⦱ dfisht:⥿ dfr:𝔡 dharl:⇃ dharr:⇂ diam:⋄
diamond:⋄ diamondsuit:♦ diams:♦ die:¨ digamma:ϝ disin:⋲ div:÷ divide:÷ divideontimes:⋇ divonx:⋇ djcy:ђ
dlcorn:⌞ dlcrop:⌍ dollar:\$ dopf:𝕕 dot:˙ doteq:≐ doteqdot:≑ dotminus:∸ dotplus:∔ dotsquare:⊡ doublebarwedge:⌆
downarrow:↓ downdownarrows:⇊ downharpoonleft:⇃ downharpoonright:⇂ drbkarow:⤐ drcorn:⌟ drcrop:⌌ dscr:𝒹 dscy:ѕ
dsol:⧶ dstrok:đ dtdot:⋱ dtri:▿ dtrif:▾ duarr:⇵ duhar:⥯ dwangle:⦦ dzcy:џ dzigrarr:⟿ eDDot:⩷ eDot:≑ eacute:é
easter:⩮ ecaron:ě ecir:≖ ecirc:ê ecolon:≕ ecy:э edot:ė ee:ⅇ efDot:≒ efr:𝔢 eg:⪚ egrave:è egs:⪖ egsdot:⪘ el:⪙
elinters:⏧ ell:ℓ els:⪕ elsdot:⪗ emacr:ē empty:∅ emptyset:∅ emptyv:∅ emsp:\u2003 emsp13:\u2004 emsp14:\u2005
eng:ŋ ensp:\u2002 eogon:ę eopf:𝕖 epar:⋕ eparsl:⧣ eplus:⩱ epsi:ε epsilon:ε epsiv:ϵ eqcirc:≖ eqcolon:≕ eqsim:≂
eqslantgtr:⪖ eqslantless:⪕ equals:= equest:≟ equiv:≡ equivDD:⩸ eqvparsl:⧥ erDot:≓ erarr:⥱ escr:ℯ esdot:≐
esim:≂ eta:η eth:ð euml:ë euro:€ excl:! exist:∃ expectation:ℰ exponentiale:ⅇ fallingdotseq:≒ fcy:ф female:♀
ffilig:ﬃ fflig:ﬀ ffllig:ﬄ ffr:𝔣 filig:ﬁ fjlig:fj flat:♭ fllig:ﬂ fltns:▱ fnof:ƒ fopf:𝕗 forall:∀ fork:⋔ forkv:⫙
fpartint:⨍ frac12:½ frac13:⅓ frac14:¼ frac15:⅕ frac16:⅙ frac18:⅛ frac23:⅔ frac25:⅖ frac34:¾ frac35:⅗ frac38:⅜
frac45:⅘ frac56:⅚ frac58:⅝ frac78:⅞ frasl:⁄ frown:⌢ fscr:𝒻 gE:≧ gEl:⪌ gacute:ǵ gamma:γ gammad:ϝ gap:⪆ gbreve:ğ
gcirc:ĝ gcy:г gdot:ġ ge:≥ gel:⋛ geq:≥ geqq:≧ geqslant:⩾ ges:⩾ gescc:⪩ gesdot:⪀ gesdoto:⪂ gesdotol:⪄
gesl:⋛\ufe00 gesles:⪔ gfr:𝔤 gg:≫ ggg:⋙ gimel:ℷ gjcy:ѓ gl:≷ glE:⪒ gla:⪥ glj:⪤ gnE:≩ gnap:⪊ gnapprox:⪊ gne:⪈
gneq:⪈ gneqq:≩ gnsim:⋧ gopf:𝕘 grave:\` gscr:ℊ gsim:≳ gsime:⪎ gsiml:⪐ gt:> gtcc:⪧ gtcir:⩺ gtdot:⋗ gtlPar:⦕
gtquest:⩼ gtrapprox:⪆ gtrarr:⥸ gtrdot:⋗ gtreqless:⋛ gtreqqless:⪌ gtrless:≷ gtrsim:≳ gvertneqq:≩\ufe00
gvnE:≩\ufe00 hArr:⇔ hairsp:\u200a half:½ hamilt:ℋ hardcy:ъ harr:↔ harrcir:⥈ harrw:↭ hbar:ℏ hcirc:ĥ hearts:♥
heartsuit:♥ hellip:… hercon:⊹ hfr:𝔥 hksearow:⤥ hkswarow:⤦ hoarr:⇿ homtht:∻ hookleftarrow:↩ hookrightarrow:↪
hopf:𝕙 horbar:― hscr:𝒽 hslash:ℏ hstrok:ħ hybull:⁃ hyphen:‐ iacute:í ic:\u2063 icirc:î icy:и iecy:е iexcl:¡
iff:⇔ ifr:𝔦 igrave:ì ii:ⅈ iiiint:⨌ iiint:∭ iinfin:⧜ iiota:℩ ijlig:ĳ imacr:ī image:ℑ imagline:ℐ imagpart:ℑ
imath:ı imof:⊷ imped:Ƶ in:∈ incare:℅ infin:∞ infintie:⧝ inodot:ı int:∫ intcal:⊺ integers:ℤ intercal:⊺
intlarhk:⨗ intprod:⨼ iocy:ё iogon:į iopf:𝕚 iota:ι iprod:⨼ iquest:¿ iscr:𝒾 isin:∈ isinE:⋹ isindot:⋵ isins:⋴
isinsv:⋳ isinv:∈ it:\u2062 itilde:ĩ iukcy:і iuml:ï jcirc:ĵ jcy:й jfr:𝔧 jmath:ȷ jopf:𝕛 jscr:𝒿 jsercy:ј jukcy:є
kappa:κ kappav:ϰ kcedil:ķ kcy:к kfr:𝔨 kgreen:ĸ khcy:х kjcy:ќ kopf:𝕜 kscr:𝓀 lAarr:⇚ lArr:⇐ lAtail:⤛ lBarr:⤎
lE:≦ lEg:⪋ lHar:⥢ lacute:ĺ laemptyv:⦴ lagran:ℒ lambda:λ lang:⟨ langd:⦑ langle:⟨ lap:⪅ laquo:« larr:← larrb:⇤
larrbfs:⤟ larrfs:⤝ larrhk:↩ larrlp:↫ larrpl:⤹ larrsim:⥳ larrtl:↢ lat:⪫ latail:⤙ late:⪭ lates:⪭\ufe00 lbarr:⤌
lbbrk:❲ lbrace:{ lbrack:[ lbrke:⦋ lbrksld:⦏ lbrkslu:⦍ lcaron:ľ lcedil:ļ lceil:⌈ lcub:{ lcy:л ldca:⤶ ldquo:“
ldquor:„ ldrdhar:⥧ ldrushar:⥋ ldsh:↲ le:≤ leftarrow:← leftarrowtail:↢ leftharpoondown:↽ leftharpoonup:↼
leftleftarrows:⇇ leftrightarrow:↔ leftrightarrows:⇆ leftrightharpoons:⇋ leftrightsquigarrow:↭ leftthreetimes:⋋
leg:⋚ leq:≤ leqq:≦ leqslant:⩽ les:⩽ lescc:⪨ lesdot:⩿ lesdoto:⪁ lesdotor:⪃ lesg:⋚\ufe00 lesges:⪓ lessapprox:⪅
lessdot:⋖ lesseqgtr:⋚ lesseqqgtr:⪋ lessgtr:≶ lesssim:≲ lfisht:⥼ lfloor:⌊ lfr:𝔩 lg:≶ lgE:⪑ lhard:↽ lharu:↼
lharul:⥪ lhblk:▄ ljcy:љ ll:≪ llarr:⇇ llcorner:⌞ llhard:⥫ lltri:◺ lmidot:ŀ lmoust:⎰ lmoustache:⎰ lnE:≨ lnap:⪉
lnapprox:⪉ lne:⪇ lneq:⪇ lneqq:≨ lnsim:⋦ loang:⟬ loarr:⇽ lobrk:⟦ longleftarrow:⟵ longleftrightarrow:⟷
longmapsto:⟼ longrightarrow:⟶ looparrowleft:↫ looparrowright:↬ lopar:⦅ lopf:𝕝 loplus:⨭ lotimes:⨴ lowast:∗
lowbar:_ loz:◊ lozenge:◊ lozf:⧫ lpar:( lparlt:⦓ lrarr:⇆ lrcorner:⌟ lrhar:⇋ lrhard:⥭ lrm:\u200e lrtri:⊿
lsaquo:‹ lscr:𝓁 lsh:↰ lsim:≲ lsime:⪍ lsimg:⪏ lsqb:[ lsquo:‘ lsquor:‚ lstrok:ł lt:< ltcc:⪦ ltcir:⩹ ltdot:⋖
lthree:⋋ ltimes:⋉ ltlarr:⥶ ltquest:⩻ ltrPar:⦖ ltri:◃ ltrie:⊴ ltrif:◂ lurdshar:⥊ luruhar:⥦ lvertneqq:≨\ufe00
lvnE:≨\ufe00 mDDot:∺ macr:¯ male:♂ malt:✠ maltese:✠ map:↦ mapsto:↦ mapstodown:↧ mapstoleft:↤ mapstoup:↥
marker:▮ mcomma:⨩ mcy:м mdash:— measuredangle:∡ mfr:𝔪 mho:℧ micro:µ mid:∣ midast:* midcir:⫰ middot:· minus:−
minusb:⊟ minusd:∸ minusdu:⨪ mlcp:⫛ mldr:… mnplus:∓ models:⊧ mopf:𝕞 mp:∓ mscr:𝓂 mstpos:∾ mu:μ multimap:⊸
mumap:⊸ nGg:⋙\u0338 nGt:≫\u20d2 nGtv:≫\u0338 nLeftarrow:⇍ nLeftrightarrow:⇎ nLl:⋘\u0338 nLt:≪\u20d2
nLtv:≪\u0338 nRightarrow:⇏ nVDash:⊯ nVdash:⊮ nabla:∇ nacute:ń nang:∠\u20d2 nap:≉ napE:⩰\u0338 napid:≋\u0338
napos:ŉ napprox:≉ natur:♮ natural:♮ naturals:ℕ nbsp:\u00a0 nbump:≎\u0338 nbumpe:≏\u0338 ncap:⩃ ncaron:ň
ncedil:ņ ncong:≇ ncongdot:⩭\u0338 ncup:⩂ ncy:н ndash:– ne:≠ neArr:⇗ nearhk:⤤ nearr:↗ nearrow:↗ nedot:≐\u0338
nequiv:≢ nesear:⤨ nesim:≂\u0338 nexist:∄ nexists:∄ nfr:𝔫 ngE:≧\u0338 nge:≱ ngeq:≱ ngeqq:≧\u0338
ngeqslant:⩾\u0338 nges:⩾\u0338 ngsim:≵ ngt:≯ ngtr:≯ nhArr:⇎ nharr:↮ nhpar:⫲ ni:∋ nis:⋼ nisd:⋺ niv:∋ njcy:њ
nlArr:⇍ nlE:≦\u0338 nlarr:↚ nldr:‥ nle:≰ nleftarrow:↚ nleftrightarrow:↮ nleq:≰ nleqq:≦\u0338 nleqslant:⩽\u0338
nles:⩽\u0338 nless:≮ nlsim:≴ nlt:≮ nltri:⋪ nltrie:⋬ nmid:∤ nopf:𝕟 not:¬ notin:∉ notinE:⋹\u0338
notindot:⋵\u0338 notinva:∉ notinvb:⋷ notinvc:⋶ notni:∌ notniva:∌ notnivb:⋾ notnivc:⋽ npar:∦ nparallel:∦
nparsl:⫽\u20e5 npart:∂\u0338 npolint:⨔ npr:⊀ nprcue:⋠ npre:⪯\u0338 nprec:⊀ npreceq:⪯\u0338 nrArr:⇏ nrarr:↛
nrarrc:⤳\u0338 nrarrw:↝\u0338 nrightarrow:↛ nrtri:⋫ nrtrie:⋭ nsc:⊁ nsccue:⋡ nsce:⪰\u0338 nscr:𝓃 nshortmid:∤
nshortparallel:∦ nsim:≁ nsime:≄ nsimeq:≄ nsmid:∤ nspar:∦ nsqsube:⋢ nsqsupe:⋣ nsub:⊄ nsubE:⫅\u0338 nsube:⊈
nsubset:⊂\u20d2 nsubseteq:⊈ nsubseteqq:⫅\u0338 nsucc:⊁ nsucceq:⪰\u0338 nsup:⊅ nsupE:⫆\u0338 nsupe:⊉
nsupset:⊃\u20d2 nsupseteq:⊉ nsupseteqq:⫆\u0338 ntgl:≹ ntilde:ñ ntlg:≸ ntriangleleft:⋪ ntrianglelefteq:⋬
ntriangleright:⋫ ntrianglerighteq:⋭ nu:ν num:# numero:№ numsp:\u2007 nvDash:⊭ nvHarr:⤄ nvap:≍\u20d2 nvdash:⊬
nvge:≥\u20d2 nvgt:>\u20d2 nvinfin:⧞ nvlArr:⤂ nvle:≤\u20d2 nvlt:<\u20d2 nvltrie:⊴\u20d2 nvrArr:⤃
nvrtrie:⊵\u20d2 nvsim:∼\u20d2 nwArr:⇖ nwarhk:⤣ nwarr:↖ nwarrow:↖ nwnear:⤧ oS:Ⓢ oacute:ó oast:⊛ ocir:⊚ ocirc:ô
ocy:о odash:⊝ odblac:ő odiv:⨸ odot:⊙ odsold:⦼ oelig:œ ofcir:⦿ ofr:𝔬 ogon:˛ ograve:ò ogt:⧁ ohbar:⦵ ohm:Ω oint:∮
olarr:↺ olcir:⦾ olcross:⦻ oline:‾ olt:⧀ omacr:ō omega:ω omicron:ο omid:⦶ ominus:⊖ oopf:𝕠 opar:⦷ operp:⦹
oplus:⊕ or:∨ orarr:↻ ord:⩝ order:ℴ orderof:ℴ ordf:ª ordm:º origof:⊶ oror:⩖ orslope:⩗ orv:⩛ oscr:ℴ oslash:ø
osol:⊘ otilde:õ otimes:⊗ otimesas:⨶ ouml:ö ovbar:⌽ par:∥ para:¶ parallel:∥ parsim:⫳ parsl:⫽ part:∂ pcy:п
percnt:% period:. permil:‰ perp:⊥ pertenk:‱ pfr:𝔭 phi:φ phiv:ϕ phmmat:ℳ phone:☎ pi:π pitchfork:⋔ piv:ϖ
planck:ℏ planckh:ℎ plankv:ℏ plus:+ plusacir:⨣ plusb:⊞ pluscir:⨢ plusdo:∔ plusdu:⨥ pluse:⩲ plusmn:± plussim:⨦
plustwo:⨧ pm:± pointint:⨕ popf:𝕡 pound:£ pr:≺ prE:⪳ prap:⪷ prcue:≼ pre:⪯ prec:≺ precapprox:⪷ preccurlyeq:≼
preceq:⪯ precnapprox:⪹ precneqq:⪵ precnsim:⋨ precsim:≾ prime:′ primes:ℙ prnE:⪵ prnap:⪹ prnsim:⋨ prod:∏
profalar:⌮ profline:⌒ profsurf:⌓ prop:∝ propto:∝ prsim:≾ prurel:⊰ pscr:𝓅 psi:ψ puncsp:\u2008 qfr:𝔮 qint:⨌
qopf:𝕢 qprime:⁗ qscr:𝓆 quaternions:ℍ quatint:⨖ quest:? questeq:≟ quot:" rAarr:⇛ rArr:⇒ rAtail:⤜ rBarr:⤏ rHar:⥤
race:∽\u0331 racute:ŕ radic:√ raemptyv:⦳ rang:⟩ rangd:⦒ range:⦥ rangle:⟩ raquo:» rarr:→ rarrap:⥵ rarrb:⇥
rarrbfs:⤠ rarrc:⤳ rarrfs:⤞ rarrhk:↪ rarrlp:↬ rarrpl:⥅ rarrsim:⥴ rarrtl:↣ rarrw:↝ ratail:⤚ ratio:∶ rationals:ℚ
rbarr:⤍ rbbrk:❳ rbrace:} rbrack:] rbrke:⦌ rbrksld:⦎ rbrkslu:⦐ rcaron:ř rcedil:ŗ rceil:⌉ rcub:} rcy:р rdca:⤷
rdldhar:⥩ rdquo:” rdquor:” rdsh:↳ real:ℜ realine:ℛ realpart:ℜ reals:ℝ rect:▭ reg:® rfisht:⥽ rfloor:⌋ rfr:𝔯
rhard:⇁ rharu:⇀ rharul:⥬ rho:ρ rhov:ϱ rightarrow:→ rightarrowtail:↣ rightharpoondown:⇁ rightharpoonup:⇀
rightleftarrows:⇄ rightleftharpoons:⇌ rightrightarrows:⇉ rightsquigarrow:↝ rightthreetimes:⋌ ring:˚
risingdotseq:≓ rlarr:⇄ rlhar:⇌ rlm:\u200f rmoust:⎱ rmoustache:⎱ rnmid:⫮ roang:⟭ roarr:⇾ robrk:⟧ ropar:⦆ ropf:𝕣
roplus:⨮ rotimes:⨵ rpar:) rpargt:⦔ rppolint:⨒ rrarr:⇉ rsaquo:› rscr:𝓇 rsh:↱ rsqb:] rsquo:’ rsquor:’ rthree:⋌
rtimes:⋊ rtri:▹ rtrie:⊵ rtrif:▸ rtriltri:⧎ ruluhar:⥨ rx:℞ sacute:ś sbquo:‚ sc:≻ scE:⪴ scap:⪸ scaron:š sccue:≽
sce:⪰ scedil:ş scirc:ŝ scnE:⪶ scnap:⪺ scnsim:⋩ scpolint:⨓ scsim:≿ scy:с sdot:⋅ sdotb:⊡ sdote:⩦ seArr:⇘
searhk:⤥ searr:↘ searrow:↘ sect:§ semi:; seswar:⤩ setminus:∖ setmn:∖ sext:✶ sfr:𝔰 sfrown:⌢ sharp:♯ shchcy:щ
shcy:ш shortmid:∣ shortparallel:∥ shy:\u00ad sigma:σ sigmaf:ς sigmav:ς sim:∼ simdot:⩪ sime:≃ simeq:≃ simg:⪞
simgE:⪠ siml:⪝ simlE:⪟ simne:≆ simplus:⨤ simrarr:⥲ slarr:← smallsetminus:∖ smashp:⨳ smeparsl:⧤ smid:∣ smile:⌣
smt:⪪ smte:⪬ smtes:⪬\ufe00 softcy:ь sol:/ solb:⧄ solbar:⌿ sopf:𝕤 spades:♠ spadesuit:♠ spar:∥ sqcap:⊓
sqcaps:⊓\ufe00 sqcup:⊔ sqcups:⊔\ufe00 sqsub:⊏ sqsube:⊑ sqsubset:⊏ sqsubseteq:⊑ sqsup:⊐ sqsupe:⊒ sqsupset:⊐
sqsupseteq:⊒ squ:□ square:□ squarf:▪ squf:▪ srarr:→ sscr:𝓈 ssetmn:∖ ssmile:⌣ sstarf:⋆ star:☆ starf:★
straightepsilon:ϵ straightphi:ϕ strns:¯ sub:⊂ subE:⫅ subdot:⪽ sube:⊆ subedot:⫃ submult:⫁ subnE:⫋ subne:⊊
subplus:⪿ subrarr:⥹ subset:⊂ subseteq:⊆ subseteqq:⫅ subsetneq:⊊ subsetneqq:⫋ subsim:⫇ subsub:⫕ subsup:⫓ succ:≻
succapprox:⪸ succcurlyeq:≽ succeq:⪰ succnapprox:⪺ succneqq:⪶ succnsim:⋩ succsim:≿ sum:∑ sung:♪ sup:⊃ sup1:¹
sup2:² sup3:³ supE:⫆ supdot:⪾ supdsub:⫘ supe:⊇ supedot:⫄ suphsol:⟉ suphsub:⫗ suplarr:⥻ supmult:⫂ supnE:⫌
supne:⊋ supplus:⫀ supset:⊃ supseteq:⊇ supseteqq:⫆ supsetneq:⊋ supsetneqq:⫌ supsim:⫈ supsub:⫔ supsup:⫖ swArr:⇙
swarhk:⤦ swarr:↙ swarrow:↙ swnwar:⤪ szlig:ß target:⌖ tau:τ tbrk:⎴ tcaron:ť tcedil:ţ tcy:т tdot:\u20db telrec:⌕
tfr:𝔱 there4:∴ therefore:∴ theta:θ thetasym:ϑ thetav:ϑ thickapprox:≈ thicksim:∼ thinsp:\u2009 thkap:≈ thksim:∼
thorn:þ tilde:˜ times:× timesb:⊠ timesbar:⨱ timesd:⨰ tint:∭ toea:⤨ top:⊤ topbot:⌶ topcir:⫱ topf:𝕥 topfork:⫚
tosa:⤩ tprime:‴ trade:™ triangle:▵ triangledown:▿ triangleleft:◃ trianglelefteq:⊴ triangleq:≜ triangleright:▹
trianglerighteq:⊵ tridot:◬ trie:≜ triminus:⨺ triplus:⨹ trisb:⧍ tritime:⨻ trpezium:⏢ tscr:𝓉 tscy:ц tshcy:ћ
tstrok:ŧ twixt:≬ twoheadleftarrow:↞ twoheadrightarrow:↠ uArr:⇑ uHar:⥣ uacute:ú uarr:↑ ubrcy:ў ubreve:ŭ ucirc:û
ucy:у udarr:⇅ udblac:ű udhar:⥮ ufisht:⥾ ufr:𝔲 ugrave:ù uharl:↿ uharr:↾ uhblk:▀ ulcorn:⌜ ulcorner:⌜ ulcrop:⌏
ultri:◸ umacr:ū uml:¨ uogon:ų uopf:𝕦 uparrow:↑ updownarrow:↕ upharpoonleft:↿ upharpoonright:↾ uplus:⊎ upsi:υ
upsih:ϒ upsilon:υ upuparrows:⇈ urcorn:⌝ urcorner:⌝ urcrop:⌎ uring:ů urtri:◹ uscr:𝓊 utdot:⋰ utilde:ũ utri:▵
utrif:▴ uuarr:⇈ uuml:ü uwangle:⦧ vArr:⇕ vBar:⫨ vBarv:⫩ vDash:⊨ vangrt:⦜ varepsilon:ϵ varkappa:ϰ varnothing:∅
varphi:ϕ varpi:ϖ varpropto:∝ varr:↕ varrho:ϱ varsigma:ς varsubsetneq:⊊\ufe00 varsubsetneqq:⫋\ufe00
varsupsetneq:⊋\ufe00 varsupsetneqq:⫌\ufe00 vartheta:ϑ vartriangleleft:⊲ vartriangleright:⊳ vcy:в vdash:⊢ vee:∨
veebar:⊻ veeeq:≚ vellip:⋮ verbar:| vert:| vfr:𝔳 vltri:⊲ vnsub:⊂\u20d2 vnsup:⊃\u20d2 vopf:𝕧 vprop:∝ vrtri:⊳
vscr:𝓋 vsubnE:⫋\ufe00 vsubne:⊊\ufe00 vsupnE:⫌\ufe00 vsupne:⊋\ufe00 vzigzag:⦚ wcirc:ŵ wedbar:⩟ wedge:∧ wedgeq:≙
weierp:℘ wfr:𝔴 wopf:𝕨 wp:℘ wr:≀ wreath:≀ wscr:𝓌 xcap:⋂ xcirc:◯ xcup:⋃ xdtri:▽ xfr:𝔵 xhArr:⟺ xharr:⟷ xi:ξ
xlArr:⟸ xlarr:⟵ xmap:⟼ xnis:⋻ xodot:⨀ xopf:𝕩 xoplus:⨁ xotime:⨂ xrArr:⟹ xrarr:⟶ xscr:𝓍 xsqcup:⨆ xuplus:⨄
xutri:△ xvee:⋁ xwedge:⋀ yacute:ý yacy:я ycirc:ŷ ycy:ы yen:¥ yfr:𝔶 yicy:ї yopf:𝕪 yscr:𝓎 yucy:ю yuml:ÿ zacute:ź
zcaron:ž zcy:з zdot:ż zeetrf:ℨ zeta:ζ zfr:𝔷 zhcy:ж zigrarr:⇝ zopf:𝕫 zscr:𝓏 zwj:\u200d zwnj:\u200c
`;
