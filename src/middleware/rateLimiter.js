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

  // INCR is atomic — safe in a distributed environment
  const count = await redis.incr(key);

  if (count === 1) {
    // First request in this window — set the expiry
    await redis.expire(key, RATE_LIMIT_WINDOW);
  }

  // Attach rate-limit info to response headers (good practice)
  res.set('X-RateLimit-Limit',     String(RATE_LIMIT_MAX));
  res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - count)));

  if (count > RATE_LIMIT_MAX) {
    const ttl = await redis.ttl(key);
    res.set('Retry-After', String(ttl));
    return res.status(429).json({
      error: 'Too Many Requests',
      retryAfterSeconds: ttl,
    });
  }

  next();
}

module.exports = { rateLimiter };
