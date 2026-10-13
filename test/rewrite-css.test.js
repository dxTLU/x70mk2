'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { rewriteCss } = require('../src/rewrite-css');

const BASE = 'https://site.example/css/main.css';
const P = '/p/https://site.example';
const rc = (css) => rewriteCss(css, BASE);

describe('url()', () => {
  it('rewrites unquoted, single- and double-quoted URLs', () => {
    assert.strictEqual(rc('a{b:url(x.png)}'), `a{b:url("${P}/css/x.png")}`);
    assert.strictEqual(rc("a{b:url('x.png')}"), `a{b:url("${P}/css/x.png")}`);
    assert.strictEqual(rc('a{b:url("../x.png")}'), `a{b:url("${P}/x.png")}`);
  });

  it('allows whitespace inside url()', () => {
    assert.strictEqual(rc('a{b:url(  x.png  )}'), `a{b:url("${P}/css/x.png")}`);
    assert.strictEqual(rc('a{b:url(\n "x.png"\t)}'), `a{b:url(\n "${P}/css/x.png"\t)}`);
  });

  it('is case-insensitive and understands escaped function names', () => {
    assert.strictEqual(rc('a{b:URL(x.png)}'), `a{b:url("${P}/css/x.png")}`);
    assert.strictEqual(rc('a{b:Url("x.png")}'), `a{b:Url("${P}/css/x.png")}`);
    assert.strictEqual(rc('a{b:u\\rl(x.png)}'), `a{b:url("${P}/css/x.png")}`);
    assert.strictEqual(rc('a{b:\\75 rl(x.png)}'), `a{b:url("${P}/css/x.png")}`);
  });

  it('decodes escapes in URLs', () => {
    assert.strictEqual(rc('a{b:url(a\\)b.png)}'), `a{b:url("${P}/css/a)b.png")}`);
    assert.strictEqual(rc('a{b:url(a\\ b.png)}'), `a{b:url("${P}/css/a%20b.png")}`);
    assert.strictEqual(rc('a{b:url("a\\"b.png")}'), `a{b:url("${P}/css/a%22b.png")}`);
    assert.strictEqual(rc('a{b:url(\\2f x.png)}'), `a{b:url("${P}/x.png")}`);
    assert.strictEqual(rc('a{b:url("x\\\n.png")}'), `a{b:url("${P}/css/x.png")}`);
  });

  it('leaves empty, fragment, data: and blob: URLs alone', () => {
    const css = 'a{b:url();c:url("");d:url(#f);e:url(data:image/png;base64,AA==);f:url("blob:https://x.example/y");g:url( )}';
    assert.strictEqual(rc(css), css);
  });

  it('leaves malformed url() tokens alone', () => {
    const css = "a{b:url(a b.png);c:url(a'b.png);d:url(a(b.png);e:url(a\\\nb.png)}f{g:url(ok.png)}";
    assert.strictEqual(rc(css), css.replace('url(ok.png)', `url("${P}/css/ok.png")`));
  });

  it('rewrites a url() cut off by the end of the input', () => {
    assert.strictEqual(rc('background:url(x.png'), `background:url("${P}/css/x.png")`);
  });

  it('does not touch url( inside comments or strings, or in other functions', () => {
    const css = '/* url(x.png) */ a{content:"url(y.png)";b:myurl(z.png);c:--url(w.png);d:5url(v.png);e:#url(u.png)}';
    assert.strictEqual(rc(css), css);
  });

  it('is not confused by quotes in comments', () => {
    assert.strictEqual(
      rc("/* don't */ a{b:url(x.png)} /* \" */ c{d:url('y.png')}"),
      `/* don't */ a{b:url("${P}/css/x.png")} /* " */ c{d:url("${P}/css/y.png")}`
    );
  });

  it('rewrites url() in custom properties but not url-like strings', () => {
    assert.strictEqual(rc(':root{--bg:url(bg.png);--s:"url(not.png)"}'), `:root{--bg:url("${P}/css/bg.png");--s:"url(not.png)"}`);
  });

  it('resolves protocol-relative and absolute URLs', () => {
    assert.strictEqual(
      rc('a{b:url(//cdn.example/x.png);c:url(http://o.example/y.png)}'),
      'a{b:url("/p/https://cdn.example/x.png");c:url("/p/http://o.example/y.png")}'
    );
  });

  it('rewrites several URLs in one declaration', () => {
    assert.strictEqual(
      rc('a{background:url(a.png),url("b.png"),linear-gradient(red,blue),cross-fade(url(c.png),url(d.png))}'),
      `a{background:url("${P}/css/a.png"),url("${P}/css/b.png"),linear-gradient(red,blue),cross-fade(url("${P}/css/c.png"),url("${P}/css/d.png"))}`
    );
  });

  it('keeps CDO/CDC and CDATA markers around style sheets', () => {
    assert.strictEqual(rc('<!-- a{b:url(x.png)} -->'), `<!-- a{b:url("${P}/css/x.png")} -->`);
    assert.strictEqual(rc('<![CDATA[ a{b:url(x.png)} ]]>'), `<![CDATA[ a{b:url("${P}/css/x.png")} ]]>`);
  });
});

describe('@import', () => {
  it('rewrites string and url() imports with media queries, layers and supports()', () => {
    assert.strictEqual(rc('@import "a.css";'), `@import "${P}/css/a.css";`);
    assert.strictEqual(rc("@import 'a.css' screen and (min-width: 100px);"), `@import "${P}/css/a.css" screen and (min-width: 100px);`);
    assert.strictEqual(rc('@import url(a.css) print;'), `@import url("${P}/css/a.css") print;`);
    assert.strictEqual(
      rc('@import url("a.css") layer(base) supports(display: grid) screen;'),
      `@import url("${P}/css/a.css") layer(base) supports(display: grid) screen;`
    );
    assert.strictEqual(rc('@IMPORT"a.css";'), `@IMPORT"${P}/css/a.css";`);
    assert.strictEqual(rc('@import /* c */ "a.css";'), `@import /* c */ "${P}/css/a.css";`);
    assert.strictEqual(rc('@\\69mport "a.css";'), `@\\69mport "${P}/css/a.css";`);
  });

  it('rewrites only the first string of the rule', () => {
    assert.strictEqual(rc('@import "a.css" supports(content: "x");'), `@import "${P}/css/a.css" supports(content: "x");`);
    assert.strictEqual(rc('@import "a.css"; a{content:"b.css"}'), `@import "${P}/css/a.css"; a{content:"b.css"}`);
  });

  it('leaves @namespace alone', () => {
    const css = '@namespace svg url(http://www.w3.org/2000/svg); @namespace "http://www.w3.org/1999/xhtml"; svg|a{b:url(x.png)}';
    assert.strictEqual(rc(css), css.replace('url(x.png)', `url("${P}/css/x.png")`));
  });
});

describe('image-set()', () => {
  it('rewrites bare strings and url()s', () => {
    assert.strictEqual(rc('a{b:image-set("a.png" 1x, "b.png" 2x)}'), `a{b:image-set("${P}/css/a.png" 1x, "${P}/css/b.png" 2x)}`);
    assert.strictEqual(
      rc("a{b:-webkit-image-set(url(a.png) 1x, 'b.png' 2x)}"),
      `a{b:-webkit-image-set(url("${P}/css/a.png") 1x, "${P}/css/b.png" 2x)}`
    );
  });

  it('handles type() and nested functions', () => {
    assert.strictEqual(
      rc('a{b:image-set("a.avif" type("image/avif"), "a.jpg" type("image/jpeg"))}'),
      `a{b:image-set("${P}/css/a.avif" type("image/avif"), "${P}/css/a.jpg" type("image/jpeg"))}`
    );
    assert.strictEqual(
      rc('a{b:image-set(linear-gradient(red, blue) 1x, "b.png" 2x)}'),
      `a{b:image-set(linear-gradient(red, blue) 1x, "${P}/css/b.png" 2x)}`
    );
  });
});

describe('@font-face', () => {
  it('rewrites src lists but not local() or format()', () => {
    assert.strictEqual(
      rc('@font-face{font-family:"F";src:local("F"),url(f.woff2) format("woff2"),url(\'f.woff\') format(\'woff\') tech(variations)}'),
      `@font-face{font-family:"F";src:local("F"),url("${P}/css/f.woff2") format("woff2"),url("${P}/css/f.woff") format('woff') tech(variations)}`
    );
  });
});

describe('src()', () => {
  it('rewrites the string argument', () => {
    assert.strictEqual(rc('a{b:src("x.png")}'), `a{b:src("${P}/css/x.png")}`);
  });
});

describe('robustness', () => {
  it('handles unterminated strings, comments and functions', () => {
    for (const css of ['a{b:"unterminated', 'a{b:url(', '/* open', "a{b:url('x", '@import "x', 'a{b:image-set("x"', '\\', 'url(\\', '"\\']) {
      assert.strictEqual(typeof rc(css), 'string', css);
    }
  });

  it('does not rewrite a string broken by a newline', () => {
    const css = '@import "a.css\n"; a{b:c}';
    assert.strictEqual(rc(css), css);
  });

  it('returns the input when there is nothing to rewrite', () => {
    const css = 'a{color:red;font:12px/1.5 "Helvetica Neue",sans-serif}@media (min-width:1px){b{c:d}}';
    assert.strictEqual(rc(css), css);
    assert.strictEqual(rc(''), '');
    assert.strictEqual(rewriteCss(null, BASE), null);
  });

  it('never throws on random input', () => {
    const pieces = ['url(', ')', '(', '"', "'", '\\', '/*', '*/', '@import', '@namespace', ' ', '\n', 'image-set(', 'src(', 'a.png', ';', '{', '}', ',', '-', '5', '#'];
    let seed = 7;
    const rand = (k) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    for (let k = 0; k < 3000; k++) {
      let s = '';
      const len = rand(30);
      for (let j = 0; j < len; j++) s += pieces[rand(pieces.length)];
      assert.strictEqual(typeof rc(s), 'string', JSON.stringify(s));
    }
  });

  it('is fast on large style sheets', () => {
    const rule = '.c{color:red;background:url(/img/a.png) no-repeat,url("b.png");font:12px "Helvetica Neue";content:"x"}\n';
    const css = rule.repeat(Math.ceil((2 * 1024 * 1024) / rule.length));
    const t0 = process.hrtime.bigint();
    const out = rc(css);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(out.includes(`url("${P}/img/a.png")`));
    assert.ok(ms < 1000, `2 MB took ${ms.toFixed(0)} ms`);
  });

  it('stays linear on pathological input', () => {
    for (const css of ['url('.repeat(200000), '"'.repeat(200000), '/*'.repeat(200000), '('.repeat(200000), '\\'.repeat(200000), 'image-set('.repeat(100000)]) {
      const t0 = process.hrtime.bigint();
      rc(css);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      assert.ok(ms < 1000, `${JSON.stringify(css.slice(0, 12))} took ${ms.toFixed(0)} ms`);
    }
  });
});

// ---------------------------------------------------------------------------------------
// Adversarial regressions.

describe('legacy encodings (style sheets passed through as latin1)', () => {
  // Shift_JIS / GBK bytes as the proxy hands them over: one character per byte.
  const bytes = (b) => Buffer.from(b).toString('latin1');
  const GBK = bytes([0xcd, 0xbc, 0xc6, 0xac]); // 图片

  it('keeps non-ASCII URL characters for the browser to encode as it would have', () => {
    assert.strictEqual(rc(`a{b:url(/i/${GBK}.png)}`), `a{b:url("${P}/i/${GBK}.png")}`);
    assert.strictEqual(rc(`a{b:url("${GBK}.png?q=${GBK}")}`), `a{b:url("${P}/css/${GBK}.png?q=${GBK}")}`);
    assert.strictEqual(rc(`@import "${GBK}.css";`), `@import "${P}/css/${GBK}.css";`);
  });

  it('round-trips the bytes of the style sheet', () => {
    const src = Buffer.concat([Buffer.from('a{b:url(/'), Buffer.from([0x95, 0x5c, 0x82, 0xa0]), Buffer.from('.png)}')]);
    const out = Buffer.from(rc(src.toString('latin1')), 'latin1');
    assert.ok(out.includes(Buffer.from([0x95])) && out.includes(Buffer.from([0x82, 0xa0])), out.toString('latin1'));
  });

  it('writes characters that came from escapes back as escapes', () => {
    assert.strictEqual(rc('a{b:url(caf\\e9 .png)}'), `a{b:url("${P}/css/caf\\e9 .png")}`);
    assert.strictEqual(rc('a{b:url("\\691C.png")}'), `a{b:url("${P}/css/\\691c .png")}`);
    // UTF-8 style sheets: a literal character stays literal.
    assert.strictEqual(rc('a{b:url(café.png)}'), `a{b:url("${P}/css/café.png")}`);
  });
});

describe('client-side template placeholders', () => {
  it('leaves templated URLs alone', () => {
    for (const css of ['a{b:url({{img}})}', 'a{b:url("[[bg]]")}', 'a{b:url(/u/${id}.png)}']) assert.strictEqual(rc(css), css);
  });

  it('stays linear on many unclosed placeholders', () => {
    const css = 'a{b:url("' + '{{'.repeat(500000) + '")}';
    const t0 = process.hrtime.bigint();
    rc(css);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.ok(ms < 1000, `${ms.toFixed(0)} ms`);
  });
});

describe('proxifyUrl', () => {
  const { proxifyUrl } = require('../src/rewrite-css');

  it('behaves like proxify for ASCII URLs', () => {
    assert.strictEqual(proxifyUrl('/a b?c#d', BASE), `${P}/a%20b?c#d`);
    assert.strictEqual(proxifyUrl('#frag', BASE), '#frag');
    assert.strictEqual(proxifyUrl('data:x', BASE), 'data:x');
    assert.strictEqual(proxifyUrl(null, BASE), null);
  });

  it('keeps non-ASCII characters in every part of the URL', () => {
    assert.strictEqual(proxifyUrl('//例え.jp/パス?q=値#断片', BASE), '/p/https://例え.jp/パス?q=値#断片');
    assert.strictEqual(proxifyUrl('../é/./x/../ü', BASE), `${P}/é/ü`);
  });

  it('is not fooled by text that looks like its placeholders', () => {
    assert.strictEqual(proxifyUrl('/_zq0_/é', BASE), `${P}/_zq0_/%C3%A9`);
  });

  it('treats a non-ASCII "scheme" as the relative path it is', () => {
    assert.strictEqual(proxifyUrl('😀:x', BASE), `${P}/css/😀:x`);
    assert.strictEqual(proxifyUrl('ht😀tp://x', BASE), `${P}/css/ht😀tp://x`);
  });
});
