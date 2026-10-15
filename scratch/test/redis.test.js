'use strict';

// Runs only when a real Redis is reachable at $X70_REDIS_URL (default redis://127.0.0.1:6379).
// Confirms the zero-dependency RESP client talks to the server the same way MemoryStore does.

const test = require('node:test');
const assert = require('node:assert');
const { RedisClient } = require('../bridge/redis');

const URL = process.env.X70_REDIS_URL || 'redis://127.0.0.1:6379/0';

test('RESP client round-trips against a live Redis', async (t) => {
  const c = new RedisClient(URL);
  try { await c.connect(); await c.command(['PING']); }
  catch { c.close(); return t.skip('no Redis at ' + URL); }
  const key = 'x70test:' + Date.now();
  try {
    assert.equal(await c.command(['SET', key, '10']), 'OK');
    assert.equal(await c.command(['INCRBYFLOAT', key, '2.5']), '12.5');
    await c.command(['RPUSH', key + ':l', 'a', 'b', 'c']);
    assert.deepEqual(await c.command(['LRANGE', key + ':l', 0, -1]), ['a', 'b', 'c']);
    // pipelining: many commands issued before any reply arrives
    const replies = await Promise.all([1, 2, 3, 4, 5].map((n) => c.command(['SET', `${key}:${n}`, String(n)])));
    assert.deepEqual(replies, ['OK', 'OK', 'OK', 'OK', 'OK']);
    const got = await Promise.all([1, 2, 3, 4, 5].map((n) => c.command(['GET', `${key}:${n}`])));
    assert.deepEqual(got, ['1', '2', '3', '4', '5']);
  } finally {
    const keys = await c.command(['KEYS', key + '*']);
    if (keys.length) await c.command(['DEL', ...keys]);
    c.close();
  }
});
