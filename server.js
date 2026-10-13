#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const config = require('./src/config');
const proxy = require('./src/proxy');
const { handleUpgrade } = require('./src/websocket');
const { proxyInfo } = require('./src/upstream');

function createServer() {
  const handler = (req, res) => proxy.handle(req, res);
  const server = config.tlsCert && config.tlsKey
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // allow long uploads / streams
  return server;
}

function start() {
  const server = createServer();
  const saveTimer = setInterval(() => proxy.sessions.save(), 60000);
  saveTimer.unref();

  const shutdown = () => {
    proxy.sessions.save();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, config.host, () => {
    const scheme = config.tlsCert ? 'https' : 'http';
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log(`Proxy listening on ${scheme}://${shown}:${config.port}/`);
    if (proxyInfo) console.log(`Outbound traffic via upstream proxy ${proxyInfo.host}:${proxyInfo.port}`);
    if (config.allowPrivate) console.log('Warning: ALLOW_PRIVATE is on; private/internal addresses can be proxied.');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createServer, start };
