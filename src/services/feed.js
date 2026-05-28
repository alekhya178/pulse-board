'use strict';

const { redis } = require('./redis');

const FEED_MAX = parseInt(process.env.FEED_MAX_LENGTH || '100', 10);

/**
 * Push an event entry to the head of a user's activity feed.
 * Key: feed:{userId}  →  Redis List (newest at index 0)
 * After push, trim the list to FEED_MAX entries.
 *
 * Commands: LPUSH, LTRIM
 */
async function pushFeedEvent(userId, event) {
  const key = `feed:${userId}`;
  const payload = JSON.stringify({ ...event, ts: Date.now() });
  const pipeline = redis.pipeline();
  pipeline.lpush(key, payload);
  pipeline.ltrim(key, 0, FEED_MAX - 1);
  await pipeline.exec();
}

/**
 * Retrieve the activity feed for a user (most recent first).
 * Command: LRANGE
 */
async function getFeed(userId, start = 0, stop = FEED_MAX - 1) {
  const key = `feed:${userId}`;
  const items = await redis.lrange(key, start, stop);
  return items.map((raw) => {
    try { return JSON.parse(raw); } catch { return raw; }
  });
}

module.exports = { pushFeedEvent, getFeed };
