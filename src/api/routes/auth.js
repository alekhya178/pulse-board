'use strict';

const { Router } = require('express');
const { createSession, destroySession, getSessionTTL } = require('../../services/session');
const { redis } = require('../../services/redis');
const { pushFeedEvent } = require('../../services/feed');
const { requireAuth } = require('../../middleware/auth');

const router = Router();

/**
 * POST /auth/login
 *
 * Body: { "user_id": "u1", "email": "alice@example.com", "name": "Alice" }
 *
 * - Upserts user profile in a Redis Hash (HSET)
 * - Creates a session string with TTL (SETEX via createSession)
 * - Returns session_token
 */
router.post('/login', async (req, res, next) => {
  try {
    const { user_id, email, name } = req.body;

    if (!user_id || !email) {
      return res.status(400).json({ error: 'user_id and email are required' });
    }

    // Upsert user profile (HSET — idempotent)
    await redis.hset(`user:${user_id}`,
      'user_id', user_id,
      'email',   email,
      'name',    name || email.split('@')[0],
      'role',    'member',
      'created_at', String(Date.now())
    );

    // Create session (SETEX)
    const token = await createSession(user_id);

    // Push login event to user feed
    await pushFeedEvent(user_id, { type: 'login', user_id });

    const ttl = await getSessionTTL(token);

    return res.status(200).json({
      session_token: token,
      user_id,
      expires_in: ttl,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /auth/logout
 * Requires: Authorization: Bearer <token>
 * Destroys the session (DEL)
 */
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await destroySession(req.sessionToken);
    return res.status(200).json({ message: 'Logged out successfully' });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /auth/session
 * Returns session info for the current token (TTL check).
 */
router.get('/session', requireAuth, async (req, res, next) => {
  try {
    const ttl = await getSessionTTL(req.sessionToken);
    return res.status(200).json({
      user_id:         req.userId,
      session_token:   req.sessionToken,
      expires_in:      ttl,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
