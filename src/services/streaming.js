'use strict';

const { redis } = require('./redis');

const EVENT_STREAM_KEY = process.env.EVENT_STREAM_KEY || 'stream:events';
const CONSUMER_GROUP   = process.env.STREAM_CONSUMER_GROUP || 'workers';

/**
 * Add an event to the Redis Stream.
 * The stream ID is auto-generated ('*').
 * Command: XADD
 *
 * @param {Object} fields  Flat key-value pairs — all values must be strings.
 * @returns {string}       The generated stream entry ID (e.g. "1700000000000-0")
 */
async function addEvent(type, fields = {}) {
  const id = await redis.xadd(
    EVENT_STREAM_KEY,
    '*',
    'type', type,
    'ts',   String(Date.now()),
    ...Object.entries(fields).flat()
  );
  return id;
}

/**
 * Ensure the consumer group exists (called on startup).
 * Uses MKSTREAM so the stream is created if it doesn't already exist.
 */
async function ensureConsumerGroup() {
  try {
    await redis.xgroup('CREATE', EVENT_STREAM_KEY, CONSUMER_GROUP, '$', 'MKSTREAM');
    console.log(`[Streams] Consumer group '${CONSUMER_GROUP}' created`);
  } catch (err) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      // Group already exists — fine
    } else {
      throw err;
    }
  }
}

/**
 * Read pending messages from the stream using a consumer group.
 * Command: XREADGROUP
 *
 * @param {string} consumerName  Unique consumer name within the group
 * @param {number} count         Max entries to fetch
 * @param {Object} [client]      Optional custom Redis client connection
 * @returns {Array}              Parsed message array
 */
async function readEvents(consumerName, count = 10, client = redis) {
  const results = await client.xreadgroup(
    'GROUP', CONSUMER_GROUP, consumerName,
    'COUNT', count,
    'BLOCK', 2000,
    'STREAMS', EVENT_STREAM_KEY, '>'
  );
  if (!results) return [];
  const [, messages] = results[0];
  return messages.map(([id, fields]) => ({
    id,
    data: arrayToObject(fields),
  }));
}

/**
 * Acknowledge a processed stream entry.
 * Command: XACK
 */
async function ackEvent(id) {
  return redis.xack(EVENT_STREAM_KEY, CONSUMER_GROUP, id);
}

/**
 * Get recent stream entries (no consumer group, for inspection).
 * Command: XRANGE
 */
async function getRecentEvents(count = 20) {
  const entries = await redis.xrange(EVENT_STREAM_KEY, '-', '+', 'COUNT', count);
  return entries.map(([id, fields]) => ({ id, data: arrayToObject(fields) }));
}

// Converts ioredis flat array ['k1','v1','k2','v2'] to { k1: 'v1', k2: 'v2' }
function arrayToObject(arr) {
  const obj = {};
  for (let i = 0; i < arr.length; i += 2) obj[arr[i]] = arr[i + 1];
  return obj;
}

module.exports = { addEvent, ensureConsumerGroup, readEvents, ackEvent, getRecentEvents };
