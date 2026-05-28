'use strict';

const { Router } = require('express');
const { redis } = require('../../services/redis');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * GET /users/:id
 * Fetch a full user profile from the Redis Hash.
 * Commands: HGETALL, HEXISTS
 */
router.get('/:id', async (req, res, next) => {
  try {
    const profile = await redis.hgetall(`user:${req.params.id}`);
    if (!profile || Object.keys(profile).length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    return res.json(profile);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /users/:id/fields?fields=name,email
 * Retrieve specific fields from the user hash.
 * Command: HMGET
 */
router.get('/:id/fields', async (req, res, next) => {
  try {
    const fields = (req.query.fields || '').split(',').filter(Boolean);
    if (fields.length === 0) {
      return res.status(400).json({ error: 'Provide comma-separated ?fields=...' });
    }
    const values = await redis.hmget(`user:${req.params.id}`, ...fields);
    const result = {};
    fields.forEach((f, i) => { result[f] = values[i]; });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /users/:id
 * Update one or more user profile fields.
 * Command: HSET (partial update of Hash fields)
 */
router.put('/:id', async (req, res, next) => {
  try {
    const allowed = ['name', 'email', 'role', 'bio', 'avatar_url'];
    const updates = [];
    for (const [k, v] of Object.entries(req.body)) {
      if (allowed.includes(k)) {
        updates.push(k, String(v));
      }
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields provided' });
    }
    await redis.hset(`user:${req.params.id}`, ...updates);
    const profile = await redis.hgetall(`user:${req.params.id}`);
    return res.json(profile);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /users/:id/attendance?month=2026-05
 * Fetch attendance bitmap for a user in a given month.
 * Commands: BITCOUNT, GETBIT (for individual days)
 */
router.get('/:id/attendance', async (req, res, next) => {
  try {
    const month   = req.query.month || new Date().toISOString().slice(0, 7);
    const key     = `attendance:${req.params.id}:${month}`;
    const active  = await redis.bitcount(key);
    // Return individual day bits (1-31)
    const days = {};
    const daysInMonth = new Date(month + '-01');
    daysInMonth.setMonth(daysInMonth.getMonth() + 1);
    daysInMonth.setDate(0);
    const maxDay = daysInMonth.getDate();
    for (let d = 1; d <= maxDay; d++) {
      days[d] = await redis.getbit(key, d);
    }
    return res.json({ user_id: req.params.id, month, active_days: active, days });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /users/:id/attendance
 * Mark a user as active on a specific day.
 * Body: { "day": 15 }  (1-31, offset into the month bitmap)
 * Command: SETBIT
 */
router.post('/:id/attendance', async (req, res, next) => {
  try {
    const month = req.body.month || new Date().toISOString().slice(0, 7);
    const day   = parseInt(req.body.day, 10) || new Date().getDate();
    const key   = `attendance:${req.params.id}:${month}`;
    await redis.setbit(key, day, 1);
    return res.json({ user_id: req.params.id, month, day, status: 'active' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
