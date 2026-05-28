'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { getFeed, pushFeedEvent } = require('../../services/feed');

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * GET /feed
 * Retrieve the authenticated user's activity feed (most recent first).
 * Query: ?start=0&stop=49
 * Commands: LRANGE
 */
router.get('/', async (req, res, next) => {
  try {
    const start = parseInt(req.query.start || '0', 10);
    const stop  = parseInt(req.query.stop  || '49', 10);
    const items = await getFeed(req.userId, start, stop);
    return res.json({ user_id: req.userId, feed: items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /feed/:userId
 * Retrieve another user's feed (admin-level view).
 */
router.get('/:userId', async (req, res, next) => {
  try {
    const items = await getFeed(req.params.userId);
    return res.json({ user_id: req.params.userId, feed: items, count: items.length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /feed/event
 * Manually push a custom event to the authenticated user's feed.
 */
router.post('/event', async (req, res, next) => {
  try {
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: 'event type is required' });
    await pushFeedEvent(req.userId, { type, ...data });
    return res.json({ status: 'pushed', user_id: req.userId, type });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
