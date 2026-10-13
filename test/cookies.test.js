'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  Jar, SessionStore, parseSetCookie, parseCookieDate, publicSuffix, isPublicSuffix,
  registrableDomain, siteOf, sameSite, MAX_PER_DOMAIN, MAX_LIFETIME_MS,
} = require('../src/cookies');

const U = (s) => new URL(s);
const names = (jar, url, opts) => jar.match(U(url), opts).map((c) => c.name);

describe('public suffixes and sites', () => {
  it('treats single labels and known multi-label suffixes as public', () => {
    for (const s of ['com', 'uk', 'co.uk', 'com.au', 'github.io', 'herokuapp.com', 'co.jp', 'anything.bd']) {
      assert.ok(isPublicSuffix(s), s);
    }
    for (const s of ['example.com', 'bbc.co.uk', 'user.github.io', 'www.example.com.au', 'gov.bd.example.com']) {
      assert.ok(!isPublicSuffix(s), s);
    }
    assert.strictEqual(publicSuffix('a.b.example.co.uk'), 'co.uk');
    assert.strictEqual(publicSuffix('127.0.0.1'), null);
  });

  it('computes registrable domains', () => {
    assert.strictEqual(registrableDomain('www.example.com'), 'example.com');
    assert.strictEqual(registrableDomain('a.b.example.co.uk'), 'example.co.uk');
    assert.strictEqual(registrableDomain('alice.github.io'), 'alice.github.io');
    assert.strictEqual(registrableDomain('x.alice.github.io'), 'alice.github.io');
    assert.strictEqual(registrableDomain('shop.something.bd'), 'shop.something.bd');
    assert.strictEqual(registrableDomain('EXAMPLE.com.'), 'example.com');
    assert.strictEqual(registrableDomain('10.1.2.3'), '10.1.2.3');
    assert.strictEqual(registrableDomain('localhost'), 'localhost');
  });

  it('uses schemeful sites', () => {
    assert.strictEqual(siteOf('https://www.example.com/x'), 'https://example.com');
    assert.strictEqual(siteOf('wss://chat.example.com/'), 'https://example.com');
    assert.ok(sameSite('https://a.example.com', 'https://b.example.com:8443/'));
    assert.ok(!sameSite('http://example.com', 'https://example.com'));
    assert.ok(!sameSite('https://alice.github.io', 'https://bob.github.io'));
    assert.ok(!sameSite('https://a.co.uk', 'https://b.co.uk'));
  });
});

describe('cookie dates', () => {
  it('parses the formats servers actually send', () => {
    const t = Date.UTC(1994, 10, 6, 8, 49, 37);
    assert.strictEqual(parseCookieDate('Sun, 06 Nov 1994 08:49:37 GMT'), t);
    assert.strictEqual(parseCookieDate('Sunday, 06-Nov-94 08:49:37 GMT'), t);
    assert.strictEqual(parseCookieDate('Sun Nov  6 08:49:37 1994'), t);
    assert.strictEqual(parseCookieDate('06 November 1994 8:49:37'), t);
    assert.strictEqual(parseCookieDate('Thu, 01-Jan-1970 00:00:01 GMT'), 1000);
    assert.strictEqual(parseCookieDate('Wed, 01 Jan 30 00:00:00 GMT'), Date.UTC(2030, 0, 1));
  });

  it('rejects impossible dates', () => {
    assert.strictEqual(parseCookieDate('Mon, 31 Feb 2025 00:00:00 GMT'), null);
    assert.strictEqual(parseCookieDate('Mon, 01 Jan 2025 24:00:00 GMT'), null);
    assert.strictEqual(parseCookieDate('Mon, 01 Jan 1600 00:00:00 GMT'), null);
    assert.strictEqual(parseCookieDate('tomorrow'), null);
    assert.strictEqual(parseCookieDate(''), null);
  });
});

describe('Set-Cookie parsing', () => {
  const url = U('https://www.example.com/a/b/page');

  it('defaults path to the directory of the request path', () => {
    assert.strictEqual(parseSetCookie('a=1', url).path, '/a/b');
    assert.strictEqual(parseSetCookie('a=1', U('https://x.com/page')).path, '/');
    assert.strictEqual(parseSetCookie('a=1', U('https://x.com/')).path, '/');
    assert.strictEqual(parseSetCookie('a=1; Path=relative', url).path, '/a/b');
    assert.strictEqual(parseSetCookie('a=1; Path=', url).path, '/a/b');
    assert.strictEqual(parseSetCookie('a=1; Path=/x; Path=/y', url).path, '/y');
  });

  it('gives Max-Age precedence over Expires in any order', () => {
    const now = Date.now();
    const a = parseSetCookie('a=1; Expires=Wed, 01 Jan 2003 00:00:00 GMT; Max-Age=60', url, now);
    const b = parseSetCookie('a=1; Max-Age=60; Expires=Wed, 01 Jan 2003 00:00:00 GMT', url, now);
    assert.strictEqual(a.expires, now + 60000);
    assert.strictEqual(b.expires, now + 60000);
    const bad = parseSetCookie('a=1; Max-Age=1e3; Expires=Wed, 01 Jan 2003 00:00:00 GMT', url, now);
    assert.strictEqual(bad.expires, Date.UTC(2003, 0, 1));
    assert.strictEqual(parseSetCookie('a=1; Max-Age=0', url, now).expires, 0);
    assert.strictEqual(parseSetCookie('a=1; Max-Age=-5', url, now).expires, 0);
    assert.strictEqual(parseSetCookie('a=1; Max-Age=+5', url, now).expires, null);
    assert.strictEqual(parseSetCookie('a=1', url, now).expires, null);
  });

  it('caps lifetimes at 400 days', () => {
    const now = Date.now();
    assert.strictEqual(parseSetCookie('a=1; Max-Age=999999999', url, now).expires, now + MAX_LIFETIME_MS);
    assert.strictEqual(parseSetCookie('a=1; Expires=Fri, 01 Jan 9999 00:00:00 GMT', url, now).expires, now + MAX_LIFETIME_MS);
  });

  it('handles leading dots, case, and trailing dots in Domain', () => {
    const c = parseSetCookie('a=1; Domain=.EXAMPLE.com', url);
    assert.strictEqual(c.domain, 'example.com');
    assert.strictEqual(c.hostOnly, false);
    assert.strictEqual(parseSetCookie('a=1; Domain=example.com.', url).domain, 'example.com');
    const empty = parseSetCookie('a=1; Domain=', url);
    assert.strictEqual(empty.hostOnly, true);
    assert.strictEqual(empty.domain, 'www.example.com');
    assert.strictEqual(parseSetCookie('a=1; Domain=other.com; Domain=example.com', url).domain, 'example.com');
  });

  it('rejects foreign and public-suffix domains', () => {
    assert.strictEqual(parseSetCookie('a=1; Domain=other.com', url), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=ample.com', url), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=com', url), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=co.uk', U('https://www.bbc.co.uk/')), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=com.au', U('https://shop.example.com.au/')), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=github.io', U('https://alice.github.io/')), null);
    assert.ok(parseSetCookie('a=1; Domain=bbc.co.uk', U('https://www.bbc.co.uk/')));
    // A host that is itself a public suffix may set a host-only cookie on itself.
    const self = parseSetCookie('a=1; Domain=github.io', U('https://github.io/'));
    assert.ok(self && self.hostOnly && self.domain === 'github.io');
  });

  it('only lets IP hosts name their exact address', () => {
    const ip = U('http://192.0.2.10/x');
    const ok = parseSetCookie('a=1; Domain=192.0.2.10', ip);
    assert.ok(ok && ok.hostOnly);
    assert.strictEqual(parseSetCookie('a=1; Domain=0.2.10', ip), null);
    assert.strictEqual(parseSetCookie('a=1; Domain=example.com', ip), null);
    const v6 = parseSetCookie('a=1; Domain=[2001:db8::1]', U('http://[2001:db8::1]/'));
    assert.ok(v6 && v6.domain === '2001:db8::1');
  });

  it('accepts internationalised domains in punycode', () => {
    const c = parseSetCookie('a=1; Domain=bücher.example', U('https://www.xn--bcher-kva.example/'));
    assert.strictEqual(c.domain, 'xn--bcher-kva.example');
  });

  it('enforces Secure, prefixes, SameSite=None and Partitioned rules', () => {
    const http = U('http://example.com/');
    assert.strictEqual(parseSetCookie('a=1; Secure', http), null);
    assert.ok(parseSetCookie('a=1; Secure', U('http://localhost:3000/')), 'loopback counts as secure');
    assert.strictEqual(parseSetCookie('__Secure-a=1', url), null);
    assert.strictEqual(parseSetCookie('__secure-a=1', url), null);
    assert.ok(parseSetCookie('__Secure-a=1; Secure', url));
    assert.strictEqual(parseSetCookie('__Host-a=1; Secure', url), null, '__Host- needs an explicit Path=/');
    assert.strictEqual(parseSetCookie('__Host-a=1; Secure; Path=/; Domain=example.com', url), null);
    assert.strictEqual(parseSetCookie('__Host-a=1; Path=/', url), null);
    assert.strictEqual(parseSetCookie('__HOST-a=1; Path=/', url), null);
    assert.ok(parseSetCookie('__Host-a=1; Secure; Path=/', url));
    assert.strictEqual(parseSetCookie('__Host-x=1', url), null);
    assert.strictEqual(parseSetCookie('=__Secure-x=1', url), null, 'nameless cookies cannot fake a prefix');
    assert.strictEqual(parseSetCookie('a=1; SameSite=None', url), null);
    assert.strictEqual(parseSetCookie('a=1; SameSite=None; Secure', url).sameSite, 'none');
    assert.strictEqual(parseSetCookie('a=1; SameSite=bogus', url).sameSite, 'default');
    assert.strictEqual(parseSetCookie('a=1; Partitioned', url), null);
    const p = parseSetCookie('a=1; Secure; Partitioned; SameSite=None; Path=/', url);
    assert.ok(p && p.partitioned);
  });

  it('enforces size limits and rejects control characters', () => {
    assert.ok(parseSetCookie('a=' + 'x'.repeat(4095), url));
    assert.strictEqual(parseSetCookie('a=' + 'x'.repeat(4096), url), null);
    const longPath = parseSetCookie('a=1; Path=/' + 'p'.repeat(1100), url);
    assert.strictEqual(longPath.path, '/a/b', 'over-long attribute values are ignored');
    assert.strictEqual(parseSetCookie('a=1\x00; Path=/', url), null);
    assert.strictEqual(parseSetCookie('a=b\nc', url), null);
    assert.ok(parseSetCookie('a=b\tc', url), 'HTAB is allowed');
    assert.strictEqual(parseSetCookie('', url), null);
    assert.strictEqual(parseSetCookie('=', url), null);
  });

  it('accepts nameless cookies', () => {
    const jar = new Jar();
    assert.ok(jar.set('justvalue', url));
    assert.strictEqual(jar.header(url), 'justvalue');
  });
});

describe('cookie jar', () => {
  it('scopes host-only and domain cookies', () => {
    const jar = new Jar();
    jar.set('host=1', U('https://example.com/'));
    jar.set('dom=1; Domain=example.com', U('https://example.com/'));
    assert.deepStrictEqual(names(jar, 'https://example.com/'), ['host', 'dom']);
    assert.deepStrictEqual(names(jar, 'https://sub.example.com/'), ['dom']);
    assert.deepStrictEqual(names(jar, 'https://notexample.com/'), []);
  });

  it('matches paths per RFC 6265 and orders by specificity then age', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('root=1; Path=/', u);
    jar.set('foo=1; Path=/foo', u);
    jar.set('deep=1; Path=/foo/bar/', u);
    assert.deepStrictEqual(names(jar, 'https://example.com/foo/bar/baz'), ['deep', 'foo', 'root']);
    assert.deepStrictEqual(names(jar, 'https://example.com/foo'), ['foo', 'root']);
    assert.deepStrictEqual(names(jar, 'https://example.com/foobar'), ['root']);
    assert.deepStrictEqual(names(jar, 'https://example.com/foo/bar'), ['foo', 'root']);
  });

  it('sends Secure cookies only to secure targets', () => {
    const jar = new Jar();
    jar.set('s=1; Secure', U('https://example.com/'));
    jar.set('p=1', U('https://example.com/'));
    assert.deepStrictEqual(names(jar, 'https://example.com/'), ['s', 'p']);
    assert.deepStrictEqual(names(jar, 'http://example.com/'), ['p']);
    assert.deepStrictEqual(names(jar, 'wss://example.com/'), ['s', 'p']);
  });

  it('does not let insecure origins shadow Secure cookies', () => {
    const jar = new Jar();
    jar.set('sid=good; Secure; Path=/', U('https://example.com/'));
    assert.strictEqual(jar.set('sid=evil; Path=/', U('http://example.com/')), false);
    assert.strictEqual(jar.set('sid=evil; Path=/x', U('http://example.com/')), false);
    assert.strictEqual(jar.header(U('https://example.com/')), 'sid=good');
    assert.ok(jar.set('sid=new; Path=/', U('https://example.com/')), 'secure origins can still replace it');
  });

  it('replaces cookies in place and keeps their creation time', async () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('a=1; Path=/', u);
    jar.set('b=1; Path=/', u);
    const created = jar.match(u)[0].created;
    await new Promise((r) => setTimeout(r, 5));
    jar.set('a=2; Path=/', u);
    assert.strictEqual(jar.header(u), 'a=2; b=1');
    assert.strictEqual(jar.match(u)[0].created, created);
    assert.strictEqual(jar.size, 2);
  });

  it('deletes cookies with past expiry dates or Max-Age<=0', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('a=1; Path=/', u);
    jar.set('b=1; Path=/', u);
    jar.set('a=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', u);
    jar.set('b=; Path=/; Max-Age=0', u);
    assert.strictEqual(jar.header(u), '');
    assert.strictEqual(jar.size, 0);
    jar.set('c=1; Path=/other', u);
    jar.set('c=; Max-Age=0', u); // different (default) path: not the same cookie
    assert.strictEqual(jar.size, 1);
  });

  it('expires cookies over time', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('a=1; Max-Age=60', u);
    jar.cookies.values().next().value.expires = Date.now() - 1;
    assert.strictEqual(jar.header(u), '');
    assert.strictEqual(jar.size, 0);
  });

  it('keeps HttpOnly cookies away from scripts', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('sid=1; HttpOnly; Path=/', u);
    jar.set('ui=1; Path=/', u);
    assert.strictEqual(jar.header(u, { includeHttpOnly: false }), 'ui=1');
    assert.strictEqual(jar.set('sid=hacked; Path=/', u, { fromScript: true }), false);
    assert.strictEqual(jar.set('new=1; HttpOnly; Path=/', u, { fromScript: true }), false);
    assert.strictEqual(jar.header(u), 'sid=1; ui=1');
  });

  it('applies SameSite rules to the request context', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('strict=1; SameSite=Strict; Path=/', u);
    jar.set('lax=1; SameSite=Lax; Path=/', u);
    jar.set('dflt=1; Path=/', u);
    jar.set('none=1; SameSite=None; Secure; Path=/', u);
    assert.deepStrictEqual(names(jar, 'https://example.com/', { context: 'same-site', method: 'POST' }), ['strict', 'lax', 'dflt', 'none']);
    assert.deepStrictEqual(names(jar, 'https://example.com/', { context: 'top-nav', method: 'GET' }), ['lax', 'dflt', 'none']);
    // Lax-allowing-unsafe: fresh default cookies still go along with a cross-site top-level POST.
    assert.deepStrictEqual(names(jar, 'https://example.com/', { context: 'top-nav', method: 'POST' }), ['dflt', 'none']);
    assert.deepStrictEqual(names(jar, 'https://example.com/', { context: 'cross-site', method: 'GET' }), ['none']);
    for (const c of jar.cookies.values()) c.created -= 3 * 60 * 1000;
    assert.deepStrictEqual(names(jar, 'https://example.com/', { context: 'top-nav', method: 'POST' }), ['none']);
  });

  it('ignores non-None cookies set by cross-site subresource responses', () => {
    const jar = new Jar();
    const u = U('https://tracker.example/');
    assert.strictEqual(jar.set('a=1', u, { context: 'cross-site' }), false);
    assert.strictEqual(jar.set('b=1; SameSite=Lax', u, { context: 'cross-site' }), false);
    assert.ok(jar.set('c=1; SameSite=None; Secure', u, { context: 'cross-site' }));
    assert.ok(jar.set('d=1; SameSite=Strict', u, { context: 'top-nav' }));
  });

  it('caps cookies per registrable domain, evicting least recently used first', () => {
    const jar = new Jar();
    const u = U('https://a.example.com/');
    for (let i = 0; i < MAX_PER_DOMAIN; i++) jar.set(`c${i}=1; Domain=example.com; Path=/`, u);
    jar.cookies.get('c7\u0000example.com\u00000\u0000/').lastAccess = 0; // least recently used
    jar.set('newest=1; Domain=example.com; Path=/', u);
    assert.strictEqual(jar.size, MAX_PER_DOMAIN);
    const all = names(jar, 'https://example.com/');
    assert.ok(all.includes('newest'));
    assert.ok(!all.includes('c7'));
    assert.ok(all.includes('c0'));
    // Other sites are unaffected.
    jar.set('other=1', U('https://other.org/'));
    assert.strictEqual(jar.size, MAX_PER_DOMAIN + 1);
  });

  it('round-trips through JSON including session cookies', () => {
    const jar = new Jar();
    const u = U('https://example.com/');
    jar.set('session=1; Path=/', u);
    jar.set('persistent=1; Path=/; Max-Age=600; SameSite=Strict', u);
    const restored = new Jar(JSON.parse(JSON.stringify(jar)));
    assert.strictEqual(restored.header(u), 'session=1; persistent=1');
    assert.strictEqual(restored.header(u, { context: 'cross-site' }), '');
  });
});

describe('session store', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-sessions-'));

  it('persists jars with 0600 permissions and restores them', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'nested', 'sessions.json');
    const store = new SessionStore({ file, persist: true, ttlMs: 3600e3 });
    store.get('session-a').set('sid=1; Path=/', U('https://example.com/'));
    store.get('session-empty');
    assert.ok(store.save());
    const mode = fs.statSync(file).mode & 0o777;
    assert.strictEqual(mode, 0o600);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(saved), ['session-a'], 'empty jars are not written');
    const again = new SessionStore({ file, persist: true, ttlMs: 3600e3 });
    assert.strictEqual(again.get('session-a').header(U('https://example.com/')), 'sid=1');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tightens permissions of an existing file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '{}', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const store = new SessionStore({ file, persist: true, ttlMs: 3600e3 });
    store.get('s').set('a=1', U('https://example.com/'));
    store.save();
    assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('survives a corrupt data file', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'sessions.json');
    fs.writeFileSync(file, '{not json');
    const origError = console.error;
    console.error = () => {};
    try {
      const store = new SessionStore({ file, persist: true, ttlMs: 3600e3 });
      assert.strictEqual(store.jars.size, 0);
    } finally {
      console.error = origError;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('forgets idle sessions and idle empty jars', () => {
    const store = new SessionStore({ file: '/nonexistent/x.json', persist: false, ttlMs: 3600e3 });
    store.get('busy').set('a=1', U('https://example.com/'));
    store.get('empty');
    store.get('old').set('a=1', U('https://example.com/'));
    store.jars.get('old').lastUsed = Date.now() - 7200e3;
    store.get('cleared').set('a=1', U('https://example.com/'));
    store.get('cleared').clear();
    store.sweep();
    assert.deepStrictEqual([...store.jars.keys()].sort(), ['busy', 'cleared']);
    assert.deepStrictEqual([...store.pending.keys()], ['empty'], 'cookie-less visitors are not sessions');
    store.sweep(Date.now() + 11 * 60 * 1000);
    assert.deepStrictEqual([...store.jars.keys()], ['busy']);
    assert.strictEqual(store.pending.size, 0);
  });

  it('bounds the jars of visitors that never receive a cookie', () => {
    const store = new SessionStore({ file: '/nonexistent/x.json', persist: false, ttlMs: 3600e3 });
    for (let i = 0; i < 12000; i++) store.get('crawler-' + i);
    assert.ok(store.pending.size <= 10000);
    assert.strictEqual(store.jars.size, 0);
  });

  it('shares one jar between concurrent requests of a new session', () => {
    const store = new SessionStore({ file: '/nonexistent/x.json', persist: false, ttlMs: 3600e3 });
    const a = store.get('new');
    const b = store.get('new');
    a.set('x=1', U('https://example.com/'));
    b.set('y=1', U('https://example.com/'));
    assert.strictEqual(store.get('new').header(U('https://example.com/')), 'x=1; y=1');
  });
});
