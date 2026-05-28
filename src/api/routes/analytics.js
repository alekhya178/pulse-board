'use strict';

const { Router } = require('express');
const { redis } = require('../../services/redis');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');

const router = Router();
router.use(requireAuth, rateLimiter);

/* ─────────────────────────────────────────────
   Trending Channels — Sorted Set
   Key: trending:channels
   Commands: ZINCRBY, ZREVRANGE
───────────────────────────────────────────── */

/**
 * GET /analytics/trending   ← REQUIRED by spec
 * Return top-N trending channels ordered by activity score (descending).
 * Command: ZREVRANGE ... WITHSCORES
 */
router.get('/trending', async (req, res, next) => {
  try {
    const n = Math.min(parseInt(req.query.n || '10', 10), 100);
    const raw = await redis.zrevrange('trending:channels', 0, n - 1, 'WITHSCORES');
    const channels = [];
    for (let i = 0; i < raw.length; i += 2) {
      const channelId = raw[i];
      const score = Number(raw[i + 1]);
      const meta = await redis.hgetall(`channel:${channelId}`);
      channels.push({
        channel_id: channelId,
        score,
        name: meta.name || channelId,
        workspace_id: meta.workspace_id || ''
      });
    }
    return res.json({ trending: channels });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /analytics/reputation?n=10
 * Return top-N users by reputation score.
 * Command: ZREVRANGE reputation:users ... WITHSCORES
 */
router.get('/reputation', async (req, res, next) => {
  try {
    const n = Math.min(parseInt(req.query.n || '10', 10), 100);
    const raw = await redis.zrevrange('reputation:users', 0, n - 1, 'WITHSCORES');
    const users = [];
    for (let i = 0; i < raw.length; i += 2) {
      users.push({ user_id: raw[i], score: Number(raw[i + 1]) });
    }
    return res.json({ leaderboard: users });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /analytics/reputation/increment
 * Manually increment a user's reputation score.
 * Command: ZINCRBY
 */
router.post('/reputation/increment', async (req, res, next) => {
  try {
    const { user_id, increment = 1 } = req.body;
    if (!user_id) return res.status(400).json({ error: 'user_id required' });
    const newScore = await redis.zincrby('reputation:users', increment, user_id);
    return res.json({ user_id, score: Number(newScore) });
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────
   Daily Active Users — HyperLogLog
   Key: analytics:dau:{YYYY-MM-DD}
   Commands: PFADD, PFCOUNT
───────────────────────────────────────────── */

/**
 * POST /analytics/dau
 * Record that a user was active today.
 * Body: { "user_id": "u1", "date": "2026-05-23" }  (date optional — defaults to today)
 * Command: PFADD
 */
router.post('/dau', async (req, res, next) => {
  try {
    const date    = req.body.date || new Date().toISOString().slice(0, 10);
    const userId  = req.body.user_id || req.userId;
    const key     = `analytics:dau:${date}`;
    const added   = await redis.pfadd(key, userId);
    // Set 90-day TTL on HyperLogLog keys to manage memory growth
    await redis.expire(key, 90 * 24 * 60 * 60);
    return res.json({ date, user_id: userId, added: added === 1 });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /analytics/dau?date=2026-05-23
 * Get approximate unique active users for a date.
 * Command: PFCOUNT
 */
router.get('/dau', async (req, res, next) => {
  try {
    const date  = req.query.date || new Date().toISOString().slice(0, 10);
    const count = await redis.pfcount(`analytics:dau:${date}`);
    return res.json({ date, approximate_dau: count });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /analytics/dau/range?from=2026-05-01&to=2026-05-23
 * Estimate unique users over a date range using PFCOUNT across multiple keys.
 */
router.get('/dau/range', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'from and to query params required (YYYY-MM-DD)' });
    }
    const keys = [];
    const cur = new Date(from);
    const end = new Date(to);
    while (cur <= end) {
      keys.push(`analytics:dau:${cur.toISOString().slice(0, 10)}`);
      cur.setDate(cur.getDate() + 1);
    }
    const count = await redis.pfcount(...keys);
    return res.json({ from, to, approximate_unique_users: count });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
