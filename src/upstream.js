'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const config = require('./config');

class BlockedError extends Error {
  constructor(msg) { super(msg); this.code = 'EBLOCKED'; }
}

class ProxyError extends Error {
  constructor(msg, status) { super(msg); this.code = 'EPROXY'; this.status = status || 0; }
}

// ---- address classification --------------------------------------------------------------

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
}

// IANA special-purpose IPv4 ranges (RFC 6890 and successors): none of them is a public web site.
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([ip, bits]) => [ipv4ToInt(ip), (~0 << (32 - bits)) >>> 0]);

function isPrivateV4Int(n) {
  return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

/** Parse an IPv6 literal into eight 16-bit groups (embedded dotted IPv4 tails included). */
function parseIPv6(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  if (!net.isIPv6(s)) return null;
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = ipv4ToInt(v4[2]);
    s = v4[1] + (n >>> 16).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length > 1 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(fill, 0)).fill('0'), ...tail].map((h) => parseInt(h, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateV6(g) {
  const v4At = (hi, lo) => isPrivateV4Int(((g[hi] << 16) | g[lo]) >>> 0);
  const zero = (from, to) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 6)) return true; // ::, ::1 and deprecated IPv4-compatible ::a.b.c.d
  if (zero(0, 5) && g[5] === 0xffff) return v4At(6, 7); // IPv4-mapped ::ffff:a.b.c.d
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4At(6, 7); // SIIT ::ffff:0:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b) return zero(2, 6) ? v4At(6, 7) : true; // NAT64 (well-known / local-use)
  if (g[0] === 0x2002) return v4At(1, 2); // 6to4 embeds the IPv4 address
  if (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8 || g[1] === 2 || (g[1] & 0xffe0) === 0x10 || (g[1] & 0xfff0) === 0x20)) {
    return true; // Teredo, documentation, benchmarking, ORCHID
  }
  if (g[0] === 0x100 && zero(1, 4)) return true; // discard-only 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-/site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  if ((g[0] & 0xfff0) === 0x3ff0 && g[0] <= 0x3fff) return true; // 3fff::/20 documentation
  return false;
}

/** True for loopback, private, link-local, reserved and other non-public addresses. */
function isPrivateIp(ip) {
  const s = String(ip).replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) return isPrivateV4Int(ipv4ToInt(s));
  const g = parseIPv6(s);
  if (g) return isPrivateV6(g);
  return true;
}

/**
 * WHATWG-style IPv4 host parsing (decimal, octal, hex and shortened forms such as "2130706433",
 * "0x7f.1" or "0177.0.0.1"). URL parsing already normalises these, but request() may be handed
 * a hostname that never went through it. Returns dotted-quad or null.
 */
function parseLegacyIPv4(host) {
  const parts = String(host).split('.');
  if (parts[parts.length - 1] === '' && parts.length > 1) parts.pop();
  if (!parts.length || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    let n;
    if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : parseInt(p.slice(2), 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p.slice(1), 8);
    else if (/^(?:0|[1-9]\d*)$/.test(p)) n = Number(p);
    else return null;
    nums.push(n);
  }
  const last = nums.pop();
  if (nums.some((n) => n > 255) || last >= 256 ** (4 - nums.length)) return null;
  let v = last;
  nums.forEach((n, i) => { v += n * 256 ** (3 - i); });
  return [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].join('.');
}

// Ports browsers refuse to fetch from (Fetch standard "bad port"): talking HTTP to them is a
// classic cross-protocol attack.
const BAD_PORTS = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

function bareHost(hostname) {
  return String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal|localdomain|home\.arpa|intranet|corp|lan)$/;

function checkHostAllowed(hostname, port) {
  if (config.allowPrivate) return;
  const h = bareHost(hostname);
  if (!h) throw new BlockedError('Missing host name');
  if (INTERNAL_NAME.test(h)) throw new BlockedError(`Refusing to proxy to internal host ${hostname}`);
  const literal = net.isIP(h) ? h : parseLegacyIPv4(h);
  if (literal && isPrivateIp(literal)) throw new BlockedError(`Refusing to proxy to private address ${hostname}`);
  if (port !== undefined && port !== '' && BAD_PORTS.has(Number(port))) {
    throw new BlockedError(`Refusing to connect to port ${port}, which is reserved for non-web services`);
  }
}

/** DNS lookup that refuses private/internal addresses (protects against SSRF & DNS rebinding). */
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!list.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }));
    if (!config.allowPrivate) {
      const bad = list.find((a) => isPrivateIp(a.address));
      if (bad) return callback(new BlockedError(`Refusing to connect to private address ${bad.address} (${hostname})`));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

// ---- optional outbound proxy support -------------------------------------------------

function parseProxy(str) {
  if (!str) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(str) ? str : 'http://' + str);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const auth = u.username
      ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64')
      : null;
    return { url: u, host: bareHost(u.hostname), port: +u.port || (u.protocol === 'https:' ? 443 : 80), auth, secure: u.protocol === 'https:' };
  } catch {
    return null;
  }
}

/** NO_PROXY entries: "*", host names (optionally "*." or "." prefixed), IPs, CIDR ranges, ":port". */
function parseNoProxy(str) {
  const rules = [];
  for (let raw of String(str || '').split(/[,\s]+/)) {
    raw = raw.trim().toLowerCase();
    if (!raw) continue;
    if (raw === '*') { rules.push({ any: true }); continue; }
    const cidr = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/.exec(raw);
    if (cidr && net.isIP(cidr[1])) {
      rules.push({ cidr: cidr[1], bits: +cidr[2], v6: net.isIPv6(cidr[1]) });
      continue;
    }
    let port = null;
    const hp = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(raw);
    if (hp) { raw = hp[1]; port = +hp[2]; }
    const name = bareHost(raw.replace(/^\*?\./, ''));
    if (name) rules.push({ name, port });
  }
  return rules;
}

function inCidr(ip, rule) {
  if (rule.v6) {
    const a = parseIPv6(ip), b = parseIPv6(rule.cidr);
    if (!a || !b) return false;
    let bits = rule.bits;
    for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
      const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
      if ((a[i] & mask) !== (b[i] & mask)) return false;
    }
    return true;
  }
  if (!net.isIPv4(ip)) return false;
  const mask = rule.bits === 0 ? 0 : (~0 << (32 - rule.bits)) >>> 0;
  return ((ipv4ToInt(ip) & mask) >>> 0) === ((ipv4ToInt(rule.cidr) & mask) >>> 0);
}

function shouldBypass(hostname, port, rules) {
  const h = bareHost(hostname);
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h)) return true;
  return rules.some((r) => {
    if (r.any) return true;
    if (r.cidr) return net.isIP(h) !== 0 && inCidr(h, r);
    if (r.port && Number(port) !== r.port) return false;
    return h === r.name || h.endsWith('.' + r.name);
  });
}

let proxyInfo = null;
let noProxyRules = [];
let tunnelHttps = null;
let tunnelHttp = null;

/**
 * Before tunnelling, resolve the name locally when we can: a name that resolves to a private
 * address is refused even though the upstream proxy does the real lookup. Names we cannot
 * resolve (split-horizon DNS, offline resolver) are left to the upstream proxy.
 */
function precheckTunnelHost(host, cb) {
  if (config.allowPrivate || net.isIP(host)) return cb(null);
  let done = false;
  const finish = (err) => { if (!done) { done = true; clearTimeout(timer); cb(err); } };
  const timer = setTimeout(() => finish(null), 2000);
  timer.unref?.();
  dns.lookup(host, { all: true }, (err, list) => {
    if (err || !Array.isArray(list)) return finish(null);
    const bad = list.find((a) => isPrivateIp(a.address));
    finish(bad ? new BlockedError(`Refusing to connect to private address ${bad.address} (${host})`) : null);
  });
}

function connectToProxy(info) {
  return info.secure
    ? tls.connect({ host: info.host, port: info.port, servername: net.isIP(info.host) ? undefined : info.host })
    : net.connect({ host: info.host, port: info.port });
}

/** Open a CONNECT tunnel through the upstream proxy. */
function tunnel(info, host, port, cb) {
  precheckTunnelHost(host, (blocked) => {
    if (blocked) return cb(blocked);
    const sock = connectToProxy(info);
    let done = false;
    const finish = (err, s) => {
      if (done) return;
      done = true;
      if (err) sock.destroy();
      cb(err, s);
    };
    sock.setTimeout(config.upstreamTimeout, () => finish(Object.assign(new ProxyError('Upstream proxy timed out'), { code: 'ETIMEDOUT' })));
    sock.once('error', (e) => finish(Object.assign(new ProxyError(`Upstream proxy unreachable: ${e.message}`), { cause: e })));
    sock.once('close', () => finish(new ProxyError('Upstream proxy closed the connection')));
    const hostPort = (net.isIPv6(host) ? `[${host}]` : host) + ':' + port;
    sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n` +
      (info.auth ? `Proxy-Authorization: ${info.auth}\r\n` : '') + '\r\n');
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (buf.length > 16384) finish(new ProxyError('Invalid response from upstream proxy'));
        return;
      }
      sock.removeListener('data', onData);
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1', 0, idx));
      const status = m ? +m[1] : 0;
      if (status < 200 || status > 299) {
        const why = status === 407 ? 'requires authentication' : status ? `refused the tunnel (${status})` : 'sent an invalid response';
        return finish(new ProxyError(`Upstream proxy ${why}`, status));
      }
      sock.setTimeout(0);
      sock.removeAllListeners('error');
      sock.removeAllListeners('close');
      const rest = buf.subarray(idx + 4);
      if (rest.length) sock.unshift(rest);
      finish(null, sock);
    };
    sock.on('data', onData);
  });
}

class TunnelingAgent extends https.Agent {
  constructor(info, opts) { super(opts); this.info = info; }
  createConnection(options, cb) {
    tunnel(this.info, options.host, options.port, (err, sock) => {
      if (err) return cb(err);
      const servername = options.servername || (net.isIP(options.host) ? undefined : options.host);
      cb(null, tls.connect({ ...options, socket: sock, servername }));
    });
  }
}

class TunnelingHttpAgent extends http.Agent {
  constructor(info, opts) { super(opts); this.info = info; }
  createConnection(options, cb) {
    tunnel(this.info, options.host, options.port, cb);
  }
}

/** (Re)configure the outbound proxy. Called at startup from config; tests call it directly. */
function configureUpstreamProxy(proxyUrl, noProxy) {
  if (tunnelHttps) tunnelHttps.destroy();
  if (tunnelHttp) tunnelHttp.destroy();
  proxyInfo = parseProxy(proxyUrl);
  noProxyRules = parseNoProxy(noProxy);
  tunnelHttps = proxyInfo ? new TunnelingAgent(proxyInfo, { keepAlive: true, maxSockets: 64 }) : null;
  tunnelHttp = proxyInfo ? new TunnelingHttpAgent(proxyInfo, { keepAlive: true, maxSockets: 64 }) : null;
  return proxyInfo;
}

configureUpstreamProxy(config.upstreamProxy, config.noProxy);

const agentOpts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 32, lookup: guardedLookup, scheduling: 'lifo' };
const directHttp = new http.Agent(agentOpts);
const directHttps = new https.Agent(agentOpts);

function viaProxy(url) {
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  return Boolean(proxyInfo) && !shouldBypass(url.hostname, url.port || (secure ? 443 : 80), noProxyRules);
}

function agentFor(url, { upgrade = false } = {}) {
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (viaProxy(url)) {
    // WebSocket upgrades detach the socket, so give them their own non-pooled agent.
    if (upgrade) return new (secure ? TunnelingAgent : TunnelingHttpAgent)(proxyInfo, { keepAlive: false });
    return secure ? tunnelHttps : tunnelHttp;
  }
  if (upgrade) return new (secure ? https.Agent : http.Agent)({ lookup: guardedLookup, keepAlive: false });
  return secure ? directHttps : directHttp;
}

/**
 * Issue a request to the real origin. Throws BlockedError synchronously for addresses that are
 * refused outright; DNS-based refusals arrive as an 'error' event with code EBLOCKED.
 * @returns {http.ClientRequest}
 */
function request(url, { method, headers, upgrade = false }) {
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const port = url.port || (secure ? 443 : 80);
  checkHostAllowed(url.hostname, port);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const opts = {
    protocol: secure ? 'https:' : 'http:',
    hostname: host,
    port,
    path: (url.pathname || '/') + url.search,
    method,
    headers,
    agent: agentFor(url, { upgrade }),
    servername: net.isIP(host) ? undefined : host.replace(/\.$/, ''),
    // Upstream servers in the wild send slightly malformed headers that browsers accept.
    insecureHTTPParser: false,
  };
  return (secure ? https : http).request(opts);
}

module.exports = {
  request, isPrivateIp, parseIPv6, parseLegacyIPv4, checkHostAllowed, guardedLookup,
  BlockedError, ProxyError, BAD_PORTS, parseProxy, parseNoProxy, shouldBypass, configureUpstreamProxy,
  viaProxy,
  get proxyInfo() { return proxyInfo; },
};
