'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { redis } = require('../../services/redis');

const JOB_QUEUE_KEY = process.env.JOB_QUEUE_KEY || 'queue:jobs';

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * POST /jobs/enqueue
 * Push a job payload onto the Redis List job queue.
 * Body: { "type": "send_email", "payload": { "to": "alice@example.com" } }
 * Command: LPUSH
 */
router.post('/enqueue', async (req, res, next) => {
  try {
    const { type, payload } = req.body;
    if (!type) return res.status(400).json({ error: 'job type is required' });

    const job = {
      id:         require('uuid').v4(),
      type,
      payload:    payload || {},
      enqueued_by: req.userId,
      enqueued_at: Date.now(),
    };

    await redis.lpush(JOB_QUEUE_KEY, JSON.stringify(job));
    const queueLength = await redis.llen(JOB_QUEUE_KEY);

    return res.status(202).json({
      message:      'Job enqueued',
      job_id:       job.id,
      queue_length: queueLength,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /jobs/queue-length
 * Return current job queue length.
 * Command: LLEN
 */
router.get('/queue-length', async (req, res, next) => {
  try {
    const length = await redis.llen(JOB_QUEUE_KEY);
    return res.json({ queue: JOB_QUEUE_KEY, length });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /streams/events
 * Add an event to the Redis Stream directly (producer endpoint).
 * Body: { "type": "user_action", "data": { "action": "click" } }
 * Command: XADD
 */
router.post('/streams/events', async (req, res, next) => {
  try {
    const { type, data = {} } = req.body;
    if (!type) return res.status(400).json({ error: 'event type is required' });

    const { addEvent } = require('../../services/streaming');
    const streamId = await addEvent(type, {
      ...data,
      produced_by: req.userId,
    });

    return res.status(201).json({ stream_id: streamId, type });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /streams/events
 * Read recent events from the stream (no consumer group — for inspection).
 * Command: XRANGE
 */
router.get('/streams/events', async (req, res, next) => {
  try {
    const { getRecentEvents } = require('../../services/streaming');
    const events = await getRecentEvents(parseInt(req.query.count || '20', 10));
    return res.json({ events });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
