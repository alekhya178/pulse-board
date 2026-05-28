'use strict';

const { v4: uuidv4 } = require('uuid');
const { redis } = require('./redis');

const SESSION_TTL = parseInt(process.env.SESSION_TTL_SECONDS || '86400', 10);

/**
 * Create a new session for the given user.
 * Key: session:{token}  →  value: user_id
 * TTL: SESSION_TTL seconds
 */
async function createSession(userId) {
  const token = uuidv4();
  // SETEX — atomic set + expiry
  await redis.setex(`session:${token}`, SESSION_TTL, userId);
  return token;
}

/**
 * Resolve a session token to a user ID.
 * Returns null when the token is missing or expired.
 */
async function getSession(token) {
  return redis.get(`session:${token}`);
}

/**
 * Destroy a session (logout).
 */
async function destroySession(token) {
  return redis.del(`session:${token}`);
}

/**
 * Return remaining TTL for a session token (seconds).
 * Returns -2 if the key does not exist, -1 if it has no expiry.
 */
async function getSessionTTL(token) {
  return redis.ttl(`session:${token}`);
}

/**
 * Extend an existing session's TTL (sliding window).
 */
async function refreshSession(token) {
  return redis.expire(`session:${token}`, SESSION_TTL);
}

module.exports = { createSession, getSession, destroySession, getSessionTTL, refreshSession };
