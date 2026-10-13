'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { rewriteHtml, rewriteSrcset, decodeEntities } = require('../src/rewrite-html');
const { GUARD } = require('../src/rewrite-js');

const PAGE = 'https://site.example/dir/page.html';
const P = '/p/https://site.example';
const INJ = '<script data-proxy-runtime>window.__PROXY_CFG={"url":"x"};</script><script src="/__proxy/client.js" data-proxy-runtime></script>';

// Plain rewrite (no runtime injected: inline code gets the location guard).
const rw = (html, opts) => rewriteHtml(html, PAGE, opts);
// Rewrite as a top-level document (runtime injected), then drop the injection to compare the rest.
const rwd = (html) => {
  const out = rewriteHtml(html, PAGE, { inject: INJ });
  assert.strictEqual(out.split(INJ).length, 2, 'runtime injected exactly once');
  return out.replace(INJ, '');
};

describe('attribute parsing', () => {
  it('handles unquoted values', () => {
    assert.strictEqual(rw('<a href=foo.html>x</a>'), `<a href="${P}/dir/foo.html">x</a>`);
  });

  it('keeps a trailing slash in an unquoted value (it is part of the value)', () => {
    assert.strictEqual(rw('<a href=/x/>'), `<a href="${P}/x/">`);
  });

  it('handles > and < inside quoted values', () => {
    assert.strictEqual(rw('<a title="a>b<c" href="/x">'), `<a title="a>b<c" href="${P}/x">`);
    assert.strictEqual(rw("<a title='\"q\"' href='/x'>"), `<a title='"q"' href="${P}/x">`);
  });

  it('rewrites every copy of a duplicated attribute', () => {
    assert.strictEqual(rw('<img src="/a.png" src="/b.png">'), `<img src="${P}/a.png" src="${P}/b.png">`);
  });

  it('leaves attributes without values alone', () => {
    assert.strictEqual(rw('<a href>x</a><input disabled src=/i.png>'), `<a href>x</a><input disabled src="${P}/i.png">`);
  });

  it('matches tags and attributes case-insensitively and keeps their case', () => {
    assert.strictEqual(rw('<A HREF="/x">y</A><IMG SrC=/i.png>'), `<A HREF="${P}/x">y</A><IMG SrC="${P}/i.png">`);
  });

  it('keeps the whitespace between newline- and tab-separated attributes', () => {
    assert.strictEqual(
      rw('<img\n  src="/a.png"\n\talt="x"\r\n  srcset="/b.png 2x">'),
      `<img\n  src="${P}/a.png"\n\talt="x"\r\n  srcset="${P}/b.png 2x">`
    );
  });

  it('handles self-closing syntax and stray slashes', () => {
    assert.strictEqual(rw('<img src="/a.png"/>'), `<img src="${P}/a.png"/>`);
    assert.strictEqual(rw('<img / src="/a.png" / >'), `<img / src="${P}/a.png" / >`);
    assert.strictEqual(rw('<img/src="/a.png">'), `<img/src="${P}/a.png">`);
  });

  it('treats a leading = as part of the attribute name, like browsers', () => {
    assert.strictEqual(rw('<a =href="/x">'), '<a =href="/x">');
  });

  it('parses an attribute that follows a quoted value without whitespace', () => {
    assert.strictEqual(rw('<a title="t"href="/x">'), `<a title="t" href="${P}/x">`);
  });

  it('accepts empty values written as name=', () => {
    assert.strictEqual(rw('<a href= >x</a><a href=>y</a>'), '<a href= >x</a><a href=>y</a>');
  });

  it('ignores attributes on end tags', () => {
    assert.strictEqual(rw('</a href="/x">'), '</a href="/x">');
  });

  it('keeps malformed < in text', () => {
    const src = 'a < b, 1<2, <3 << <a href="/x">ok</a> <- <. </ p> </> <?php x ?> <';
    assert.strictEqual(rw(src), src.replace('href="/x"', `href="${P}/x"`));
  });

  it('does not rewrite markup inside bogus comments', () => {
    for (const s of ['</ <a href="/x">', '<? <a href="/x"> ?>', '<! <a href="/x">', '</3 <a href="/x">']) {
      assert.strictEqual(rw(s), s);
    }
  });

  it('leaves a tag cut off by the end of the document untouched', () => {
    assert.strictEqual(rw('<p>x<a href="/x'), '<p>x<a href="/x');
    assert.strictEqual(rw('<p>x<a href=/x'), '<p>x<a href=/x');
    assert.strictEqual(rw('<p>x<a href="/x" '), '<p>x<a href="/x" ');
  });

  it('does not treat non-ASCII spaces as attribute separators', () => {
    assert.strictEqual(rw('<a\u00a0href="/x">'), '<a\u00a0href="/x">');
  });

  it('rewrites URL attributes on custom elements', () => {
    assert.strictEqual(rw('<my-link href="/x"></my-link>'), `<my-link href="${P}/x"></my-link>`);
  });
});

describe('character references', () => {
  it('decodes named, decimal and hex references', () => {
    assert.strictEqual(decodeEntities('a&amp;b&#38;c&#x26;d&AMP;e&lt;&gt;&quot;&apos;&nbsp;'), 'a&b&c&d&e<>"\'\u00a0');
  });

  it('knows the full HTML named reference table', () => {
    assert.strictEqual(
      decodeEntities('&NotNestedGreaterGreater;&fjlig;&Afr;&ThickSpace;&nvlt;&rarr;&hellip;&Tab;&NewLine;&bsol;&grave;&dollar;'),
      '\u2aa2\u0338fj\ud835\udd04\u205f\u200a<\u20d2\u2192\u2026\t\n\\`$'
    );
  });

  it('maps invalid code points the way browsers do', () => {
    assert.strictEqual(
      decodeEntities('&#0;|&#x110000;|&#xD800;|&#128;|&#x80;|&#150;|&#x9D;|&#99999999999999;|&#X41;|&#x0000041;'),
      '\ufffd|\ufffd|\ufffd|\u20ac|\u20ac|\u2013|\u009d|\ufffd|A|A'
    );
  });

  it('leaves text that is not a reference alone', () => {
    assert.strictEqual(decodeEntities('&#x;|&#;|&bogus;|& amp;|&|&&'), '&#x;|&#;|&bogus;|& amp;|&|&&');
  });

  it('accepts numeric references without a semicolon', () => {
    assert.strictEqual(decodeEntities('&#65|&#x41b'), 'A|\u041b');
  });

  it('applies the attribute rule for legacy references without a semicolon', () => {
    // In attribute values "&copy=" and "&notit" stay literal; in text they would be decoded.
    assert.strictEqual(decodeEntities('?a=1&copy=2&notit;&amp=3&copy x&lt'), '?a=1&copy=2&notit;&amp=3\u00a9 x<');
    assert.strictEqual(decodeEntities('&notit;&copy', false), '\u00acit;\u00a9');
  });

  it('decodes references in URLs and re-escapes the result', () => {
    assert.strictEqual(rw('<a href="/s?a=1&amp;b=2">'), `<a href="${P}/s?a=1&amp;b=2">`);
    assert.strictEqual(rw('<a href="/s?a=1&#x26;b=2">'), `<a href="${P}/s?a=1&amp;b=2">`);
    assert.strictEqual(rw('<a href="/s?a=1&#38;b=2">'), `<a href="${P}/s?a=1&amp;b=2">`);
    assert.strictEqual(rw('<a href="/s?a=1&b=2">'), `<a href="${P}/s?a=1&amp;b=2">`);
    assert.strictEqual(rw('<a href="/s?a=1&copy=2">'), `<a href="${P}/s?a=1&amp;copy=2">`);
    assert.strictEqual(rw('<a href="/s?q=&quot;x&quot;&lt;">'), `<a href="${P}/s?q=%22x%22%3C">`);
    assert.strictEqual(rw('<a href="/caf&eacute;">'), `<a href="${P}/caf%C3%A9">`);
    assert.strictEqual(rw('<a href="&#x2F;&#x2F;cdn.example/x">'), '<a href="/p/https://cdn.example/x">');
  });

  it('escapes rewritten values so they survive both HTML and XML parsing', () => {
    assert.strictEqual(
      rwd('<a onclick="if(a&lt;b)location.href=&quot;/x&quot;">'),
      '<a onclick="if(a&lt;b)__pLocation.href=&quot;/x&quot;">'
    );
    assert.strictEqual(rwd('<a onclick="a()&#10;location.reload()">'), '<a onclick="a()&#10;__pLocation.reload()">');
  });

  it('writes characters outside Latin-1 as references (safe for single-byte pages)', () => {
    assert.strictEqual(rwd('<a onclick="x(\'\u2603\');location.reload()">'), '<a onclick="x(\'&#9731;\');__pLocation.reload()">');
    assert.strictEqual(rwd('<a onclick="x(\'&#x1F600;\');location.reload()">'), '<a onclick="x(\'&#128512;\');__pLocation.reload()">');
  });

  it('keeps untouched attributes byte for byte', () => {
    const src = '<a title="&copy; &amp; &#x2603;" class=\'a"b\' data-x=y&amp;z>t</a>';
    assert.strictEqual(rw(src), src);
  });
});

describe('URL-bearing attributes', () => {
  const cases = [
    ['<script src="/a.js"></script>', `<script src="${P}/a.js"></script>`],
    ['<link rel="stylesheet" href="s.css">', `<link rel="stylesheet" href="${P}/dir/s.css">`],
    ['<img src="i.png" lowsrc="l.png" longdesc="d.html">', `<img src="${P}/dir/i.png" lowsrc="${P}/dir/l.png" longdesc="${P}/dir/d.html">`],
    ['<iframe src="/f"></iframe><frame src="g">', `<iframe src="${P}/f"></iframe><frame src="${P}/dir/g">`],
    ['<object data="/o.swf" codebase="/cb/" archive="/a.jar /b.jar"></object>', `<object data="${P}/o.swf" codebase="${P}/cb/" archive="${P}/a.jar ${P}/b.jar"></object>`],
    ['<div data="/x"></div>', '<div data="/x"></div>'],
    ['<embed src="/e.swf" type="application/x-shockwave-flash">', `<embed src="${P}/e.swf" type="application/x-shockwave-flash">`],
    [
      '<video poster="/p.jpg" src="/v.mp4"><source src="/v.webm" type="video/webm"><track kind="captions" src="/c.vtt"></video>',
      `<video poster="${P}/p.jpg" src="${P}/v.mp4"><source src="${P}/v.webm" type="video/webm"><track kind="captions" src="${P}/c.vtt"></video>`,
    ],
    ['<audio src="/a.mp3"></audio>', `<audio src="${P}/a.mp3"></audio>`],
    ['<input type="image" src="/b.png" formaction="/go">', `<input type="image" src="${P}/b.png" formaction="${P}/go">`],
    ['<form action="/submit"><button formaction="/other">x</button></form>', `<form action="${P}/submit"><button formaction="${P}/other">x</button></form>`],
    ['<a href="/x" ping="/p1  https://t.example/p2">', `<a href="${P}/x" ping="${P}/p1  /p/https://t.example/p2">`],
    ['<img src="/i.png" attributionsrc="/a1 /a2">', `<img src="${P}/i.png" attributionsrc="${P}/a1 ${P}/a2">`],
    [
      '<link rel="preload" as="image" imagesrcset="/a.png 1x, /b.png 2x" imagesizes="50vw">',
      `<link rel="preload" as="image" imagesrcset="${P}/a.png 1x, ${P}/b.png 2x" imagesizes="50vw">`,
    ],
    ['<body background="/bg.gif"><table background="t.gif">', `<body background="${P}/bg.gif"><table background="${P}/dir/t.gif">`],
    ['<html manifest="/app.appcache">', `<html manifest="${P}/app.appcache">`],
    [
      '<svg><use xlink:href="/sprite.svg#i"/><use href="#local"/><image href="i.png" width="1"/><filter><feImage href="/f.png"/></filter><a xlink:href="/svg-link"><text>t</text></a></svg>',
      `<svg><use xlink:href="${P}/sprite.svg#i"/><use href="#local"/><image href="${P}/dir/i.png" width="1"/><filter><feImage href="${P}/f.png"/></filter><a xlink:href="${P}/svg-link"><text>t</text></a></svg>`,
    ],
    ['<math><mi href="/m">x</mi></math>', `<math><mi href="${P}/m">x</mi></math>`],
    [
      '<svg><rect fill="url(/paint.svg#g)" stroke="url(#local)" filter="url(&quot;/f.svg#f&quot;)" mask="none"/></svg>',
      `<svg><rect fill="url(&quot;${P}/paint.svg#g&quot;)" stroke="url(#local)" filter="url(&quot;${P}/f.svg#f&quot;)" mask="none"/></svg>`,
    ],
    ['<div itemscope itemtype="https://schema.org/Thing"><blockquote cite="/src">q</blockquote></div>', '<div itemscope itemtype="https://schema.org/Thing"><blockquote cite="/src">q</blockquote></div>'],
    ['<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg>'],
    ['<img src="  /spaced.png  ">', `<img src="${P}/spaced.png">`],
    ['<a href="?page=2">n</a>', `<a href="${P}/dir/page.html?page=2">n</a>`],
    ['<div style="background:url(/d.png)">', `<div style="background:url(&quot;${P}/d.png&quot;)">`],
  ];
  for (const [src, expected] of cases) {
    it(src.slice(0, 70), () => assert.strictEqual(rw(src), expected));
  }

  it('rewrites protocol-relative URLs with the page scheme', () => {
    assert.strictEqual(rw('<script src="//cdn.example/x.js"></script>'), '<script src="/p/https://cdn.example/x.js"></script>');
    assert.strictEqual(rewriteHtml('<img src="//cdn.example/i.png">', 'http://plain.example/'), '<img src="/p/http://cdn.example/i.png">');
  });

  it('leaves data:, blob:, mailto:, tel:, about: and fragment URLs alone', () => {
    const src = '<img src="data:image/png;base64,AAAA"><a href="blob:https://site.example/uuid">b</a>' +
      '<a href="mailto:a@b.example">m</a><a href="tel:+1">t</a><iframe src="about:blank"></iframe><a href="#top">f</a>';
    assert.strictEqual(rw(src), src);
  });

  it('rewrites location inside javascript: URLs without proxying them', () => {
    assert.strictEqual(rwd('<a href="javascript:location.reload()">'), '<a href="javascript:__pLocation.reload()">');
    assert.strictEqual(rwd('<a href=" JavaScript:void(location.href=\'/x\')">'), '<a href=" JavaScript:void(__pLocation.href=\'/x\')">');
    assert.strictEqual(rwd('<a href="java&#9;script:location.reload()">'), '<a href="java&#9;script:__pLocation.reload()">');
    assert.strictEqual(rwd('<iframe src="javascript:parent.location.hash"></iframe>'), '<iframe src="javascript:parent.__pLocation.hash"></iframe>');
    assert.strictEqual(rwd('<a href="javascript:void(0)">'), '<a href="javascript:void(0)">');
  });

  it('rewrites event handlers but not look-alike attributes', () => {
    assert.strictEqual(
      rwd('<button onclick="location.href=\'/x\'" ONMOUSEOVER="location.reload()">'),
      '<button onclick="__pLocation.href=\'/x\'" ONMOUSEOVER="__pLocation.reload()">'
    );
    const src = '<div data-location="location" one-location="location" x-on:click="location.reload()" on="location">';
    assert.strictEqual(rwd(src), src);
  });

  it('guards inline code when the page has no runtime', () => {
    const attr = (html, name) => decodeEntities(new RegExp(` ${name}="([^"]*)"`).exec(html)[1]);
    assert.strictEqual(attr(rw('<a onclick="location.reload()">'), 'onclick'), `${GUARD}__pLocation.reload()`);
    assert.strictEqual(attr(rw('<a href="javascript:location.reload()">'), 'href'), `javascript:${GUARD}__pLocation.reload()`);
  });
});

describe('meta refresh', () => {
  const refresh = (content) => {
    const out = rw(`<meta http-equiv="refresh" content="${content}">`);
    return /content="([^"]*)"/.exec(out)[1];
  };

  it('rewrites the URL in every syntax browsers accept', () => {
    assert.strictEqual(refresh('0;url=/next'), `0;url=${P}/next`);
    assert.strictEqual(refresh("5; URL='/next?a=1&amp;b=2'"), `5; URL='${P}/next?a=1&amp;b=2'`);
    assert.strictEqual(refresh('0, /next'), `0, ${P}/next`);
    assert.strictEqual(refresh('0.5 ; next'), `0.5 ; ${P}/dir/next`);
    assert.strictEqual(refresh('0; url = &quot;https://x.example/&quot;'), '0; url = &quot;/p/https://x.example/&quot;');
    assert.strictEqual(refresh("0;url='/a'b"), `0;url='${P}/a'b`);
    assert.strictEqual(refresh('0;url=/a;b'), `0;url=${P}/a;b`);
    assert.strictEqual(refresh('1;Url=/u'), `1;Url=${P}/u`);
  });

  it('leaves refreshes without a URL alone', () => {
    for (const c of ['3', '0;url=', '0; ', 'x;url=/a', '']) assert.strictEqual(refresh(c), c);
  });

  it('matches http-equiv case-insensitively', () => {
    assert.strictEqual(rw('<META HTTP-EQUIV="Refresh" CONTENT="0;URL=/n">'), `<META HTTP-EQUIV="Refresh" CONTENT="0;URL=${P}/n">`);
  });

  it('leaves other meta content (Open Graph, Twitter, microdata) alone', () => {
    const src = '<meta property="og:image" content="/og.png"><meta name="twitter:image" content="/t.png"><meta itemprop="image" content="/i.png">';
    assert.strictEqual(rw(src), src);
  });
});

describe('<base href>', () => {
  it('resolves later URLs against the base and proxies the base itself', () => {
    assert.strictEqual(
      rw('<head><base href="https://cdn.example/assets/"><link rel=stylesheet href="a.css"></head><body><a href="b.html">b</a><img src="/root.png">'),
      '<head><base href="/p/https://cdn.example/assets/"><link rel=stylesheet href="/p/https://cdn.example/assets/a.css"></head>' +
        '<body><a href="/p/https://cdn.example/assets/b.html">b</a><img src="/p/https://cdn.example/root.png">'
    );
  });

  it('resolves a relative base against the page URL', () => {
    assert.strictEqual(rw('<base href="../other/"><a href="x">'), `<base href="${P}/other/"><a href="${P}/other/x">`);
  });

  it('uses the page URL for fetches made before the base, and the base for links', () => {
    assert.strictEqual(
      rw('<link rel=stylesheet href="a.css"><img src="i.png"><a href="l.html">l</a><form action="f"></form><base href="/sub/"><img src="j.png">'),
      `<link rel=stylesheet href="${P}/dir/a.css"><img src="${P}/dir/i.png"><a href="${P}/sub/l.html">l</a><form action="${P}/sub/f"></form>` +
        `<base href="${P}/sub/"><img src="${P}/sub/j.png">`
    );
  });

  it('only honours the first base element with an href', () => {
    assert.strictEqual(
      rw('<base target="_blank"><base href="/one/"><base href="/two/"><a href="x">'),
      `<base target="_blank"><base href="${P}/one/"><base href="${P}/two/"><a href="${P}/one/x">`
    );
  });

  it('ignores javascript: and data: bases', () => {
    assert.strictEqual(rw('<base href="javascript:void(0)"><a href="x">'), `<base href="javascript:void(0)"><a href="${P}/dir/x">`);
    assert.strictEqual(rw('<base href="data:text/html,x"><a href="x">'), `<base href="data:text/html,x"><a href="${P}/dir/x">`);
  });

  it('does not take a base from comments or scripts', () => {
    assert.strictEqual(
      rwd('<!-- <base href="/c/"> --><script>document.write(\'<base href="/s/">\')</script><a href="x">'),
      `<!-- <base href="/c/"> --><script>document.write('<base href="/s/">')</script><a href="${P}/dir/x">`
    );
  });
});

describe('srcset', () => {
  it('rewrites each candidate and keeps descriptors', () => {
    assert.strictEqual(rewriteSrcset('a.png 1x, /b.png 2x,c.png 300w', PAGE), `${P}/dir/a.png 1x, ${P}/b.png 2x, ${P}/dir/c.png 300w`);
  });

  it('keeps commas inside URLs', () => {
    assert.strictEqual(
      rewriteSrcset('/img/w_100,h_100/a.jpg 100w, /img/w_200,h_200/a.jpg 200w', PAGE),
      `${P}/img/w_100,h_100/a.jpg 100w, ${P}/img/w_200,h_200/a.jpg 200w`
    );
  });

  it('handles trailing commas, extra whitespace and missing descriptors', () => {
    assert.strictEqual(rewriteSrcset('  a.png,  b.png 2x ,  ', PAGE), `${P}/dir/a.png, ${P}/dir/b.png 2x`);
    assert.strictEqual(rewriteSrcset('a.png 1.5x,b.png', PAGE), `${P}/dir/a.png 1.5x, ${P}/dir/b.png`);
  });

  it('leaves data: candidates alone', () => {
    assert.strictEqual(rewriteSrcset('data:image/png;base64,AAAA 1x, b.png 2x', PAGE), `data:image/png;base64,AAAA 1x, ${P}/dir/b.png 2x`);
  });

  it('keeps descriptors with parentheses together', () => {
    assert.strictEqual(rewriteSrcset('a.png 100w (x, y), b.png 2x', PAGE), `${P}/dir/a.png 100w (x, y), ${P}/dir/b.png 2x`);
  });

  it('applies to srcset and imagesrcset but not sizes', () => {
    assert.strictEqual(
      rw('<img srcset="a.png 1x, b.png 2x" sizes="(max-width: 600px) 100vw, 50vw">'),
      `<img srcset="${P}/dir/a.png 1x, ${P}/dir/b.png 2x" sizes="(max-width: 600px) 100vw, 50vw">`
    );
  });

  it('decodes references first', () => {
    assert.strictEqual(rw('<img srcset="/a.png?x=1&amp;y=2 1x">'), `<img srcset="${P}/a.png?x=1&amp;y=2 1x">`);
  });
});

describe('raw text elements', () => {
  it('does not end a script at a split closing tag inside a string', () => {
    assert.strictEqual(
      rwd("<script>var s = '</scr' + 'ipt>'; location.reload();</script><a href=\"/after\">"),
      `<script>var s = '</scr' + 'ipt>'; __pLocation.reload();</script><a href="${P}/after">`
    );
  });

  it('does not rewrite markup inside script strings', () => {
    const src = '<script>document.write("<a href=\'/in\'>x</a><img src=/i.png>")</script>';
    assert.strictEqual(rwd(src), src);
  });

  it('follows the script data escape states (<!-- <script> -->)', () => {
    assert.strictEqual(
      rwd('<script><!--\ndocument.write("<script>x()</script>"); location.reload();\n//--></script><a href="/after">'),
      `<script><!--\ndocument.write("<script>x()</script>"); __pLocation.reload();\n//--></script><a href="${P}/after">`
    );
    assert.strictEqual(rwd('<script>a<!--b</script><a href="/x">'), `<script>a<!--b</script><a href="${P}/x">`);
    assert.strictEqual(rwd('<script><!--></script><a href="/x">'), `<script><!--></script><a href="${P}/x">`);
  });

  it('ends scripts at </script> followed by whitespace, a slash or >, in any case', () => {
    assert.strictEqual(rwd('<script>1</script ><a href="/x">'), `<script>1</script ><a href="${P}/x">`);
    assert.strictEqual(rwd('<SCRIPT>1</SCRIPT/><a href="/x">'), `<SCRIPT>1</SCRIPT/><a href="${P}/x">`);
    assert.strictEqual(rwd('<script>"</scripts>"; location.x</script>'), '<script>"</scripts>"; __pLocation.x</script>');
  });

  it('rewrites CSS in style elements', () => {
    assert.strictEqual(rwd('<style>a{background:url(/s.png)}</style>'), `<style>a{background:url("${P}/s.png")}</style>`);
    const src = '<style>a::after{content:"<a href=/x>"}</style>';
    assert.strictEqual(rwd(src), src);
  });

  it('leaves textarea, title, xmp, iframe, noembed and noframes contents alone', () => {
    const src = '<title>a <a href="/x"> &amp;</title><textarea><a href="/x"></textarea><TEXTAREA><img src=/y></TEXTAREA>' +
      '<xmp><a href="/z"></xmp><iframe><a href="/f"></iframe><noembed><img src="/n"></noembed><noframes><a href="/nf"></noframes>';
    assert.strictEqual(rwd(src), src);
  });

  it('treats <title/> and <textarea/> as open elements in HTML', () => {
    assert.strictEqual(rwd('<title/><a href="/x"></title><a href="/y">'), `<title/><a href="/x"></title><a href="${P}/y">`);
    assert.strictEqual(rwd('<textarea/><a href="/x"></textarea>'), '<textarea/><a href="/x"></textarea>');
  });

  it('rewrites noscript contents without letting them run past </noscript>', () => {
    assert.strictEqual(rwd('<noscript><img src="/n.png"></noscript>'), `<noscript><img src="${P}/n.png"></noscript>`);
    assert.strictEqual(rwd('<noscript><style></noscript><a href="/after">'), `<noscript><style></noscript><a href="${P}/after">`);
  });

  it('rewrites template contents', () => {
    assert.strictEqual(rwd('<template><a href="/t">t</a></template>'), `<template><a href="${P}/t">t</a></template>`);
  });

  it('treats everything after <plaintext> as text', () => {
    const src = '<plaintext><a href="/x"></plaintext><a href="/y">';
    assert.strictEqual(rwd(src), src);
  });

  it('copes with raw text elements that never close', () => {
    assert.strictEqual(rwd('<script>location.reload()'), '<script>__pLocation.reload()');
    assert.strictEqual(rwd('<textarea><a href="/x">'), '<textarea><a href="/x">');
    assert.strictEqual(rwd('<style>a{b:url(/x)}'), `<style>a{b:url("${P}/x")}`);
  });
});

describe('inline scripts', () => {
  it('rewrites only JavaScript types', () => {
    const js = 'location.reload()';
    for (const t of ['', 'text/javascript', 'module', 'application/javascript', 'text/ecmascript', 'TEXT/JAVASCRIPT', ' text/javascript ', 'text/javascript; charset=utf-8', 'text/babel']) {
      assert.strictEqual(rwd(`<script type="${t}">${js}</script>`), `<script type="${t}">__pLocation.reload()</script>`, t);
    }
    for (const t of ['application/json', 'application/ld+json', 'text/template', 'text/x-template', 'text/html', 'text/x-handlebars-template', 'text/plain', 'text/partytown']) {
      const src = `<script type="${t}">{"location": location}</script>`;
      assert.strictEqual(rwd(src), src, t);
    }
  });

  it('uses the language attribute when there is no type', () => {
    assert.strictEqual(rwd('<script language="JavaScript">location.reload()</script>'), '<script language="JavaScript">__pLocation.reload()</script>');
    const vb = '<script language="vbscript">location.reload()</script>';
    assert.strictEqual(rwd(vb), vb);
  });

  it('rewrites import maps and drops their integrity section', () => {
    const map = {
      imports: { lib: '/lib.js', 'https://cdn.example/x': './x.js', './rel/': '../up/', 'node:fs': '/fs.js', bare: 'bare-value' },
      scopes: { '/s/': { a: '/a.js' } },
      integrity: { '/lib.js': 'sha384-x' },
    };
    const out = rwd(`<script type="importmap">${JSON.stringify(map)}</script>`);
    const json = JSON.parse(out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>')));
    assert.deepStrictEqual(json, {
      imports: {
        lib: `${P}/lib.js`,
        '/p/https://cdn.example/x': `${P}/dir/x.js`,
        [`${P}/dir/rel/`]: `${P}/up/`,
        'node:fs': `${P}/fs.js`,
        bare: 'bare-value',
      },
      scopes: { [`${P}/s/`]: { a: `${P}/a.js` } },
    });
  });

  it('never lets rewritten JSON close the script element', () => {
    const out = rwd('<script type="importmap">{"imports":{"\\u003c/script><a>":"/y"}}</script>');
    assert.strictEqual(out.split('</script>').length, 2);
  });

  it('leaves invalid import maps alone', () => {
    const src = '<script type="importmap">{not json</script>';
    assert.strictEqual(rwd(src), src);
  });

  it('rewrites speculation rules', () => {
    const rules = {
      prefetch: [{ source: 'list', urls: ['/next', 'https://o.example/x'] }],
      prerender: [{
        source: 'document',
        where: { and: [{ href_matches: '/*' }, { not: { href_matches: ['/wp-admin/*', '/logout?*', 'https://site.example/x/*', 'https://*.example/*'] } }, { not: { selector_matches: '.no' } }] },
        eagerness: 'moderate',
      }],
    };
    const out = rwd(`<script type="speculationrules">${JSON.stringify(rules)}</script>`);
    const json = JSON.parse(out.slice(out.indexOf('>') + 1, out.lastIndexOf('</script>')));
    const pp = '/p/https\\://site.example';
    assert.deepStrictEqual(json.prefetch[0].urls, [`${P}/next`, '/p/https://o.example/x']);
    assert.deepStrictEqual(json.prerender[0].where, {
      and: [{ href_matches: `${pp}/*` }, { not: { href_matches: [`${pp}/wp-admin/*`, `${pp}/logout?*`, `${pp}/x/*`, 'https://*.example/*'] } }, { not: { selector_matches: '.no' } }],
    });
  });

  it('adds the location guard to scripts in documents without the runtime', () => {
    assert.strictEqual(rw('<script>location.reload()</script>'), `<script>${GUARD}__pLocation.reload()</script>`);
    assert.strictEqual(rw('<script>"use strict";location.reload()</script>'), `<script>"use strict";${GUARD}__pLocation.reload()</script>`);
    assert.ok(!rwd('<script>location.reload()</script>').includes(GUARD));
  });

  it('leaves scripts without location references untouched', () => {
    assert.strictEqual(rw('<script>var a = 1 < 2;</script>'), '<script>var a = 1 < 2;</script>');
  });
});

describe('comments and declarations', () => {
  it('leaves comment contents alone', () => {
    const src = '<!-- <a href="/x"> --><!----><!-- a -- b --><!-- <!-- -->';
    assert.strictEqual(rw(src), src);
  });

  it('rewrites conditional comment contents without recursing forever', () => {
    assert.strictEqual(
      rw('<!--[if lt IE 9]><script src="/html5shiv.js"></script><![endif]--><a href="/after">'),
      `<!--[if lt IE 9]><script src="${P}/html5shiv.js"></script><![endif]--><a href="${P}/after">`
    );
  });

  it('handles downlevel-revealed conditional comments', () => {
    assert.strictEqual(rw('<!--[if !IE]><!--><a href="/x"><!--<![endif]-->'), `<!--[if !IE]><!--><a href="${P}/x"><!--<![endif]-->`);
    assert.strictEqual(rw('<![if !IE]><a href="/x"><![endif]>'), `<![if !IE]><a href="${P}/x"><![endif]>`);
  });

  it('ends comments where browsers do (<!-->, <!--->, --!>, --->)', () => {
    assert.strictEqual(rw('<!--><a href="/a">'), `<!--><a href="${P}/a">`);
    assert.strictEqual(rw('<!---><a href="/b">'), `<!---><a href="${P}/b">`);
    assert.strictEqual(rw('<!-- x --!><a href="/c">'), `<!-- x --!><a href="${P}/c">`);
    assert.strictEqual(rw('<!-- x ---><a href="/d">'), `<!-- x ---><a href="${P}/d">`);
  });

  it('leaves an unterminated comment alone', () => {
    assert.strictEqual(rw('<a href="/x"><!-- <a href="/y">'), `<a href="${P}/x"><!-- <a href="/y">`);
  });

  it('keeps doctypes, including XML internal subsets', () => {
    const src = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
      '<!ENTITY ns "http://x.example/<a href=\'/no\'>">\n<!-- ] -->\n]><svg><image href="/i.png"/></svg>';
    assert.strictEqual(rw(src), src.replace('href="/i.png"', `href="${P}/i.png"`));
  });

  it('treats CDATA as a bogus comment in HTML content', () => {
    assert.strictEqual(rw('<p><![CDATA[ x ]]><a href="/y">'), `<p><![CDATA[ x ]]><a href="${P}/y">`);
  });
});

describe('runtime injection', () => {
  const I = INJ;
  const cases = [
    ['<!DOCTYPE html><html><head><title>t</title></head><body></body></html>', `<!DOCTYPE html><html><head>${I}<title>t</title></head><body></body></html>`],
    ['<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>t</title>', `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${I}<title>t</title>`],
    ['<!DOCTYPE html><p>x</p>', `<!DOCTYPE html>${I}<p>x</p>`],
    ['<head><title>t</title></head>', `<head>${I}<title>t</title></head>`],
    ['<div>fragment</div>', `${I}<div>fragment</div>`],
    ['just text', `${I}just text`],
    ['', I],
    ['<!DOCTYPE html>', `<!DOCTYPE html>${I}`],
    ['<!DOCTYPE html>\n<!-- c -->\n', `<!DOCTYPE html>\n<!-- c -->\n${I}`],
    ['<HTML><HEAD lang="en" data-x="<head>"><TITLE>t</TITLE>', `<HTML><HEAD lang="en" data-x="<head>">${I}<TITLE>t</TITLE>`],
    ['\ufeff<!DOCTYPE html><html><head></head>', `\ufeff<!DOCTYPE html><html><head>${I}</head>`],
    [
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>',
      `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n<html xmlns="http://www.w3.org/1999/xhtml"><head>${I}<title>t</title>`,
    ],
    ['<!-- before --><!DOCTYPE html><html><head><script>1</script>', `<!-- before --><!DOCTYPE html><html><head>${I}<script>1</script>`],
    ['<!DOCTYPE html><!--[if IE]><p>ie</p><![endif]--><html><head><title>t</title>', `<!DOCTYPE html><!--[if IE]><p>ie</p><![endif]--><html><head>${I}<title>t</title>`],
    ['<html><head></head><body><head><title>x</title>', `<html><head>${I}</head><body><head><title>x</title>`],
    ['<html><body><p>x', `<html>${I}<body><p>x`],
    ['<html>\n  text<p>', `<html>${I}\n  text<p>`],
    ['<meta charset="utf-8"><title>t</title>', `<meta charset="utf-8">${I}<title>t</title>`],
    [
      '<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="viewport" content="x">',
      `<head><meta http-equiv="Content-Type" content="text/html; charset=utf-8">${I}<meta name="viewport" content="x">`,
    ],
    ['<html><frameset><frame src="/f"></frameset>', `<html>${I}<frameset><frame src="${P}/f"></frameset>`],
    ['<p>x<a href="/x', `${I}<p>x<a href="/x`],
    ['<a href="/x', `${I}<a href="/x`],
  ];
  for (const [src, expected] of cases) {
    it(JSON.stringify(src).slice(0, 70), () => assert.strictEqual(rewriteHtml(src, PAGE, { inject: I }), expected));
  }

  it('injects before any inline script runs', () => {
    const out = rewriteHtml('<!DOCTYPE html><html><head><script>location.reload()</script>', PAGE, { inject: I });
    assert.ok(out.indexOf(I) < out.indexOf('__pLocation'));
  });

  it('does not inject when no markup is given', () => {
    assert.strictEqual(rw('<head><title>t</title>'), '<head><title>t</title>');
    assert.strictEqual(rewriteHtml('<p>x', PAGE, { inject: null }), '<p>x');
  });

  it('does not rewrite the injected markup', () => {
    assert.ok(rewriteHtml('<p>', PAGE, { inject: I }).startsWith(I));
  });
});

describe('iframe srcdoc', () => {
  it('rewrites the nested document and re-escapes it', () => {
    assert.strictEqual(
      rw('<iframe srcdoc="<p class=&quot;c&quot;><a href=&quot;/in&quot;>i</a><img src=\'/i.png\'></p>"></iframe>'),
      `<iframe srcdoc="&lt;p class=&quot;c&quot;>&lt;a href=&quot;${P}/in&quot;>i&lt;/a>&lt;img src=&quot;${P}/i.png&quot;>&lt;/p>"></iframe>`
    );
  });

  it('handles single-quoted srcdoc holding double quotes', () => {
    assert.strictEqual(rw('<iframe srcdoc=\'<a href="/x">x</a>\'></iframe>'), `<iframe srcdoc="&lt;a href=&quot;${P}/x&quot;>x&lt;/a>"></iframe>`);
  });

  it('handles srcdoc nested inside srcdoc', () => {
    const out = rw('<iframe srcdoc="<iframe srcdoc=\'&lt;a href=&quot;/deep&quot;&gt;\'></iframe>"></iframe>');
    assert.ok(out.includes(`href=&amp;quot;${P}/deep&amp;quot;`), out);
  });

  it('injects the runtime into srcdoc documents too', () => {
    const out = rewriteHtml('<iframe srcdoc="<p>hi</p>"></iframe>', PAGE, { inject: INJ });
    const srcdoc = /srcdoc="([^"]*)"/.exec(out)[1];
    assert.ok(decodeEntities(srcdoc).startsWith(INJ), srcdoc);
  });
});

describe('SVG, MathML and XML', () => {
  it('honours self-closing tags inside inline SVG', () => {
    assert.strictEqual(
      rwd('<svg><title/><style/><script/><image href="/i.png"/></svg><textarea><a href="/x"></textarea>'),
      `<svg><title/><style/><script/><image href="${P}/i.png"/></svg><textarea><a href="/x"></textarea>`
    );
  });

  it('leaves foreign content when an HTML element breaks out of it', () => {
    assert.strictEqual(rwd('<svg><p><textarea><a href="/x"></textarea><a href="/y">'), `<svg><p><textarea><a href="/x"></textarea><a href="${P}/y">`);
    assert.strictEqual(rwd('<math><mi>x</mi><div><title/><a href="/y"></title>'), '<math><mi>x</mi><div><title/><a href="/y"></title>');
  });

  it('applies HTML rules inside foreignObject and returns to SVG after it', () => {
    assert.strictEqual(
      rwd('<svg><foreignObject><textarea><a href="/x"></textarea><div><img src="/i.png"></div></foreignObject><title/><a href="/y"/></svg>'),
      `<svg><foreignObject><textarea><a href="/x"></textarea><div><img src="${P}/i.png"></div></foreignObject><title/><a href="${P}/y"/></svg>`
    );
  });

  it('treats CDATA sections as text in foreign content', () => {
    assert.strictEqual(rwd('<svg><![CDATA[ <a href="/x"> ]]><a href="/y"/></svg>'), `<svg><![CDATA[ <a href="/x"> ]]><a href="${P}/y"/></svg>`);
  });

  it('rewrites CSS and scripts inside inline SVG', () => {
    assert.strictEqual(
      rwd('<svg><style>.a{fill:url(/g.svg#g)}</style><script>location.reload()</script></svg>'),
      `<svg><style>.a{fill:url("${P}/g.svg#g")}</style><script>__pLocation.reload()</script></svg>`
    );
  });

  it('parses tags inside SVG / MathML script and style as markup, like browsers', () => {
    assert.strictEqual(rwd('<svg><script><a href="/x">t</a></script></svg>'), `<svg><script><a href="${P}/x">t</a></script></svg>`);
    assert.strictEqual(rwd('<math><style><img src="/i.png"></style></math>'), `<math><style><img src="${P}/i.png"></style></math>`);
  });

  it('rewrites srcdoc documents found inside fragments with their own runtime', () => {
    const out = rewriteHtml('<noscript><iframe srcdoc="<script>location.reload()</script>"></iframe></noscript>', PAGE, { inject: INJ });
    const srcdoc = decodeEntities(/srcdoc="([^"]*)"/.exec(out)[1]);
    assert.ok(srcdoc.startsWith(INJ), srcdoc);
    assert.ok(srcdoc.endsWith('<script>__pLocation.reload()</script>'), srcdoc);
  });

  it('rewrites standalone SVG documents', () => {
    const svg = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [\n' +
      '<!ENTITY ns "http://x.example/<a href=\'/no\'>">\n]>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="location.hash=\'#a\'"><title/>' +
      '<style><![CDATA[ @import url(/s.css); .a{fill:url(#g)} ]]></style><image xlink:href="/i.png"/>' +
      '<script><![CDATA[ if (a < b) location.reload(); ]]></script></svg>';
    const out = rewriteHtml(svg, PAGE, {});
    assert.ok(out.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg'), out);
    assert.ok(out.includes('<!ENTITY ns "http://x.example/<a href=\'/no\'>">'), out);
    assert.ok(out.includes(`@import url("${P}/s.css")`), out);
    assert.ok(out.includes('fill:url(#g)'), out);
    assert.ok(out.includes(`xlink:href="${P}/i.png"`), out);
    // Script text is XML: whatever the guard contains, it must survive as text (CDATA if needed).
    const script = /<script>([\s\S]*?)<\/script>/.exec(out)[1];
    assert.strictEqual(script.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'), `${GUARD} if (a < b) __pLocation.reload(); `);
    assert.ok(!/[<&]/.test(script.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')), script);
    const onload = / onload="([^"<]*)"/.exec(out);
    assert.ok(onload, out);
    assert.strictEqual(decodeEntities(onload[1]), `${GUARD}__pLocation.hash='#a'`);
  });

  it('honours self-closing tags in XML mode', () => {
    assert.strictEqual(rw('<script src="/a.js"/><a href="/b">', { xml: true }), `<script src="${P}/a.js"/><a href="${P}/b">`);
    // In HTML the same markup opens a script element that swallows the link.
    assert.strictEqual(rwd('<script src="/a.js"/><a href="/b">'), `<script src="${P}/a.js"/><a href="/b">`);
  });

  it('keeps rewritten output well-formed for XML', () => {
    const out = rw('<svg xmlns="http://www.w3.org/2000/svg"><a href="/x?a=1&amp;b=2" onclick="if (a &lt; b) location.reload()"><text>t</text></a></svg>', { xml: true });
    assert.ok(out.includes(`href="${P}/x?a=1&amp;b=2"`), out);
    assert.match(out, /onclick="[^"<]*if \(a &lt; b\) __pLocation\.reload\(\)"/);
  });
});

describe('neutralised security markup', () => {
  it('drops CSP and referrer meta tags', () => {
    assert.strictEqual(
      rwd('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><meta http-equiv="content-security-policy-report-only" content="x">' +
        '<meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width">'),
      '<meta name="viewport" content="width=device-width">'
    );
  });

  it('drops integrity and referrerpolicy attributes', () => {
    assert.strictEqual(
      rw('<script src="/a.js" integrity="sha384-x" crossorigin="anonymous" referrerpolicy="no-referrer"></script>'),
      `<script src="${P}/a.js" crossorigin="anonymous"></script>`
    );
  });

  it('removes noreferrer from rel', () => {
    assert.strictEqual(rw('<a href="/x" rel="noopener noreferrer">'), `<a href="${P}/x" rel="noopener">`);
    assert.strictEqual(rw('<a href="/x" rel=noreferrer>'), `<a href="${P}/x" rel="">`);
  });
});

describe('robustness', () => {
  let seed = 42;
  const rand = (k) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % k;
  };

  it('passes markup without URLs through unchanged', () => {
    const pieces = ['<', '>', '</', '<!--', '-->', '<!', '<?', '"', "'", '=', ' ', '\n', '/', 'b', 'i', 'div', 'p', 'title', 'span', 'x', '&', 'amp;', '&#', 'class', ']]>', '<![CDATA[', '-', '!', '\t'];
    for (let k = 0; k < 4000; k++) {
      let s = '';
      const len = rand(40);
      for (let j = 0; j < len; j++) s += pieces[rand(pieces.length)];
      assert.strictEqual(rw(s), s, JSON.stringify(s));
    }
  });

  it('never throws on random markup', () => {
    const pieces = ['<a href=', '<img src="', '<script>', '</script>', '<style>', '</style>', '<svg>', '</svg>', '<math>', '<title>', '<textarea>',
      '<noscript>', '</noscript>', '<!--', '-->', '<!--[if IE]>', '<![endif]-->', '<base href=/b/>', '<iframe srcdoc="', 'url(', ')', '"', "'", '>',
      '<', '/', 'location', '&amp;', '&#x', '<![CDATA[', ']]>', '<meta http-equiv=refresh content="0;url=', '<plaintext>', '<foreignObject>', ' '];
    for (let k = 0; k < 3000; k++) {
      let s = '';
      const len = rand(30);
      for (let j = 0; j < len; j++) s += pieces[rand(pieces.length)];
      assert.strictEqual(typeof rewriteHtml(s, PAGE, { inject: INJ }), 'string');
      assert.strictEqual(typeof rewriteHtml(s, PAGE, { xml: true }), 'string');
    }
  });

  it('accepts non-string input', () => {
    assert.strictEqual(rewriteHtml(Buffer.from('<a href="/x">'), PAGE), `<a href="${P}/x">`);
    assert.strictEqual(rewriteHtml(undefined, PAGE), '');
  });
});

describe('performance', () => {
  const time = (fn) => {
    const t0 = process.hrtime.bigint();
    const out = fn();
    return { out, ms: Number(process.hrtime.bigint() - t0) / 1e6 };
  };

  it('rewrites a 5 MB document quickly', () => {
    const block = '<div class="item" id="i{n}"><a href="/item/{n}?a=1&amp;b=2" onclick="track({n})">Item {n} &mdash; text</a>' +
      '<img src="img/{n}.jpg" srcset="img/{n}.jpg 1x, img/{n}@2x.jpg 2x" alt="x" loading="lazy">' +
      '<p style="background:url(/bg/{n}.png)">Lorem ipsum dolor sit amet, consectetur adipiscing elit &lt;b&gt;</p></div>\n';
    let html = '<!DOCTYPE html><html><head><title>Big</title><style>' + '.a{background:url(/a.png)}'.repeat(2000) + '</style><script>' +
      'var x = location.href + "<\\/script>";\n'.repeat(2000) + '</script></head><body>';
    const parts = [html];
    let size = html.length;
    for (let n = 0; size < 5 * 1024 * 1024; n++) {
      const b = block.replace(/\{n\}/g, n);
      parts.push(b);
      size += b.length;
    }
    html = parts.join('') + '</body></html>';
    rewriteHtml(html.slice(0, 100000), PAGE, { inject: INJ }); // warm up
    const { out, ms } = time(() => rewriteHtml(html, PAGE, { inject: INJ }));
    assert.ok(out.length > html.length);
    assert.ok(out.includes(`href="${P}/item/1?a=1&amp;b=2"`));
    assert.ok(ms < 1500, `5 MB took ${ms.toFixed(0)} ms`);
  });

  it('stays linear on pathological input', () => {
    const inputs = [
      '<a '.repeat(200000),
      '<!'.repeat(200000),
      '<!--'.repeat(200000),
      '<script><!--' + '<script>'.repeat(100000),
      '<svg>'.repeat(50000) + '</x>'.repeat(50000),
      '<noscript>'.repeat(50000),
      '<!--[if'.repeat(50000) + '-->',
      '<a href="' + '&amp;'.repeat(200000) + '">',
      '<img srcset="' + 'a,'.repeat(200000) + '">',
      '<p title=x'.repeat(100000),
      '<iframe srcdoc="' + '&lt;iframe srcdoc=&quot;'.repeat(20000) + '">',
    ];
    for (const src of inputs) {
      const { ms } = time(() => rewriteHtml(src, PAGE, { inject: INJ }));
      assert.ok(ms < 1500, `${JSON.stringify(src.slice(0, 20))} took ${ms.toFixed(0)} ms`);
    }
  });
});
