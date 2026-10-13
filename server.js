#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const config = require('./src/config');
const proxy = require('./src/proxy');
const { handleUpgrade } = require('./src/websocket');
const upstream = require('./src/upstream');

function createServer() {
  const handler = (req, res) => proxy.handle(req, res);
  const server = config.tlsCert && config.tlsKey
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);
  // Expect: 100-continue is answered end to end: the proxy only tells the client to send its body
  // once the origin (or the proxy itself, for local routes) is ready for it.
  server.on('checkContinue', (req, res) => {
    req.expectContinue = true;
    handler(req, res);
  });
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => {
    if (!socket.writable || err.code === 'ECONNRESET') return socket.destroy();
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large'
      : err.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request';
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // allow long uploads / streams
  return server;
}

function start() {
  const server = createServer();
  const maintenance = setInterval(() => proxy.sessions.maintain(), 60000);
  maintenance.unref();

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    clearInterval(maintenance);
    // Persist cookie jars first: everything after this point is best effort.
    proxy.sessions.save();
    if (config.logRequests) console.log(`[proxy] ${signal}: shutting down`);
    server.close(() => process.exit(0));
    server.closeIdleConnections?.();
    // Streams, uploads and WebSockets get a moment to finish before they are cut.
    setTimeout(() => {
      server.closeAllConnections?.();
      process.exit(0);
    }, config.shutdownGraceMs).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Last resort: all state is per request, so one failure must not take every user's session
  // down with it (request handlers already turn their own errors into error pages).
  process.on('uncaughtException', (e) => console.error('[proxy] uncaught exception', e));
  process.on('unhandledRejection', (e) => console.error('[proxy] unhandled rejection', e));

  server.listen(config.port, config.host, () => {
    const scheme = config.tlsCert ? 'https' : 'http';
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log(`Proxy listening on ${scheme}://${shown}:${server.address().port}/`);
    const via = upstream.proxyInfo;
    if (via) console.log(`Outbound traffic via upstream proxy ${via.host}:${via.port}`);
    if (config.allowPrivate) console.log('Warning: ALLOW_PRIVATE is on; private/internal addresses can be proxied.');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start };
