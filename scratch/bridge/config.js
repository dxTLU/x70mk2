'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/** Parse a number that may be written as the string "Infinity" (JSON has no Infinity literal). */
function num(v, fallback) {
  if (v === 'Infinity' || v === Infinity) return Infinity;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readToken(file) {
  if (process.env.X70_BRIDGE_TOKEN) return process.env.X70_BRIDGE_TOKEN;
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch { /* create below */ }
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

/**
 * Load pipeline.config.json (or $X70_CONFIG), resolve every path against the scratch/ directory
 * and fill in the bridge token. Paths in the file stay relative so the folder can be moved.
 */
function load(file = process.env.X70_CONFIG || path.join(ROOT, 'pipeline.config.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(path.resolve(file));
  const abs = (p) => path.resolve(base, p);

  const rt = raw.runtime || {};
  const runtime = {
    framerate: num(rt.framerate, 30),
    interpolation: !!rt.interpolation,
    turbo: !!rt.turbo,
    highQualityPen: !!rt.highQualityPen,
    warpTimer: !!rt.warpTimer,
    maxClones: num(rt.maxClones, 300),
    fencing: rt.fencing !== false,
    miscLimits: rt.miscLimits !== false,
    stageWidth: num(rt.stageWidth, 480),
    stageHeight: num(rt.stageHeight, 360),
    maxTextureDimension: num(rt.maxTextureDimension, 2048),
  };

  const b = raw.bridge || {};
  const dataDir = abs('data');
  const fsRoots = {};
  for (const [name, p] of Object.entries(b.fsRoots || { data: 'data/files' })) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`fsRoots: bad root name ${JSON.stringify(name)}`);
    fsRoots[name] = abs(p);
  }
  const exec = b.exec || {};
  const bridge = {
    host: process.env.X70_BRIDGE_HOST || b.host || '127.0.0.1',
    port: num(process.env.X70_BRIDGE_PORT, num(b.port, 7070)),
    allowedOrigins: b.allowedOrigins || [],
    // Host/Origin suffixes allowed in addition to loopback, so the bridge works behind a
    // forwarded port (Codespaces, tunnels). The Codespaces forwarding domain is picked up
    // automatically; add your own tunnel domains via bridge.allowedHostSuffixes.
    allowedHostSuffixes: [
      ...(b.allowedHostSuffixes || []),
      ...(process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ? [process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN] : []),
    ].map((s) => String(s).toLowerCase().replace(/^\.+/, '')).filter(Boolean),
    fsRoots,
    maxFileBytes: num(b.maxFileBytes, 256 * 1024 * 1024),
    exec: {
      timeoutMs: num(exec.timeoutMs, 30000),
      maxOutputBytes: num(exec.maxOutputBytes, 4 * 1024 * 1024),
      commands: exec.commands || {},
    },
    tokenFile: path.join(dataDir, 'bridge.token'),
  };
  bridge.token = readToken(bridge.tokenFile);

  const r = raw.redis || {};
  const redis = {
    url: process.env.X70_REDIS_URL || r.url || '',
    keyPrefix: r.keyPrefix || '',
    required: !!r.required,
  };

  const sqlite = { path: abs(process.env.X70_SQLITE_PATH || (raw.sqlite && raw.sqlite.path) || 'data/x70.sqlite') };

  const bd = raw.build || {};
  const build = {
    projectsDir: abs(bd.projectsDir || 'projects'),
    outDir: abs(bd.outDir || 'dist'),
    targets: bd.targets || ['html'],
    extract: bd.extract !== false,
    appVersion: bd.appVersion || '1.0.0',
    windowMode: bd.windowMode || 'window',
    gpu: { forceHighPerformance: true, ignoreBlocklist: true, uncappedFps: false, ...(bd.gpu || {}) },
    stampProjects: bd.stampProjects !== false,
    watchDebounceMs: num(bd.watchDebounceMs, 750),
  };

  return { root: base, dataDir, runtime, bridge, redis, sqlite, build };
}

module.exports = { load, ROOT, num };
