'use strict';

// Print the addresses the proxy can be reached at: node scripts/urls.js <scheme> <port>
const os = require('os');

const [scheme = 'http', port = process.env.PORT || '8080'] = process.argv.slice(2);
console.log(`    ${scheme}://localhost:${port}/`);
for (const list of Object.values(os.networkInterfaces())) {
  for (const a of list || []) {
    if (a.family === 'IPv4' && !a.internal) console.log(`    ${scheme}://${a.address}:${port}/`);
  }
}
