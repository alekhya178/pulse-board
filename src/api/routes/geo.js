'use strict';

const { Router } = require('express');
const { requireAuth } = require('../../middleware/auth');
const { rateLimiter } = require('../../middleware/rateLimiter');
const { redis } = require('../../services/redis');

const GEO_KEY = 'geo:active_users';

const router = Router();
router.use(requireAuth, rateLimiter);

/**
 * POST /geo/location
 * Update a user's location in the GEO index.
 * Body: { "longitude": 77.5946, "latitude": 12.9716 }
 * Command: GEOADD
 */
router.post('/location', async (req, res, next) => {
  try {
    const { longitude, latitude } = req.body;
    if (longitude == null || latitude == null) {
      return res.status(400).json({ error: 'longitude and latitude are required' });
    }
    await redis.geoadd(GEO_KEY, parseFloat(longitude), parseFloat(latitude), req.userId);
    return res.json({
      user_id:   req.userId,
      longitude: parseFloat(longitude),
      latitude:  parseFloat(latitude),
      status:    'location updated',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /geo/nearby?longitude=77.59&latitude=12.97&radius=10&unit=km
 * Find users within a radius of the given point.
 * Command: GEOSEARCH
 */
router.get('/nearby', async (req, res, next) => {
  try {
    const { longitude, latitude, radius = 10, unit = 'km' } = req.query;
    if (!longitude || !latitude) {
      return res.status(400).json({ error: 'longitude and latitude are required' });
    }
    const validUnits = ['m', 'km', 'mi', 'ft'];
    const safeUnit = validUnits.includes(unit) ? unit : 'km';

    // Primary mode: FROMLONLAT using coordinates passed via query parameters
    const results = await redis.geosearch(
      GEO_KEY,
      'FROMLONLAT', parseFloat(longitude), parseFloat(latitude),
      'BYRADIUS', parseFloat(radius), safeUnit,
      'ASC',                          // Nearest first
      'WITHCOORD',
      'WITHDIST',
      'COUNT', 50
    );

    const nearby = results.map((entry) => {
      // ioredis returns: [member, distance, [lon, lat]]
      const [member, distance, coords] = entry;
      return {
        user_id:   member,
        distance:  `${distance} ${safeUnit}`,
        longitude: coords ? parseFloat(coords[0]) : null,
        latitude:  coords ? parseFloat(coords[1]) : null,
      };
    });

    return res.json({ center: { longitude, latitude }, radius: `${radius} ${safeUnit}`, nearby });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /geo/location/:userId
 * Get a specific user's stored position.
 * Command: GEOPOS
 */
router.get('/location/:userId', async (req, res, next) => {
  try {
    const pos = await redis.geopos(GEO_KEY, req.params.userId);
    if (!pos[0]) {
      return res.status(404).json({ error: 'Location not found for user' });
    }
    return res.json({
      user_id:   req.params.userId,
      longitude: parseFloat(pos[0][0]),
      latitude:  parseFloat(pos[0][1]),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
