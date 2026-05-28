'use strict';

const { redis } = require('./redis');

const ONLINE_KEY = 'online_users';

/**
 * Mark a user as online.
 * Key: online_users  →  Redis Set of user IDs
 * Command: SADD
 */
async function setOnline(userId) {
  return redis.sadd(ONLINE_KEY, userId);
}

/**
 * Mark a user as offline.
 * Command: SREM
 */
async function setOffline(userId) {
  return redis.srem(ONLINE_KEY, userId);
}

/**
 * Check if a specific user is online.
 * Command: SISMEMBER  →  returns 1 (online) or 0 (offline)
 */
async function isOnline(userId) {
  const result = await redis.sismember(ONLINE_KEY, userId);
  return result === 1;
}

/**
 * Get all currently online user IDs.
 * Command: SMEMBERS
 */
async function getOnlineUsers() {
  return redis.smembers(ONLINE_KEY);
}

/**
 * Return the count of online users.
 * Command: SCARD
 */
async function onlineCount() {
  return redis.scard(ONLINE_KEY);
}

module.exports = { setOnline, setOffline, isOnline, getOnlineUsers, onlineCount };
