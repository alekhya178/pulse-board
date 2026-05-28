'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { setOnline, setOffline, isOnline, getOnlineUsers, onlineCount } = require('../../services/presence');

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * POST /presence/online
 * Mark the authenticated user as online.
 * Command: SADD online_users {userId}
 */
router.post('/online', async (req, res, next) => {
  try {
    await setOnline(req.userId);
    return res.json({ user_id: req.userId, status: 'online' });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /presence/online
 * Mark the authenticated user as offline.
 * Command: SREM online_users {userId}
 */
router.delete('/online', async (req, res, next) => {
  try {
    await setOffline(req.userId);
    return res.json({ user_id: req.userId, status: 'offline' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /presence
 * List all online users + count.
 * Commands: SMEMBERS, SCARD
 */
router.get('/', async (req, res, next) => {
  try {
    const [users, count] = await Promise.all([getOnlineUsers(), onlineCount()]);
    return res.json({ online_users: users, count });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /presence/:userId
 * Check if a specific user is currently online.
 * Command: SISMEMBER
 */
router.get('/:userId', async (req, res, next) => {
  try {
    const online = await isOnline(req.params.userId);
    return res.json({ user_id: req.params.userId, online });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
