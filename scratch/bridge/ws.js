'use strict';

// Minimal RFC 6455 server side: enough for the bridge's JSON-RPC traffic, with no dependencies.
// Handles masking, fragmentation, ping/pong, close handshakes and a per-message size cap.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const OP = { CONT: 0, TEXT: 1, BIN: 2, CLOSE: 8, PING: 9, PONG: 10 };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxMessageBytes = 64 * 1024 * 1024 } = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = maxMessageBytes;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOp = 0;
    this.closed = false;
    this.isAlive = true;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish(1006, ''));
    socket.on('error', () => socket.destroy());
  }

  get open() { return !this.closed && this.socket.writable; }

  send(data) {
    if (!this.open) return false;
    const binary = Buffer.isBuffer(data) || data instanceof Uint8Array;
    this.socket.write(frame(binary ? OP.BIN : OP.TEXT, binary ? Buffer.from(data) : Buffer.from(String(data), 'utf8')));
    return true;
  }

  /** Send a ping and mark the connection unproven until its pong arrives (see the heartbeat). */
  ping() {
    if (!this.open) return;
    this.isAlive = false;
    this.socket.write(frame(OP.PING, Buffer.alloc(0)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    if (this.socket.writable) this.socket.end(frame(OP.CLOSE, p));
    this._finish(code, reason);
  }

  _finish(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }

  _fail(code, reason) {
    this.close(code, reason);
    this.socket.destroy();
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const op = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (rsv) return this._fail(1002, 'RSV bits set');
      if (!masked) return this._fail(1002, 'client frames must be masked');
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxMessageBytes)) return this._fail(1009, 'message too big');
        len = Number(big); off = 10;
      }
      if (op >= 8 && (len > 125 || !fin)) return this._fail(1002, 'bad control frame');
      if (len > this.maxMessageBytes) return this._fail(1009, 'message too big');
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._onFrame(fin, op, payload);
    }
  }

  _onFrame(fin, op, payload) {
    switch (op) {
      case OP.PING:
        if (this.open) this.socket.write(frame(OP.PONG, payload));
        return;
      case OP.PONG:
        this.isAlive = true;
        return;
      case OP.CLOSE: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        this.close(code === 1005 ? 1000 : code, '');
        return;
      }
      case OP.TEXT:
      case OP.BIN:
        if (this.fragmentOp) return this._fail(1002, 'expected continuation');
        if (fin) return this._deliver(op, payload);
        this.fragmentOp = op;
        this.fragments = [payload];
        this.fragmentBytes = payload.length;
        return;
      case OP.CONT:
        if (!this.fragmentOp) return this._fail(1002, 'unexpected continuation');
        this.fragmentBytes += payload.length;
        if (this.fragmentBytes > this.maxMessageBytes) return this._fail(1009, 'message too big');
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments);
          const o = this.fragmentOp;
          this.fragments = []; this.fragmentOp = 0; this.fragmentBytes = 0;
          this._deliver(o, whole);
        }
        return;
      default:
        this._fail(1002, 'unknown opcode');
    }
  }

  _deliver(op, payload) {
    if (op === OP.TEXT) {
      let text;
      try {
        text = UTF8.decode(payload);
      } catch {
        return this._fail(1007, 'invalid UTF-8');
      }
      this.emit('message', text, false);
    } else {
      this.emit('message', payload, true);
    }
  }
}

/**
 * Complete the upgrade handshake on `socket`. Returns a WebSocketConnection, or null after
 * replying with an error status when the request is not a valid WebSocket upgrade.
 */
function accept(req, socket, head, opts) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key ||
      req.headers['sec-websocket-version'] !== '13') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return null;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const ws = new WebSocketConnection(socket, opts);
  if (head && head.length) ws._onData(head);
  return ws;
}

module.exports = { accept, acceptKey, frame, OP, WebSocketConnection };
