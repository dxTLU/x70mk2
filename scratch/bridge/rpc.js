'use strict';

// Every method a project can call over the bridge. Each takes one params object and returns a
// JSON-serialisable value (or a Promise of one). Errors carry a short `code` for the extension.

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { BridgeError, resolveIn } = require('./sandbox');

const KV_COMMANDS = new Set(['GET', 'SET', 'DEL', 'EXISTS', 'INCRBYFLOAT', 'RPUSH', 'LLEN', 'LINDEX', 'LSET',
  'LRANGE', 'HSET', 'HGET', 'HDEL', 'HGETALL', 'PEXPIRE', 'KEYS', 'PING']);

let lastCpu = null;
function cpuPercent() {
  const now = os.cpus().reduce((a, c) => {
    const t = c.times;
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return a;
  }, { idle: 0, total: 0 });
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total === prev.total) return 0;
  return Math.round(1000 * (1 - (now.idle - prev.idle) / (now.total - prev.total))) / 10;
}
cpuPercent();

function runProcess(cmd, args, { timeoutMs, maxOutputBytes, cwd, stdin }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, stdout: '', stderr: e.message, ms: 0 });
    }
    const out = []; const err = [];
    let bytes = 0; let truncated = false;
    const collect = (arr) => (d) => {
      if (bytes + d.length > maxOutputBytes) { truncated = true; d = d.subarray(0, Math.max(0, maxOutputBytes - bytes)); }
      bytes += d.length;
      if (d.length) arr.push(d);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    const timer = setTimeout(() => { truncated = true; child.kill('SIGKILL'); }, timeoutMs);
    child.on('error', (e) => err.push(Buffer.from(e.message)));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1, signal: signal || '', truncated, ms: Date.now() - started,
        stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
      });
    });
    if (stdin !== undefined && stdin !== null && stdin !== '') child.stdin.end(String(stdin)); else child.stdin.end();
  });
}

/**
 * Build the method table. `ctx` holds { config, kv: {store, kind}, sql, broadcast(name, data, from) }.
 */
function create(ctx) {
  const { config } = ctx;
  const b = config.bridge;
  const prefix = config.redis.keyPrefix || '';
  const k = (key) => {
    key = String(key ?? '');
    if (!key) throw new BridgeError('EARG', 'key is empty');
    return prefix + key;
  };
  const kv = (args) => ctx.kv.store.command(args);
  const at = (root, p) => resolveIn(b.fsRoots, root || Object.keys(b.fsRoots)[0], p);

  const methods = {
    // --- system -------------------------------------------------------------------------------
    'sys.info': () => ({
      platform: process.platform, arch: process.arch, hostname: os.hostname(), release: os.release(),
      cpus: os.cpus().length, cpuModel: (os.cpus()[0] || {}).model || '', cpuPercent: cpuPercent(),
      loadavg: os.loadavg(), totalMem: os.totalmem(), freeMem: os.freemem(), uptime: os.uptime(),
      node: process.version, kv: ctx.kv.kind, roots: Object.keys(b.fsRoots),
      commands: Object.keys(b.exec.commands),
    }),
    'sys.metrics': () => ({
      cpuPercent: cpuPercent(), freeMem: os.freemem(), totalMem: os.totalmem(),
      memPercent: Math.round(1000 * (1 - os.freemem() / os.totalmem())) / 10, loadavg: os.loadavg()[0],
      uptime: os.uptime(), time: Date.now(),
    }),
    'sys.ping': () => Date.now(),

    // --- file system (sandboxed to bridge.fsRoots) ---------------------------------------------
    'fs.read': async ({ root, path: p, encoding = 'utf8' }) => {
      const f = at(root, p);
      const st = await fsp.stat(f);
      if (st.size > b.maxFileBytes) throw new BridgeError('ETOOBIG', 'File is larger than bridge.maxFileBytes');
      const data = await fsp.readFile(f);
      return encoding === 'base64' ? data.toString('base64') : data.toString('utf8');
    },
    'fs.write': async ({ root, path: p, data = '', encoding = 'utf8', append = false }) => {
      const f = at(root, p);
      const buf = encoding === 'base64' ? Buffer.from(String(data), 'base64') : Buffer.from(String(data), 'utf8');
      if (buf.length > b.maxFileBytes) throw new BridgeError('ETOOBIG', 'Data is larger than bridge.maxFileBytes');
      await fsp.mkdir(path.dirname(f), { recursive: true });
      if (append) {
        await fsp.appendFile(f, buf);
      } else {
        // Write-then-rename so a crash never leaves a half-written save file.
        const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
        await fsp.writeFile(tmp, buf);
        await fsp.rename(tmp, f);
      }
      return buf.length;
    },
    'fs.list': async ({ root, path: p = '' }) => {
      const entries = await fsp.readdir(at(root, p), { withFileTypes: true });
      return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
    },
    'fs.stat': async ({ root, path: p }) => {
      try {
        const st = await fsp.stat(at(root, p));
        return { exists: true, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs };
      } catch (e) {
        if (e.code === 'ENOENT') return { exists: false };
        throw e;
      }
    },
    'fs.delete': async ({ root, path: p }) => {
      const f = at(root, p);
      if (f === at(root, '')) throw new BridgeError('EPATH', 'Refusing to delete a root');
      await fsp.rm(f, { recursive: true, force: true });
      return true;
    },
    'fs.mkdir': async ({ root, path: p }) => { await fsp.mkdir(at(root, p), { recursive: true }); return true; },

    // --- processes ----------------------------------------------------------------------------
    'exec.run': async ({ name, args = [], stdin }) => {
      if (!Array.isArray(args)) args = [args];
      args = args.map(String);
      const def = b.exec.commands[name];
      let cmd; let argv;
      if (def) {
        if (args.length && !def.extraArgs) throw new BridgeError('EARG', `Command ${name} does not take extra arguments`);
        cmd = def.cmd; argv = [...(def.args || []), ...args];
      } else {
        throw new BridgeError('EDENIED', `Command ${JSON.stringify(name)} is not in bridge.exec.commands`);
      }
      const cwd = def && def.cwd ? path.resolve(config.root, def.cwd) : config.root;
      return runProcess(cmd, argv, { timeoutMs: b.exec.timeoutMs, maxOutputBytes: b.exec.maxOutputBytes, cwd, stdin });
    },

    // --- Redis / memory cache -----------------------------------------------------------------
    'kv.get': async ({ key }) => kv(['GET', k(key)]),
    'kv.set': async ({ key, value, ttlMs }) => kv(ttlMs > 0 ? ['SET', k(key), String(value ?? ''), 'PX', Math.round(ttlMs)] : ['SET', k(key), String(value ?? '')]),
    'kv.del': async ({ key }) => kv(['DEL', k(key)]),
    'kv.exists': async ({ key }) => (await kv(['EXISTS', k(key)])) > 0,
    'kv.incr': async ({ key, by = 1 }) => Number(await kv(['INCRBYFLOAT', k(key), Number(by) || 0])),
    'kv.keys': async ({ pattern = '*' }) => (await kv(['KEYS', prefix + String(pattern)])).map((x) => x.slice(prefix.length)),
    'list.push': async ({ key, items }) => {
      items = Array.isArray(items) ? items : [items];
      if (!items.length) return kv(['LLEN', k(key)]);
      return kv(['RPUSH', k(key), ...items.map((x) => String(x ?? ''))]);
    },
    'list.replace': async ({ key, items }) => {
      items = Array.isArray(items) ? items : [items];
      await kv(['DEL', k(key)]);
      return items.length ? kv(['RPUSH', k(key), ...items.map((x) => String(x ?? ''))]) : 0;
    },
    'list.range': async ({ key, start = 0, stop = -1 }) => kv(['LRANGE', k(key), Math.trunc(start), Math.trunc(stop)]),
    'list.len': async ({ key }) => kv(['LLEN', k(key)]),
    'list.get': async ({ key, index }) => kv(['LINDEX', k(key), Math.trunc(index)]),
    'list.set': async ({ key, index, value }) => kv(['LSET', k(key), Math.trunc(index), String(value ?? '')]),
    'hash.set': async ({ key, field, value }) => kv(['HSET', k(key), String(field), String(value ?? '')]),
    'hash.get': async ({ key, field }) => kv(['HGET', k(key), String(field)]),
    'hash.del': async ({ key, field }) => kv(['HDEL', k(key), String(field)]),
    'hash.all': async ({ key }) => {
      const flat = await kv(['HGETALL', k(key)]);
      const o = {};
      for (let i = 0; i + 1 < flat.length; i += 2) o[flat[i]] = flat[i + 1];
      return o;
    },
    /** Several cache commands in one round trip (pipelined on the Redis connection). */
    'kv.batch': async ({ commands }) => {
      if (!Array.isArray(commands)) throw new BridgeError('EARG', 'commands must be an array');
      return Promise.all(commands.map(([cmd, key, ...rest]) => {
        const C = String(cmd).toUpperCase();
        if (!KV_COMMANDS.has(C) || C === 'KEYS' || C === 'PING') throw new BridgeError('EDENIED', `Cache command ${C} is not allowed`);
        return kv([C, k(key), ...rest.map(String)]);
      }));
    },

    // --- SQLite -------------------------------------------------------------------------------
    'sql.exec': ({ sql }) => ctx.sql.exec(sql),
    'sql.query': ({ sql, params }) => ctx.sql.query(sql, params),
    'sql.run': ({ sql, params }) => ctx.sql.run(sql, params),
    'sql.insertMany': ({ table, columns, rows }) => ctx.sql.insertMany(table, columns, rows),

    // --- assets & events ----------------------------------------------------------------------
    'assets.list': async ({ path: p = '' }) => {
      if (!b.fsRoots.assets) throw new BridgeError('EROOT', 'No "assets" root configured');
      const out = [];
      const walk = async (rel) => {
        for (const e of await fsp.readdir(at('assets', rel), { withFileTypes: true })) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) await walk(r); else out.push(r);
        }
      };
      await walk(String(p));
      return out.sort();
    },
    'events.publish': ({ name, data }, client) => {
      ctx.broadcast(String(name), data, client);
      return true;
    },
  };

  return methods;
}

module.exports = { create, runProcess };
