'use strict';

require('dotenv').config();

const express  = require('express');
const http     = require('http');
const WebSocket = require('ws');
const cors     = require('cors');
const morgan   = require('morgan');
const path     = require('path');

const { redis, createSubscriber } = require('../services/redis');
const { ensureConsumerGroup }     = require('../services/streaming');
const { setOnline, setOffline }   = require('../services/presence');
const { pushFeedEvent }           = require('../services/feed');

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();

app.use(cors());
app.use(express.json());
app.use(morgan('combined'));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ──────────────────────────────────────────────────────────────────
app.use('/auth',      require('./routes/auth'));
app.use('/users',     require('./routes/users'));
app.use('/workspaces',require('./routes/workspaces'));
app.use('/channels',  require('./routes/channels'));
app.use('/analytics', require('./routes/analytics'));
app.use('/presence',  require('./routes/presence'));
app.use('/geo',       require('./routes/geo'));
app.use('/locks',     require('./routes/locks'));
app.use('/jobs',      require('./routes/jobs'));
app.use('/feed',      require('./routes/feed'));

// ─── Health Check ─────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const pong = await redis.ping();
    return res.json({
      status:    'ok',
      redis:     pong === 'PONG' ? 'connected' : 'degraded',
      timestamp: new Date().toISOString(),
    });
  } catch {
    return res.status(503).json({ status: 'error', redis: 'unavailable' });
  }
});

// ─── 404 Handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────
const PORT   = parseInt(process.env.PORT || '3000', 10);
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

/**
 * WebSocket connection handler.
 *
 * Each connecting client can subscribe to Redis Pub/Sub channels by sending:
 *   { "action": "subscribe", "channels": ["channel:123:messages", "channel:456:typing"] }
 *
 * The server creates a single shared subscriber per WS connection and
 * forwards matching messages to the WebSocket client.
 */
wss.on('connection', (ws, req) => {
  console.log('[WS] Client connected');

  // Each connection gets its own Redis subscriber client
  const subscriber = createSubscriber();
  const subscribedChannels = new Set();

  subscriber.on('message', (channel, message) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ channel, data: JSON.parse(message) }));
    }
  });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.action === 'subscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels) {
        if (!subscribedChannels.has(ch)) {
          await subscriber.subscribe(ch);
          subscribedChannels.add(ch);
          console.log(`[WS] Subscribed to ${ch}`);
        }
      }
      ws.send(JSON.stringify({ action: 'subscribed', channels: [...subscribedChannels] }));
    }

    if (msg.action === 'unsubscribe' && Array.isArray(msg.channels)) {
      for (const ch of msg.channels) {
        await subscriber.unsubscribe(ch);
        subscribedChannels.delete(ch);
      }
    }

    // Presence heartbeat
    if (msg.action === 'ping' && msg.user_id) {
      await setOnline(msg.user_id);
      ws.send(JSON.stringify({ action: 'pong', user_id: msg.user_id }));
    }
  });

  ws.on('close', async () => {
    console.log('[WS] Client disconnected');
    // Clean up subscriber client
    for (const ch of subscribedChannels) {
      await subscriber.unsubscribe(ch).catch(() => {});
    }
    subscriber.disconnect();
  });

  ws.on('error', (err) => console.error('[WS] Error:', err.message));

  // Send a welcome frame
  ws.send(JSON.stringify({
    action:  'connected',
    message: 'Welcome to PulseBoard Real-Time API',
    ts:      Date.now(),
  }));
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  // Ensure the Redis Streams consumer group exists before serving traffic
  await ensureConsumerGroup();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[API] PulseBoard API listening on http://0.0.0.0:${PORT}`);
    console.log(`[WS]  WebSocket server listening on ws://0.0.0.0:${PORT}`);
  });
}

boot().catch((err) => {
  console.error('[FATAL] Boot error:', err);
  process.exit(1);
});

module.exports = { app, server };
