'use strict';

const { Router } = require('express');
const { redis } = require('../../services/redis');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { pushFeedEvent } = require('../../services/feed');
const { addEvent } = require('../../services/streaming');

const router = Router();
router.use(requireAuth, rateLimiter);

/* ─────────────────────────────────────────────
   Workspace CRUD
   ───────────────────────────────────────────── */

/**
 * POST /workspaces
 * Create a new workspace.
 * Stores metadata in a Hash and creates the members Set.
 */
router.post('/', async (req, res, next) => {
  try {
    const { workspace_id, name } = req.body;
    if (!workspace_id || !name) {
      return res.status(400).json({ error: 'workspace_id and name are required' });
    }
    // Store workspace metadata
    await redis.hset(`workspace:${workspace_id}`,
      'workspace_id', workspace_id,
      'name',         name,
      'owner',        req.userId,
      'created_at',   String(Date.now())
    );
    // Auto-add creator as first member (SADD)
    await redis.sadd(`workspace:${workspace_id}:members`, req.userId);

    // Index workspaces for listings and SINTER
    await redis.sadd('workspaces:all', workspace_id);
    await redis.sadd(`user:${req.userId}:workspaces`, workspace_id);

    await addEvent('workspace_created', { workspace_id, creator: req.userId });
    return res.status(201).json({ workspace_id, name, owner: req.userId });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /workspaces
 * List all workspaces registered in the system.
 */
router.get('/', async (req, res, next) => {
  try {
    const ids = await redis.smembers('workspaces:all');
    if (!ids || ids.length === 0) {
      return res.json([]);
    }
    const workspaces = await Promise.all(
      ids.map(async (id) => {
        const ws = await redis.hgetall(`workspace:${id}`);
        if (!ws || Object.keys(ws).length === 0) {
          return null;
        }
        return ws;
      })
    );
    return res.json(workspaces.filter(Boolean));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /workspaces/common?user_a=u1&user_b=u2
 * Find workspaces two users share.
 * Uses SINTER on their individual membership keys.
 *
 * NOTE: This requires storing a per-user set of workspaces in addition
 *       to the per-workspace member set.
 * Command: SINTER
 */
router.get('/common', async (req, res, next) => {
  try {
    const { user_a, user_b } = req.query;
    if (!user_a || !user_b) {
      return res.status(400).json({ error: 'user_a and user_b query params required' });
    }
    // SINTER on user workspace sets
    const common = await redis.sinter(`user:${user_a}:workspaces`, `user:${user_b}:workspaces`);
    return res.json({ user_a, user_b, common_workspaces: common });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /workspaces/:id
 * Return workspace metadata.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const ws = await redis.hgetall(`workspace:${req.params.id}`);
    if (!ws || Object.keys(ws).length === 0) {
      return res.status(404).json({ error: 'Workspace not found' });
    }
    return res.json(ws);
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────
   Membership (Redis Set)
   Key: workspace:{id}:members
   Commands: SADD, SREM, SMEMBERS, SINTER
   ───────────────────────────────────────────── */

/**
 * GET /workspaces/:id/members   ← REQUIRED by spec
 * List all members of a workspace.
 * Command: SMEMBERS
 */
router.get('/:id/members', async (req, res, next) => {
  try {
    const members = await redis.smembers(`workspace:${req.params.id}:members`);
    return res.json({ workspace_id: req.params.id, members });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /workspaces/:id/members
 * Add a user to a workspace.
 * Body: { "user_id": "u2" }
 * Command: SADD
 */
router.post('/:id/members', async (req, res, next) => {
  try {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    await redis.sadd(`workspace:${req.params.id}:members`, user_id);
    // Index user workspace membership for SINTER
    await redis.sadd(`user:${user_id}:workspaces`, req.params.id);

    await pushFeedEvent(user_id, { type: 'joined_workspace', workspace_id: req.params.id });
    await addEvent('member_added', { workspace_id: req.params.id, user_id });
    return res.status(201).json({ workspace_id: req.params.id, user_id, status: 'added' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /workspaces/:id/members/:uid
 * Remove a user from a workspace.
 * Command: SREM
 */
router.delete('/:id/members/:uid', async (req, res, next) => {
  try {
    await redis.srem(`workspace:${req.params.id}:members`, req.params.uid);
    return res.json({ workspace_id: req.params.id, user_id: req.params.uid, status: 'removed' });
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────
   Invitation Acceptance — MULTI/EXEC transaction
   Atomically: add to members + push feed event
   ───────────────────────────────────────────── */

/**
 * POST /workspaces/:id/invite/accept
 * Accept a workspace invitation atomically using MULTI/EXEC.
 * Body: { "user_id": "u3" }
 */
router.post('/:id/invite/accept', async (req, res, next) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  const wsKey   = `workspace:${req.params.id}:members`;
  const feedKey = `feed:${user_id}`;
  const feedPayload = JSON.stringify({
    type:         'accepted_invitation',
    workspace_id: req.params.id,
    ts:           Date.now(),
  });

  let retries = 3;
  let success = false;
  let results = null;

  try {
    while (retries > 0 && !success) {
      // Implement WATCH for optimistic locking on the members key
      await redis.watch(wsKey);

      const pipeline = redis.multi();
      pipeline.sadd(wsKey, user_id);             // Add to workspace members
      pipeline.lpush(feedKey, feedPayload);       // Push to activity feed
      pipeline.ltrim(feedKey, 0, parseInt(process.env.FEED_MAX_LENGTH || '100', 10) - 1);
      pipeline.sadd(`user:${user_id}:workspaces`, req.params.id); // Track user → workspaces
      
      results = await pipeline.exec();
      if (results !== null) {
        success = true;
      } else {
        retries--;
      }
    }

    if (!success) {
      return res.status(409).json({ error: 'Transaction aborted due to concurrent update' });
    }

    return res.status(200).json({
      workspace_id: req.params.id,
      user_id,
      status:  'accepted',
      results: results.map(([err, val]) => ({ err: err?.message || null, val })),
    });
  } catch (err) {
    await redis.unwatch().catch(() => {});
    next(err);
  }
});

module.exports = router;
