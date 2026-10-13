'use strict';

const { proxify } = require('./urls');

const URL_FN = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;
const IMPORT = /@import\s+(["'])((?:(?!\1).)+)\1/gi;
const IMAGE_SET = /image-set\(([^)]*)\)/gi;

function cssUnescape(s) {
  return s.replace(/\\([0-9a-fA-F]{1,6}\s?|.)/g, (m, e) => {
    if (/^[0-9a-fA-F]/.test(e)) {
      const cp = parseInt(e, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return e;
  });
}

function rewriteCss(css, base) {
  if (!css) return css;
  let out = css.replace(URL_FN, (m, dq, sq, bare) => {
    const raw = dq !== undefined ? dq : sq !== undefined ? sq : bare;
    if (!raw) return m;
    const url = cssUnescape(raw);
    const p = proxify(url, base);
    if (p === url) return m;
    return 'url("' + p.replace(/["\\\n]/g, (c) => '\\' + c) + '")';
  });
  out = out.replace(IMPORT, (m, q, url) => {
    const p = proxify(cssUnescape(url), base);
    return '@import ' + q + String(p).replace(new RegExp(q, 'g'), '\\' + q) + q;
  });
  // image-set("a.png" 1x, "b.png" 2x) without url()
  out = out.replace(IMAGE_SET, (m, inner) =>
    'image-set(' + inner.replace(/(^|,)(\s*)(["'])([^"']+)\3/g, (mm, c, ws, q, u) => c + ws + q + proxify(u, base) + q) + ')'
  );
  return out;
}

module.exports = { rewriteCss };
