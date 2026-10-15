#!/usr/bin/env node
'use strict';

// Single entrypoint for `npm start`: serves the proxy on PORT (default 8000) AND the x70 Scratch
// bridge on its own port (7070) from one command, so opening port 8000 shows the proxy home page
// with the live Scratch-pipeline panel and the Studio at /x70/, and the bridge is reachable on 7070.
//
// Proxy-only (the classic behaviour) is still available via `npm run start:proxy`.

const net = require('net');

process.env.PORT = process.env.PORT || '8000';
const PORT = Number(process.env.PORT) || 8000;

/** Resolve true if something is already listening on 127.0.0.1:port. */
function inUse(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(700);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

(async () => {
  if (await inUse(PORT)) {
    console.log(`\n[x70] Already running on port ${PORT} — nothing to do.`);
    console.log(`[x70] Open port ${PORT} in your browser; the Studio is at /x70/.`);
    console.log(`[x70] To restart with the latest code:  fuser -k ${PORT}/tcp 7070/tcp ; npm start\n`);
    process.exit(0);
  }

  const proxy = require('../server'); // server.js exports { start, setMount }
  proxy.start();

  try {
    const bridge = require('../scratch/bridge/server');
    const b = await bridge.start();
    // Mount the bridge under /x70/ on the proxy's port, so it shares the proxy's origin.
    try { proxy.setMount(require('./x70-mount').create(b.port)); } catch { /* mount optional */ }
    const stop = () => { try { b.close(); } catch { /* already closing */ } };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    console.log(`\n[x70] Ready — open port ${PORT}. Home page: /   ·   Studio: /x70/\n`);
  } catch (e) {
    // The proxy is the critical service; the bridge is additive. Never let a bridge failure take
    // the proxy down. Give an accurate hint for the two likely causes.
    console.error(`[x70] Scratch bridge did not start: ${(e && e.message) || e}`);
    if (e && e.code === 'EADDRINUSE') {
      console.error('[x70] Port 7070 is already in use — the bridge is probably already running. Stop it with `fuser -k 7070/tcp`, then retry.');
    } else {
      console.error('[x70] For the bridge, use Node >= 22.13 and run `cd scratch && npm install`. The proxy is still running.');
    }
  }
})();
