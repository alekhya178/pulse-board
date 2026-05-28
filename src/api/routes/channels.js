'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { publish } = require('../../services/pubsub');
const { redis } = require('../../services/redis');
const { addEvent } = require('../../services/streaming');

const router = Router();
router.use(requireAuth, rateLimiter);

/* ─────────────────────────────────────────────
   Channel management
───────────────────────────────────────────── */

/**
 * POST /channels
 * Create a channel and register it in the global channel set.
 */
router.post('/', async (req, res, next) => {
  try {
    const { channel_id, name, workspace_id } = req.body;
    if (!channel_id || !name) {
      return res.status(400).json({ error: 'channel_id and name are required' });
    }
    await redis.hset(`channel:${channel_id}`,
      'channel_id',   channel_id,
      'name',         name,
      'workspace_id', workspace_id || '',
      'created_by',   req.userId,
      'created_at',   String(Date.now())
    );
    // Add to workspace channels set for enumeration
    if (workspace_id) {
      await redis.sadd(`workspace:${workspace_id}:channels`, channel_id);
    }
    return res.status(201).json({ channel_id, name });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /channels
 * List all channels (from the global set).
 */
router.get('/', async (req, res, next) => {
  try {
    const keys = await redis.keys('channel:*');
    // Filter out sub-keys like channel:123:messages
    const channelKeys = keys.filter((k) => k.split(':').length === 2);
    const channels = await Promise.all(
      channelKeys.map((k) => redis.hgetall(k))
    );
    return res.json(channels.filter(Boolean));
  } catch (err) {
    next(err);
  }
});

/* ─────────────────────────────────────────────
   Real-Time Messaging — Redis Pub/Sub
   Channel: channel:{id}:messages
   Commands: PUBLISH (subscribers handled in server.js WS layer)
───────────────────────────────────────────── */

/**
 * POST /channels/:id/messages
 * Publish a message to a channel.
 * Also increments the channel's trending score (ZINCRBY).
 */
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { text, client_msg_id } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const message = {
      channel_id: req.params.id,
      sender_id:  req.userId,
      text,
      ts:         Date.now(),
      client_msg_id: client_msg_id || null
    };

    // PUBLISH to Pub/Sub channel
    const receiverCount = await publish(`channel:${req.params.id}:messages`, message);

    // Increment channel trending score (ZINCRBY)
    await redis.zincrby('trending:channels', 1, req.params.id);

    // Increment sender reputation (ZINCRBY)
    await redis.zincrby('reputation:users', 1, req.userId);

    // Add to event stream
    await addEvent('message_sent', {
      channel_id: req.params.id,
      sender:     req.userId,
    });

    return res.status(201).json({ ...message, pub_sub_receivers: receiverCount });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /channels/:id/typing
 * Publish a typing indicator to the channel.
 * Command: PUBLISH  (ephemeral — no storage)
 */
router.post('/:id/typing', async (req, res, next) => {
  try {
    const receiverCount = await publish(`channel:${req.params.id}:typing`, {
      user_id:    req.userId,
      channel_id: req.params.id,
      ts:         Date.now(),
    });
    return res.json({ status: 'sent', pub_sub_receivers: receiverCount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
