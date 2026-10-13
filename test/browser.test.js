'use strict';

process.env.ALLOW_PRIVATE = '1';
process.env.PERSIST_SESSIONS = '0';
process.env.HTTPS_PROXY = '';
process.env.HTTP_PROXY = '';
process.env.https_proxy = '';
process.env.http_proxy = '';
process.env.UPSTREAM_PROXY = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');

const browser = require('../src/browser');
const hasBrowser = browser.available();

const describeOrSkip = hasBrowser ? describe : describe.skip;
if (!hasBrowser) console.error('# browser.test.js: Playwright not installed, skipping headless tests');

let site, siteUrl;

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

describeOrSkip('server-side browser engine', () => {
  before(async () => {
    site = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Fixture</title></head><body>
          <h1 id="static">static heading</h1>
          <div id="app"></div>
          <form id="f"><input id="q" name="q"><button type="submit">go</button></form>
          <a id="link" href="/next">next</a>
          <script>
            document.getElementById('app').textContent = 'built by JS';
            setTimeout(() => {
              var d = document.createElement('p'); d.id = 'late'; d.textContent = 'late content';
              document.body.appendChild(d);
            }, 50);
            document.getElementById('f').addEventListener('submit', function (e) {
              e.preventDefault();
              document.getElementById('app').textContent = 'submitted:' + document.getElementById('q').value;
            });
          </script>
        </body></html>`);
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('next page');
      }
    });
    const port = await listen(site);
    siteUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await browser.close();
    site.close();
    site.closeAllConnections?.();
  });

  it('renders a page after its JavaScript runs', async () => {
    const r = await browser.render(`${siteUrl}/`, { waitFor: '#late' });
    assert.strictEqual(r.status, 200);
    assert.match(r.html, /built by JS/);
    assert.match(r.html, /late content/);
    assert.match(r.html, /static heading/);
  });

  it('captures a PNG screenshot', async () => {
    const r = await browser.screenshot(`${siteUrl}/`, { fullPage: true });
    assert.strictEqual(r.type, 'png');
    assert.ok(r.buffer.length > 100);
    assert.strictEqual(r.buffer.toString('latin1', 1, 4), 'PNG');
  });

  it('prints a PDF (chromium)', async () => {
    const r = await browser.pdf(`${siteUrl}/`);
    assert.strictEqual(r.buffer.toString('latin1', 0, 5), '%PDF-');
  });

  it('runs a scripted automation with reads', async () => {
    const { results } = await browser.automate([
      { action: 'goto', url: `${siteUrl}/` },
      { action: 'fill', selector: '#q', value: 'hello' },
      { action: 'click', selector: 'button[type=submit]' },
      { action: 'text', selector: '#app' },
      { action: 'title' },
      { action: 'count', selector: 'a' },
    ]);
    assert.ok(results.every((r) => r.ok !== false), JSON.stringify(results));
    assert.strictEqual(results[3].text, 'submitted:hello');
    assert.strictEqual(results[4].title, 'Fixture');
    assert.strictEqual(results[5].count, 1);
  });

  it('reports unknown actions without crashing', async () => {
    const { results } = await browser.automate(
      [{ action: 'goto', url: `${siteUrl}/` }, { action: 'frobnicate' }],
      { stopOnError: false },
    );
    assert.strictEqual(results[1].error, 'unknown action');
  });

  it('refuses non-http and (by default) private targets', async () => {
    await assert.rejects(() => browser.render('file:///etc/passwd'), /http/i);
    await assert.rejects(() => browser.render('ftp://example.com/'), /http/i);
  });

  it('rejects an empty automation script', async () => {
    await assert.rejects(() => browser.automate([]), /No steps/);
  });
});

describe('browser module without Playwright behaviour', () => {
  it('exposes available() and never throws on load', () => {
    assert.strictEqual(typeof browser.available(), 'boolean');
  });
});
