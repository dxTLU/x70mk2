'use strict';

// A small pipelined RESP2 client for a local Redis, plus an in-process fallback store with the
// same command subset, so projects keep working (without sharing or persistence) when Redis is
// not running.

const net = require('net');

class RespParser {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) { this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk; }

  /** Return the next complete reply, or undefined when more bytes are needed. */
  next() {
    const r = this._parse(0);
    if (!r) return undefined;
    this.buf = this.buf.subarray(r.end);
    return r;
  }

  _line(pos) {
    const i = this.buf.indexOf('\r\n', pos, 'latin1');
    return i < 0 ? null : { text: this.buf.toString('utf8', pos + 1, i), end: i + 2 };
  }

  _parse(pos) {
    if (pos >= this.buf.length) return null;
    const type = String.fromCharCode(this.buf[pos]);
    const line = this._line(pos);
    if (!line) return null;
    switch (type) {
      case '+': return { value: line.text, end: line.end };
      case '-': return { value: new RedisError(line.text), end: line.end };
      case ':': return { value: Number(line.text), end: line.end };
      case '$': {
        const n = Number(line.text);
        if (n < 0) return { value: null, end: line.end };
        if (this.buf.length < line.end + n + 2) return null;
        return { value: this.buf.toString('utf8', line.end, line.end + n), end: line.end + n + 2 };
      }
      case '*': {
        const n = Number(line.text);
        if (n < 0) return { value: null, end: line.end };
        const out = [];
        let p = line.end;
        for (let i = 0; i < n; i++) {
          const item = this._parse(p);
          if (!item) return null;
          out.push(item.value);
          p = item.end;
        }
        return { value: out, end: p };
      }
      default:
        throw new Error(`RESP protocol error: unexpected byte ${JSON.stringify(type)}`);
    }
  }
}

class RedisError extends Error {}

function encode(args) {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    const s = Buffer.isBuffer(a) ? a : Buffer.from(String(a), 'utf8');
    parts.push(`$${s.length}\r\n`, s, '\r\n');
  }
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'utf8'))));
}

class RedisClient {
  constructor(url) {
    const u = new URL(url);
    if (u.protocol !== 'redis:') throw new Error('Only redis:// URLs are supported (use a local instance)');
    this.host = u.hostname || '127.0.0.1';
    this.port = Number(u.port) || 6379;
    this.password = u.password ? decodeURIComponent(u.password) : '';
    this.username = u.username ? decodeURIComponent(u.username) : '';
    this.db = Number(u.pathname.slice(1)) || 0;
    this.pending = [];
    this.socket = null;
    this.ready = null;
  }

  connect() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const parser = new RespParser();
      s.setNoDelay(true);
      s.once('connect', async () => {
        this.socket = s;
        try {
          if (this.password) await this.call(this.username ? ['AUTH', this.username, this.password] : ['AUTH', this.password]);
          if (this.db) await this.call(['SELECT', this.db]);
          resolve(this);
        } catch (e) { reject(e); }
      });
      s.on('data', (d) => {
        parser.push(d);
        let r;
        try {
          while ((r = parser.next())) {
            const p = this.pending.shift();
            if (!p) continue;
            if (r.value instanceof RedisError) p.reject(r.value); else p.resolve(r.value);
          }
        } catch (e) { s.destroy(e); }
      });
      const fail = (err) => {
        const e = err || new Error('Redis connection closed');
        for (const p of this.pending.splice(0)) p.reject(e);
        this.socket = null;
        this.ready = null;
        reject(e);
      };
      s.on('error', fail);
      s.on('close', () => fail());
    });
    return this.ready;
  }

  /** Send one command. Calls made in the same tick are written back-to-back (pipelined). */
  call(args) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Redis is not connected'));
      this.pending.push({ resolve, reject });
      this.socket.write(encode(args));
    });
  }

  async command(args) {
    if (!this.socket) await this.connect();
    return this.call(args);
  }

  close() {
    if (this.socket) this.socket.end();
  }
}

/** The same command subset as the bridge exposes, kept in process memory. */
class MemoryStore {
  constructor() { this.map = new Map(); this.expiry = new Map(); }

  _alive(k) {
    const t = this.expiry.get(k);
    if (t !== undefined && t <= Date.now()) { this.map.delete(k); this.expiry.delete(k); }
    return this.map.has(k);
  }

  _list(k, create) {
    if (!this._alive(k)) { if (!create) return null; this.map.set(k, []); }
    const v = this.map.get(k);
    if (!Array.isArray(v)) throw new RedisError('WRONGTYPE Operation against a key holding the wrong kind of value');
    return v;
  }

  _hash(k, create) {
    if (!this._alive(k)) { if (!create) return null; this.map.set(k, new Map()); }
    const v = this.map.get(k);
    if (!(v instanceof Map)) throw new RedisError('WRONGTYPE Operation against a key holding the wrong kind of value');
    return v;
  }

  async command([cmd, ...a]) {
    const C = String(cmd).toUpperCase();
    const idx = (list, i) => { i = Number(i); return i < 0 ? list.length + i : i; };
    switch (C) {
      case 'PING': return 'PONG';
      case 'GET': {
        if (!this._alive(a[0])) return null;
        const v = this.map.get(a[0]);
        if (typeof v !== 'string') throw new RedisError('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v;
      }
      case 'SET': {
        this.map.set(a[0], String(a[1]));
        this.expiry.delete(a[0]);
        if (String(a[2] || '').toUpperCase() === 'PX') this.expiry.set(a[0], Date.now() + Number(a[3]));
        return 'OK';
      }
      case 'DEL': {
        let n = 0;
        for (const k of a) if (this._alive(k)) { this.map.delete(k); this.expiry.delete(k); n++; }
        return n;
      }
      case 'EXISTS': return a.filter((k) => this._alive(k)).length;
      case 'INCRBYFLOAT': {
        const cur = this._alive(a[0]) ? Number(this.map.get(a[0])) : 0;
        if (!Number.isFinite(cur)) throw new RedisError('ERR value is not a valid float');
        const v = String(cur + Number(a[1]));
        this.map.set(a[0], v);
        return v;
      }
      case 'RPUSH': { const l = this._list(a[0], true); l.push(...a.slice(1).map(String)); return l.length; }
      case 'LLEN': { const l = this._list(a[0], false); return l ? l.length : 0; }
      case 'LINDEX': { const l = this._list(a[0], false); if (!l) return null; const v = l[idx(l, a[1])]; return v === undefined ? null : v; }
      case 'LSET': {
        const l = this._list(a[0], false);
        if (!l) throw new RedisError('ERR no such key');
        const i = idx(l, a[1]);
        if (i < 0 || i >= l.length) throw new RedisError('ERR index out of range');
        l[i] = String(a[2]);
        return 'OK';
      }
      case 'LRANGE': {
        const l = this._list(a[0], false);
        if (!l) return [];
        const s = Math.max(0, idx(l, a[1]));
        const e = Math.min(l.length - 1, idx(l, a[2]));
        return e < s ? [] : l.slice(s, e + 1);
      }
      case 'HSET': {
        const h = this._hash(a[0], true);
        let n = 0;
        for (let i = 1; i + 1 < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], String(a[i + 1])); }
        return n;
      }
      case 'HGET': { const h = this._hash(a[0], false); return h && h.has(a[1]) ? h.get(a[1]) : null; }
      case 'HDEL': { const h = this._hash(a[0], false); let n = 0; if (h) for (const f of a.slice(1)) if (h.delete(f)) n++; return n; }
      case 'HGETALL': { const h = this._hash(a[0], false); return h ? [...h].flat() : []; }
      case 'PEXPIRE': if (!this._alive(a[0])) return 0; this.expiry.set(a[0], Date.now() + Number(a[1])); return 1;
      case 'KEYS': {
        const pat = String(a[0]);
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return [...this.map.keys()].filter((k) => this._alive(k) && re.test(k));
      }
      default:
        throw new RedisError(`ERR command ${C} is not supported by the in-memory fallback`);
    }
  }

  close() {}
}

/**
 * Connect to Redis at `url`; if that fails and `required` is false, return a MemoryStore.
 * Resolves to { store, kind: 'redis' | 'memory', error? }.
 */
async function open({ url, required }) {
  if (url) {
    const c = new RedisClient(url);
    try {
      await c.connect();
      await c.command(['PING']);
      return { store: c, kind: 'redis' };
    } catch (e) {
      c.close();
      if (required) throw e;
      return { store: new MemoryStore(), kind: 'memory', error: e };
    }
  }
  if (required) throw new Error('redis.required is set but redis.url is empty');
  return { store: new MemoryStore(), kind: 'memory' };
}

module.exports = { RedisClient, MemoryStore, RespParser, RedisError, encode, open };
