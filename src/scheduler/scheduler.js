'use strict';

/**
 * PulseBoard Scheduler Service
 *
 * Handles recurring and delayed tasks using node-cron.
 * Enqueues jobs onto the Redis job queue (queue:jobs via LPUSH) which are
 * then picked up and processed by the Worker Service.
 *
 * Uses a distributed lock (lock:scheduler:{task}) to ensure that in a
 * multi-instance deployment only ONE scheduler instance runs each task.
 */

require('dotenv').config();

const cron   = require('node-cron');
const { redis } = require('../services/redis');
const { acquireLock, releaseLock } = require('../services/lock');
const { v4: uuidv4 } = require('uuid');

const JOB_QUEUE_KEY = process.env.JOB_QUEUE_KEY || 'queue:jobs';

/** Helper — enqueue a job onto the Redis List */
async function enqueueJob(type, payload) {
  const job = { id: uuidv4(), type, payload, enqueued_at: Date.now(), source: 'scheduler' };
  await redis.lpush(JOB_QUEUE_KEY, JSON.stringify(job));
  console.log(`[Scheduler] Enqueued job type=${type} id=${job.id}`);
  return job.id;
}

/** Helper — run a task with a distributed lock so only one instance runs it */
async function withLock(resource, fn) {
  const token = await acquireLock(resource);
  if (!token) {
    console.log(`[Scheduler] Lock '${resource}' held by another instance — skipping`);
    return;
  }
  try {
    await fn();
  } finally {
    await releaseLock(resource, token);
  }
}

// ─── Scheduled Tasks ──────────────────────────────────────────────────────────

/**
 * Daily Analytics Aggregation — runs every day at midnight UTC
 * Enqueues an analytics aggregation job and records the scheduler heartbeat.
 */
cron.schedule('0 0 * * *', async () => {
  console.log('[Scheduler] Running daily analytics aggregation...');
  await withLock('scheduler:daily_analytics', async () => {
    const date = new Date().toISOString().slice(0, 10);
    await enqueueJob('aggregate_analytics', { date });
    // Record scheduler execution in Redis for monitoring (7-day TTL)
    await redis.set(`scheduler:last_run:daily_analytics`, date, 'EX', 86400 * 7);
  });
}, { timezone: 'UTC' });

/**
 * Session Cleanup — runs every hour
 * Finds and enqueues a cleanup job (Redis handles expiry automatically,
 * but this demonstrates the scheduler pattern).
 */
cron.schedule('0 * * * *', async () => {
  console.log('[Scheduler] Running hourly session cleanup...');
  await withLock('scheduler:session_cleanup', async () => {
    await enqueueJob('cleanup_sessions', { ts: Date.now() });
    // Record scheduler execution with a 7-day TTL
    await redis.set('scheduler:last_run:session_cleanup', Date.now(), 'EX', 86400 * 7);
  });
});

/**
 * Nightly Summary Email — runs every day at 6:00 AM UTC
 */
cron.schedule('0 6 * * *', async () => {
  console.log('[Scheduler] Sending nightly summary emails...');
  await withLock('scheduler:nightly_summary', async () => {
    await enqueueJob('send_email', {
      to:      'team@pulseboard.io',
      subject: 'PulseBoard Nightly Summary',
      body:    `Summary for ${new Date().toISOString().slice(0, 10)}`,
    });
  });
}, { timezone: 'UTC' });

/**
 * Daily Analytics Cleanup & Pruning — runs every day at 2:00 AM UTC
 * Prunes the trending:channels and reputation:users sorted sets to prevent unbound memory growth.
 */
cron.schedule('0 2 * * *', async () => {
  console.log('[Scheduler] Running daily analytics pruning...');
  await withLock('scheduler:analytics_cleanup', async () => {
    // Keep only the top 100 trending channels
    await redis.zremrangebyrank('trending:channels', 0, -101);
    // Keep only the top 1000 users by reputation
    await redis.zremrangebyrank('reputation:users', 0, -1001);
    // Record execution tracker with a 7-day TTL
    await redis.set('scheduler:last_run:analytics_cleanup', Date.now(), 'EX', 86400 * 7);
  });
}, { timezone: 'UTC' });

/**
 * Heartbeat — every minute, write a health timestamp to Redis.
 * This allows external monitors to verify the scheduler is alive.
 */
cron.schedule('* * * * *', async () => {
  // Set heartbeat with a 5-minute TTL
  await redis.set('scheduler:heartbeat', Date.now(), 'EX', 300);
});

// ─── Start ────────────────────────────────────────────────────────────────────
console.log('[Scheduler] PulseBoard Scheduler Service starting...');
console.log('[Scheduler] Registered tasks:');
console.log('  • Daily analytics aggregation  — 00:00 UTC');
console.log('  • Daily analytics pruning      — 02:00 UTC');
console.log('  • Session cleanup              — every hour');
console.log('  • Nightly summary email        — 06:00 UTC');
console.log('  • Health heartbeat             — every minute');

// Keep the process alive
process.on('SIGTERM', () => { console.log('[Scheduler] Shutting down'); process.exit(0); });
process.on('SIGINT',  () => { console.log('[Scheduler] Shutting down'); process.exit(0); });
