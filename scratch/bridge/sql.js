'use strict';

// SQLite through Node's built-in node:sqlite (Node 22.13+): no native module to compile.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { BridgeError } = require('./sandbox');

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function plain(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

function params(p) {
  if (p === undefined || p === null || p === '') return [];
  if (!Array.isArray(p) && typeof p !== 'object') return [p];
  return p;
}

class Sql {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL + NORMAL sync: durable across app crashes, fast enough for per-frame writes.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.cache = new Map();
  }

  _stmt(sql) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(sql, s);
    }
    return s;
  }

  exec(sql) {
    this.db.exec(String(sql));
    return true;
  }

  query(sql, p) {
    const s = this._stmt(String(sql));
    const args = params(p);
    const rows = Array.isArray(args) ? s.all(...args) : s.all(args);
    return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, plain(v)])));
  }

  run(sql, p) {
    const s = this._stmt(String(sql));
    const args = params(p);
    const r = Array.isArray(args) ? s.run(...args) : s.run(args);
    return { changes: plain(r.changes), lastInsertRowid: plain(r.lastInsertRowid) };
  }

  /** Insert many rows in a single transaction: the fast path for dumping a whole Scratch list. */
  insertMany(table, columns, rows) {
    if (!IDENT.test(table)) throw new BridgeError('ESQL', 'Bad table name');
    if (!Array.isArray(columns) || !columns.length || !columns.every((c) => IDENT.test(c))) {
      throw new BridgeError('ESQL', 'Bad column list');
    }
    if (!Array.isArray(rows)) throw new BridgeError('ESQL', 'rows must be an array');
    const s = this._stmt(`INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const vals = Array.isArray(row) ? row : [row];
        s.run(...columns.map((_, i) => (vals[i] === undefined ? null : vals[i])));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return { inserted: rows.length };
  }

  close() { this.db.close(); }
}

module.exports = { Sql };
