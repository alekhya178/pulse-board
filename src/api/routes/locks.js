'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { acquireLock, releaseLock, getLockTTL } = require('../../services/lock');

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * POST /locks/acquire
 * Acquire a distributed lock on a named resource.
 * Body: { "resource": "daily_digest" }
 * Command: SET key token NX EX ttl
 */
router.post('/acquire', async (req, res, next) => {
  try {
    const { resource } = req.body;
    if (!resource) return res.status(400).json({ error: 'resource is required' });

    const token = await acquireLock(resource);
    if (!token) {
      const ttl = await getLockTTL(resource);
      return res.status(409).json({
        error:              'Lock is already held by another process',
        resource,
        retry_after_seconds: ttl,
      });
    }

    // Simulate doing a critical task
    const taskResult = await simulateCriticalTask(resource);

    // Release the lock
    const released = await releaseLock(resource, token);

    return res.json({
      resource,
      lock_token:  token,
      task_result: taskResult,
      released,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /locks/release
 * Explicitly release a lock by resource + token.
 * Body: { "resource": "daily_digest", "lock_token": "uuid" }
 */
router.post('/release', async (req, res, next) => {
  try {
    const { resource, lock_token } = req.body;
    if (!resource || !lock_token) {
      return res.status(400).json({ error: 'resource and lock_token are required' });
    }
    const released = await releaseLock(resource, lock_token);
    return res.json({ resource, released });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /locks/:resource
 * Check the state of a lock (TTL remaining).
 * Command: TTL
 */
router.get('/:resource', async (req, res, next) => {
  try {
    const ttl = await getLockTTL(req.params.resource);
    return res.json({
      resource: req.params.resource,
      held:     ttl > 0,
      ttl_seconds: ttl,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Simulate a critical task (e.g. generating a daily report) ───────────────
async function simulateCriticalTask(resource) {
  await new Promise((r) => setTimeout(r, 50)); // Simulate work
  return `Task '${resource}' completed at ${new Date().toISOString()}`;
}

module.exports = router;
