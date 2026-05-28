'use strict';

const { redis } = require('./redis');

/**
 * Publish a message to a Redis Pub/Sub channel.
 * Command: PUBLISH
 *
 * @param {string} channel  e.g. "channel:123:messages"
 * @param {Object} payload  Will be JSON-serialised before publishing
 * @returns {number}        Count of subscribers that received the message
 */
async function publish(channel, payload) {
  return redis.publish(channel, JSON.stringify(payload));
}

module.exports = { publish };
