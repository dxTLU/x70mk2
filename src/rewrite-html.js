'use strict';

const { proxify } = require('./urls');
const { rewriteCss } = require('./rewrite-css');
const { rewriteJs } = require('./rewrite-js');

const JS_TYPES = /^(|text\/javascript|application\/javascript|application\/x-javascript|text\/ecmascript|application\/ecmascript|module|text\/jsx|text\/babel)$/i;

// Elements whose content is not parsed as markup.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'plaintext', 'noembed', 'noframes']);

// Attributes holding a single URL.
const URL_ATTRS = new Set([
  'src', 'href', 'action', 'formaction', 'poster', 'background', 'longdesc', 'lowsrc',
  'dynsrc', 'manifest', 'icon', 'xlink:href', 'codebase', 'archive', 'profile', 'itemtype',
]);
// "data" is only a URL on <object>.
const SRCSET_ATTRS = new Set(['srcset', 'imagesrcset']);
// Attributes that would break a rewritten / re-hosted page.
const DROP_ATTRS = new Set(['integrity', 'referrerpolicy']);

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', sol: '/', colon: ':', equals: '=', quest: '?', num: '#', period: '.', comma: ',', lpar: '(', rpar: ')', semi: ';', percnt: '%', plus: '+', excl: '!', newline: '\n', tab: '\t' };

function decodeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);?/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v !== undefined ? v : m;
  });
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function rewriteSrcset(value, base) {
  const out = [];
  let i = 0;
  const n = value.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(value[i])) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/\s/.test(value[i])) i++;
    let url = value.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      let depth = 0;
      while (i < n && (value[i] !== ',' || depth > 0)) {
        if (value[i] === '(') depth++;
        else if (value[i] === ')') depth--;
        i++;
      }
      descriptor = value.slice(start, i).trim();
    }
    out.push(proxify(url, base) + (descriptor ? ' ' + descriptor : ''));
  }
  return out.join(', ');
}

function rewriteRefresh(content, base) {
  const m = /^(\s*\d*(?:\.\d+)?\s*[;,]?\s*(?:url\s*=\s*)?)(['"]?)(.*?)\2\s*$/i.exec(content);
  if (!m || !m[3] || !/url\s*=|[;,]/i.test(m[1])) return content;
  return m[1] + proxify(m[3], base);
}

function rewriteImportMap(json, base) {
  try {
    const map = JSON.parse(json);
    const fix = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const res = {};
      for (const [k, v] of Object.entries(obj)) {
        const key = /^(\.{0,2}\/|https?:)/.test(k) ? proxify(k, base) : k;
        res[key] = typeof v === 'string' ? proxify(v, base) : v;
      }
      return res;
    };
    if (map.imports) map.imports = fix(map.imports);
    if (map.scopes) {
      const scopes = {};
      for (const [k, v] of Object.entries(map.scopes)) scopes[proxify(k, base)] = fix(v);
      map.scopes = scopes;
    }
    return JSON.stringify(map);
  } catch {
    return json;
  }
}

/**
 * Parse the attribute section of a tag starting at index `i`.
 * Returns { attrs: [{name, value, start, end, quoted}], end, selfClosing }.
 */
function parseAttrs(html, i) {
  const n = html.length;
  const attrs = [];
  let selfClosing = false;
  while (i < n) {
    const wsStart = i;
    while (i < n && /[\s/]/.test(html[i])) {
      if (html[i] === '/') selfClosing = true;
      i++;
    }
    if (i >= n) break;
    if (html[i] === '>') { i++; return { attrs, end: i, selfClosing }; }
    selfClosing = false;
    const start = wsStart;
    const nameStart = i;
    while (i < n && !/[\s/>=]/.test(html[i])) i++;
    if (i === nameStart) { i++; continue; } // stray "=" etc.
    const name = html.slice(nameStart, i).toLowerCase();
    let j = i;
    while (j < n && /\s/.test(html[j])) j++;
    let value = null;
    let quoted = false;
    if (html[j] === '=') {
      j++;
      while (j < n && /\s/.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        const stop = close === -1 ? n : close;
        value = html.slice(j + 1, stop);
        quoted = true;
        j = close === -1 ? n : close + 1;
      } else {
        const vs = j;
        while (j < n && !/[\s>]/.test(html[j])) j++;
        value = html.slice(vs, j);
      }
      i = j;
    }
    attrs.push({ name, value, start, end: i, quoted });
  }
  return { attrs, end: n, selfClosing };
}

/**
 * Rewrite an HTML (or SVG/XHTML) document so every URL points back through the proxy.
 * @param {string} html
 * @param {string} pageUrl the real URL of the document
 * @param {object} opts { inject: string|null } markup inserted at the top of <head>
 */
function rewriteHtml(html, pageUrl, opts = {}) {
  const inject = opts.inject || '';
  let injected = !inject;
  let base = pageUrl;
  let out = '';
  let i = 0;
  const n = html.length;
  const tagRe = /<(\/?)([a-zA-Z][^\s/>]*)/y;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { out += html.slice(i); break; }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end === -1 ? n : end + 3;
      // Keep conditional comments working: rewrite their content too.
      const body = html.slice(lt, stop);
      out += /^<!--\[if/i.test(body) ? rewriteHtml(body, base, {}) : body;
      i = stop;
      continue;
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt);
      const stop = end === -1 ? n : end + 1;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    tagRe.lastIndex = lt;
    const m = tagRe.exec(html);
    if (!m) { out += '<'; i = lt + 1; continue; }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const { attrs, end, selfClosing } = parseAttrs(html, lt + m[0].length);

    if (closing) {
      out += html.slice(lt, end);
      i = end;
      continue;
    }

    // Insert the client runtime as early as possible inside <head>.
    if (!injected && name !== 'html' && name !== 'head') {
      out += inject;
      injected = true;
    }

    const get = (a) => {
      const at = attrs.find((x) => x.name === a);
      return at && at.value != null ? decodeEntities(at.value) : null;
    };

    let drop = false;
    if (name === 'meta') {
      const equiv = (get('http-equiv') || '').toLowerCase();
      const metaName = (get('name') || '').toLowerCase();
      if (equiv === 'content-security-policy' || equiv === 'content-security-policy-report-only' || equiv === 'x-frame-options' || metaName === 'referrer') drop = true;
    }
    if (name === 'base') {
      const href = get('href');
      if (href) {
        try { base = new URL(href, pageUrl).href; } catch { /* keep */ }
      }
    }

    if (!drop) {
      let tag = '<' + m[2];
      let last = lt + m[0].length;
      const isMetaRefresh = name === 'meta' && (get('http-equiv') || '').toLowerCase() === 'refresh';
      for (const at of attrs) {
        let replacement;
        const v = at.value == null ? null : decodeEntities(at.value);
        if (DROP_ATTRS.has(at.name)) {
          replacement = '';
        } else if (v == null) {
          replacement = undefined;
        } else if (at.name.startsWith('on') && at.name.length > 2) {
          const js = rewriteJs(v);
          if (js !== v) replacement = ' ' + at.name + '="' + escapeAttr(js) + '"';
        } else if ((URL_ATTRS.has(at.name) || (at.name === 'data' && name === 'object')) && /^\s*javascript:/i.test(v)) {
          const js = rewriteJs(v);
          if (js !== v) replacement = ' ' + at.name + '="' + escapeAttr(js) + '"';
        } else if (URL_ATTRS.has(at.name) || (at.name === 'data' && name === 'object')) {
          const target = name === 'base' && at.name === 'href' ? pageUrl : base;
          const p = proxify(v, target);
          if (p !== v) replacement = ' ' + at.name + '="' + escapeAttr(p) + '"';
        } else if (SRCSET_ATTRS.has(at.name)) {
          replacement = ' ' + at.name + '="' + escapeAttr(rewriteSrcset(v, base)) + '"';
        } else if (at.name === 'style') {
          const css = rewriteCss(v, base);
          if (css !== v) replacement = ' style="' + escapeAttr(css) + '"';
        } else if (at.name === 'srcdoc') {
          replacement = ' srcdoc="' + escapeAttr(rewriteHtml(v, base, { inject })) + '"';
        } else if (at.name === 'ping') {
          replacement = ' ping="' + escapeAttr(v.split(/\s+/).filter(Boolean).map((u) => proxify(u, base)).join(' ')) + '"';
        } else if (at.name === 'content' && isMetaRefresh) {
          replacement = ' content="' + escapeAttr(rewriteRefresh(v, base)) + '"';
        } else if (at.name === 'rel' && /\bnoreferrer\b/i.test(v)) {
          replacement = ' rel="' + escapeAttr(v.replace(/\bnoreferrer\b/gi, '').trim()) + '"';
        }
        if (replacement !== undefined) {
          tag += html.slice(last, at.start) + replacement;
          last = at.end;
        }
      }
      tag += html.slice(last, end);
      out += tag;
    }
    i = end;

    if (name === 'head' && !injected) {
      out += inject;
      injected = true;
    }

    if (RAW_TEXT.has(name) && !(selfClosing && name !== 'script' && name !== 'style')) {
      const closeRe = new RegExp('</' + name + '(?=[\\s/>])', 'ig');
      closeRe.lastIndex = i;
      const cm = closeRe.exec(html);
      const stop = cm ? cm.index : n;
      let content = html.slice(i, stop);
      if (name === 'style') {
        content = rewriteCss(content, base);
      } else if (name === 'script') {
        const type = (get('type') || '').toLowerCase();
        if (type === 'importmap') content = rewriteImportMap(content, base);
        else if (JS_TYPES.test(type.split(';')[0].trim())) content = rewriteJs(content);
      }
      out += content;
      i = stop;
    }
  }

  if (!injected) out = inject + out;
  return out;
}

module.exports = { rewriteHtml, rewriteSrcset, decodeEntities };
