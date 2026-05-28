'use strict';

const { redis } = require('../services/redis');

const RATE_LIMIT_MAX    = parseInt(process.env.RATE_LIMIT_MAX    || '60',  10);
const RATE_LIMIT_WINDOW = parseInt(process.env.RATE_LIMIT_WINDOW_SECONDS || '60', 10);

/**
 * Redis-based per-user rate limiting middleware.
 *
 * Key:  rate_limit:{userId}:{minuteTimestamp}
 * Uses: INCR (atomic increment) + EXPIRE on first hit
 *
 * Returns 429 with Retry-After header when the limit is exceeded.
 */
async function rateLimiter(req, res, next) {
  // Use userId from session if authenticated, otherwise fall back to IP
  const identifier    = req.userId || req.ip;
  const minuteTs      = Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW);
  const key           = `rate_limit:${identifier}:${minuteTs}`;

  // Use multi to increment and check TTL atomically to avoid race condition of missing TTL
  const pipeline = redis.multi();
  pipeline.incr(key);
  pipeline.ttl(key);
  const results = await pipeline.exec();
  const count = results[0][1];
  const ttl = results[1][1];

  if (ttl === -1) {
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  // Attach rate-limit info to response headers (good practice)
  res.set('X-RateLimit-Limit',     String(RATE_LIMIT_MAX));
  res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - count)));

  if (count > RATE_LIMIT_MAX) {
    const retryAfter = ttl > 0 ? ttl : RATE_LIMIT_WINDOW;
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({
      error: 'Too Many Requests',
      retryAfterSeconds: retryAfter,
    });
  }

  next();
}

module.exports = { rateLimiter };
