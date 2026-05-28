'use strict';

const { v4: uuidv4 } = require('uuid');
const { redis } = require('./redis');

const LOCK_TTL = parseInt(process.env.LOCK_TTL_SECONDS || '30', 10);

/**
 * Acquire a distributed lock.
 *
 * Uses SET key value NX EX timeout — atomic in a single command.
 * Returns the lock token (owner ID) on success, or null if already locked.
 *
 * Command: SET key value NX EX ttl
 */
async function acquireLock(resource) {
  const lockKey   = `lock:${resource}`;
  const lockToken = uuidv4();
  const result    = await redis.set(lockKey, lockToken, 'NX', 'EX', LOCK_TTL);
  if (result === 'OK') {
    console.log(`[Lock] Acquired lock:${resource} (token: ${lockToken})`);
    return lockToken;
  }
  return null; // lock is held by another process
}

/**
 * Release a distributed lock using a Lua script.
 *
 * The Lua script guarantees that only the owner (matching token) can delete
 * the key — preventing a race condition where the lock expires and is
 * re-acquired by another process before we delete it.
 *
 * Commands: GET + DEL (atomically via Lua)
 */
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

async function releaseLock(resource, lockToken) {
  const lockKey = `lock:${resource}`;
  const result  = await redis.eval(RELEASE_SCRIPT, 1, lockKey, lockToken);
  if (result === 1) {
    console.log(`[Lock] Released lock:${resource}`);
  } else {
    console.warn(`[Lock] Could not release lock:${resource} — token mismatch or already expired`);
  }
  return result === 1;
}

/**
 * Check how many seconds remain on a lock.
 * Returns -2 if the lock is not held, -1 if it has no expiry.
 * Command: TTL
 */
async function getLockTTL(resource) {
  return redis.ttl(`lock:${resource}`);
}

module.exports = { acquireLock, releaseLock, getLockTTL };
