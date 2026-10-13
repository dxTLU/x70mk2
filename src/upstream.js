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

function ipv4ToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + (+b), 0) >>> 0;
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([ip, bits]) => [ipv4ToInt(ip), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower);
  }
  return true;
}

/** DNS lookup that refuses private/internal addresses (protects against SSRF & DNS rebinding). */
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    if (!config.allowPrivate) {
      const bad = list.find((a) => isPrivateIp(a.address));
      if (bad) return callback(new BlockedError(`Refusing to connect to private address ${bad.address} (${hostname})`));
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

function checkHostAllowed(hostname) {
  if (config.allowPrivate) return;
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new BlockedError(`Refusing to proxy to internal host ${hostname}`);
  }
  if (net.isIP(h) && isPrivateIp(h)) throw new BlockedError(`Refusing to proxy to private address ${hostname}`);
}

// ---- optional outbound proxy support -------------------------------------------------

function parseProxy(str) {
  if (!str) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(str) ? str : 'http://' + str);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const auth = u.username ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64') : null;
    return { url: u, host: u.hostname, port: +u.port || (u.protocol === 'https:' ? 443 : 80), auth, secure: u.protocol === 'https:' };
  } catch {
    return null;
  }
}

const proxyInfo = parseProxy(config.upstreamProxy);
const noProxyList = config.noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function bypassProxy(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.startsWith('127.')) return true;
  return noProxyList.some((p) => p === '*' || h === p.replace(/^\./, '') || h.endsWith(p.startsWith('.') ? p : '.' + p));
}

function connectToProxy() {
  return proxyInfo.secure
    ? tls.connect({ host: proxyInfo.host, port: proxyInfo.port, servername: proxyInfo.host })
    : net.connect({ host: proxyInfo.host, port: proxyInfo.port });
}

/** Open a CONNECT tunnel through the upstream proxy. */
function tunnel(host, port, cb) {
  const sock = connectToProxy();
  let done = false;
  const finish = (err, s) => { if (!done) { done = true; cb(err, s); } };
  sock.setTimeout(config.upstreamTimeout, () => { sock.destroy(); finish(new Error('Upstream proxy timed out')); });
  sock.once('error', finish);
  const hostPort = (net.isIPv6(host) ? `[${host}]` : host) + ':' + port;
  sock.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n` + (proxyInfo.auth ? `Proxy-Authorization: ${proxyInfo.auth}\r\n` : '') + '\r\n');
  let buf = Buffer.alloc(0);
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) {
      if (buf.length > 16384) { sock.destroy(); finish(new Error('Bad proxy response')); }
      return;
    }
    sock.removeListener('data', onData);
    sock.setTimeout(0);
    const status = /^HTTP\/1\.[01] (\d{3})/.exec(buf.toString('latin1', 0, idx));
    if (!status || status[1] !== '200') {
      sock.destroy();
      return finish(new Error('Upstream proxy refused tunnel: ' + (status ? status[1] : 'invalid response')));
    }
    const rest = buf.subarray(idx + 4);
    if (rest.length) sock.unshift(rest);
    sock.removeListener('error', finish);
    finish(null, sock);
  };
  sock.on('data', onData);
}

class TunnelingAgent extends https.Agent {
  createConnection(options, cb) {
    tunnel(options.host, options.port, (err, sock) => {
      if (err) return cb(err);
      const tsock = tls.connect({ ...options, socket: sock, servername: options.servername || (net.isIP(options.host) ? undefined : options.host) });
      cb(null, tsock);
    });
  }
}

class TunnelingHttpAgent extends http.Agent {
  createConnection(options, cb) {
    tunnel(options.host, options.port, cb);
  }
}

const agentOpts = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 64, maxFreeSockets: 32, lookup: guardedLookup, scheduling: 'lifo' };
const directHttp = new http.Agent(agentOpts);
const directHttps = new https.Agent(agentOpts);
const tunnelHttps = proxyInfo ? new TunnelingAgent({ keepAlive: true, maxSockets: 64 }) : null;
const tunnelHttp = proxyInfo ? new TunnelingHttpAgent({ keepAlive: true, maxSockets: 64 }) : null;

function agentFor(url, { upgrade = false } = {}) {
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (proxyInfo && !bypassProxy(url.hostname)) {
    // WebSocket upgrades detach the socket, so give them their own non-pooled agent.
    if (upgrade) {
      const A = secure ? TunnelingAgent : TunnelingHttpAgent;
      return new A({ keepAlive: false });
    }
    return secure ? tunnelHttps : tunnelHttp;
  }
  if (upgrade) return secure ? new https.Agent({ lookup: guardedLookup }) : new http.Agent({ lookup: guardedLookup });
  return secure ? directHttps : directHttp;
}

/**
 * Issue a request to the real origin.
 * @returns {http.ClientRequest}
 */
function request(url, { method, headers, upgrade = false }) {
  checkHostAllowed(url.hostname);
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const mod = secure ? https : http;
  const opts = {
    protocol: secure ? 'https:' : 'http:',
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: url.port || (secure ? 443 : 80),
    path: (url.pathname || '/') + url.search,
    method,
    headers,
    agent: agentFor(url, { upgrade }),
    servername: net.isIP(url.hostname.replace(/^\[|\]$/g, '')) ? undefined : url.hostname,
  };
  return mod.request(opts);
}

module.exports = { request, isPrivateIp, checkHostAllowed, BlockedError, proxyInfo };
