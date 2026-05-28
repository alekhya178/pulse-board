'use strict';

/**
 * PulseBoard Worker Service
 *
 * Processes two types of async work:
 *
 * 1. Job Queue  — Redis List (BRPOP queue:jobs)
 *    Picks up JSON job payloads and executes handlers.
 *
 * 2. Event Stream — Redis Stream (XREADGROUP stream:events workers worker-1)
 *    Reads events using a consumer group, processes them, then ACKs.
 *
 * This runs as an independent process so it never blocks the API server.
 */

require('dotenv').config();

const { createBlockingClient } = require('../services/redis');
const { ensureConsumerGroup, readEvents, ackEvent } = require('../services/streaming');

const JOB_QUEUE_KEY   = process.env.JOB_QUEUE_KEY     || 'queue:jobs';
const CONSUMER_NAME   = process.env.STREAM_CONSUMER_NAME || 'worker-1';

// Separate blocking client for BRPOP (won't time-out the main client)
const blockingClient  = createBlockingClient();
// Separate blocking client for XREADGROUP
const streamClient    = createBlockingClient();

let isShuttingDown = false;

// ─── Job Handlers ─────────────────────────────────────────────────────────────
const jobHandlers = {
  send_email: async (payload) => {
    console.log(`[Worker] 📧 Sending email to ${payload.to || 'unknown'} — subject: "${payload.subject || '(none)'}"`);
    // Real implementation would call an SMTP service here
  },
  send_notification: async (payload) => {
    console.log(`[Worker] 🔔 Sending notification to user ${payload.user_id}: "${payload.message}"`);
  },
  aggregate_analytics: async (payload) => {
    console.log(`[Worker] 📊 Aggregating analytics for date: ${payload.date}`);
  },
  cleanup_sessions: async (payload) => {
    console.log(`[Worker] 🧹 Running session cleanup for workspace: ${payload.workspace_id}`);
  },
  default: async (type, payload) => {
    console.log(`[Worker] ⚙️  Processing generic job type='${type}':`, JSON.stringify(payload));
  },
};

// ─── Job Queue Loop (BRPOP) ──────────────────────────────────────────────────
async function processJobQueue() {
  console.log(`[Worker] Listening to job queue '${JOB_QUEUE_KEY}' via BRPOP...`);
  while (!isShuttingDown) {
    try {
      // BRPOP blocks up to 5 seconds waiting for a job, then returns null
      const result = await blockingClient.brpop(JOB_QUEUE_KEY, 5);
      if (!result) continue; // timeout — loop again

      const [, raw] = result;
      let job;
      try {
        job = JSON.parse(raw);
      } catch {
        console.error('[Worker] Failed to parse job:', raw);
        continue;
      }

      console.log(`[Worker] Dequeued job id=${job.id} type=${job.type}`);
      const handler = jobHandlers[job.type] || jobHandlers.default;
      try {
        if (handler === jobHandlers.default) {
          await handler(job.type, job.payload);
        } else {
          await handler(job.payload);
        }
        console.log(`[Worker] ✅ Job ${job.id} completed`);
      } catch (handlerErr) {
        console.error(`[Worker] ❌ Job ${job.id} failed:`, handlerErr.message);
      }
    } catch (err) {
      if (!isShuttingDown) {
        console.error('[Worker] Queue loop error:', err.message);
        await sleep(1000);
      }
    }
  }
}

// ─── Event Stream Loop (XREADGROUP) ──────────────────────────────────────────
async function processEventStream() {
  // Ensure consumer group exists (may already exist if API started first)
  const { ensureConsumerGroup: ensure } = require('../services/streaming');
  await ensure();

  console.log(`[Worker] Listening to event stream via XREADGROUP (consumer: ${CONSUMER_NAME})...`);

  while (!isShuttingDown) {
    try {
      // Read up to 5 events, blocking up to 2s
      const events = await readEvents(CONSUMER_NAME, 5, streamClient);
      for (const event of events) {
        console.log(`[Worker] 📡 Stream event id=${event.id} type=${event.data.type}:`, event.data);
        // Process the event ...
        // ACK it so it won't be re-delivered
        await ackEvent(event.id);
        console.log(`[Worker] ✅ Stream event ${event.id} acknowledged`);
      }
    } catch (err) {
      if (!isShuttingDown) {
        console.error('[Worker] Stream loop error:', err.message);
        await sleep(1000);
      }
    }
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`[Worker] Received ${signal} — shutting down gracefully...`);
  isShuttingDown = true;
  blockingClient.disconnect();
  streamClient.disconnect();
  setTimeout(() => process.exit(0), 2000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('[Worker] PulseBoard Worker Service starting...');
  // Run both loops concurrently
  await Promise.all([
    processJobQueue(),
    processEventStream(),
  ]);
})().catch((err) => {
  console.error('[Worker] Fatal error:', err);
  process.exit(1);
});
