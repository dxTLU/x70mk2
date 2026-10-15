#!/usr/bin/env node
'use strict';

// Single entrypoint for `npm start`: serves the proxy on PORT (default 8000) AND the x70 Scratch
// bridge on its own port (7070) from one command, so opening port 8000 shows the proxy home page
// with the live Scratch-pipeline panel, and the bridge is reachable on 7070.
//
// Proxy-only (the classic behaviour) is still available via `npm run start:proxy`.

process.env.PORT = process.env.PORT || '8000';

const proxy = require('../server'); // server.js exports { start }
proxy.start();

(async () => {
  try {
    const bridge = require('../scratch/bridge/server');
    const b = await bridge.start();
    const stop = () => { try { b.close(); } catch { /* already closing */ } };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (e) {
    // The proxy is the critical service; the bridge is additive. Never let a bridge failure
    // (old Node without node:sqlite, missing folders) take the proxy down.
    console.error(`[x70] Scratch bridge did not start: ${(e && e.message) || e}`);
    console.error('[x70] The proxy is still running. For the bridge, use Node >= 22.13 and run `cd scratch && npm install`.');
  }
})();
