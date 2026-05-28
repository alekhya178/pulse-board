'use strict';

const { getSession, refreshSession } = require('../services/session');

/**
 * Middleware: validates the session token from the Authorization header.
 *
 * Expects:  Authorization: Bearer <session_token>
 * Attaches: req.userId, req.sessionToken on success.
 * Returns 401 if the token is missing, invalid, or expired.
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const userId = await getSession(token);
  if (!userId) {
    return res.status(401).json({ error: 'Invalid or expired session token' });
  }

  // Sliding window — extend TTL on every authenticated request
  await refreshSession(token);

  req.userId       = userId;
  req.sessionToken = token;
  next();
}

module.exports = { requireAuth };
