'use strict';

const Redis = require('ioredis');

const config = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: false,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy(times) {
    const delay = Math.min(times * 100, 3000);
    console.log(`[Redis] Reconnecting in ${delay}ms (attempt ${times})...`);
    return delay;
  },
};

// Primary client — used for all read/write operations
const redis = new Redis(config);

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err.message));
redis.on('ready', () => console.log('[Redis] Ready'));

/**
 * Create a dedicated subscriber client.
 * ioredis does not allow a subscribed connection to run other commands,
 * so callers that need Pub/Sub must use this factory.
 */
function createSubscriber() {
  return new Redis(config);
}

/**
 * Create a dedicated blocking client (for BRPOP / XREADGROUP in the worker).
 * Blocking commands occupy the connection, so they need their own client.
 */
function createBlockingClient() {
  const client = new Redis({ ...config, lazyConnect: false });
  client.on('error', (err) =>
    console.error('[Redis Blocking] Error:', err.message)
  );
  return client;
}

module.exports = { redis, createSubscriber, createBlockingClient };
