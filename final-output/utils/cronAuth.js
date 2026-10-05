'use strict';

const crypto = require('node:crypto');

/**
 * Shared-secret authentication for the serverless scheduler endpoint.
 *
 * The secret may arrive as:
 *   - a query parameter:  /api/cron/tick?secret=...
 *   - a header:           x-cron-secret: ...
 *   - a bearer token:     Authorization: Bearer ...
 *
 * Comparison is constant-time so the endpoint cannot be used as a timing oracle.
 * When no secret is configured the endpoint stays open (it only recomputes
 * derived state - it never writes user data), reports `required: false`, and the
 * server logs a warning at start-up so the omission is visible.
 */

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still perform a comparison so the timing does not reveal the length.
    crypto.timingSafeEqual(left, left);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function extractSecret(req) {
  const header = req.get ? req.get('x-cron-secret') : undefined;
  if (header) return { value: header, from: 'header' };

  const authorization = req.get ? req.get('authorization') : undefined;
  if (authorization && /^Bearer\s+/i.test(authorization)) {
    return { value: authorization.replace(/^Bearer\s+/i, '').trim(), from: 'bearer' };
  }

  const query = req.query && (req.query.secret || req.query.key || req.query.token);
  if (query) return { value: String(query), from: 'query' };

  return { value: null, from: null };
}

/**
 * @returns {{ allowed: boolean, required: boolean, reason: string|null, from: string|null }}
 */
function authorizeCron(req, expectedSecret) {
  const configured = expectedSecret === undefined || expectedSecret === null || String(expectedSecret).trim() === ''
    ? null
    : String(expectedSecret).trim();

  if (!configured) {
    return { allowed: true, required: false, reason: null, from: null };
  }

  const { value, from } = extractSecret(req);
  if (!value) {
    return { allowed: false, required: true, reason: 'missing_secret', from: null };
  }
  if (!timingSafeEqual(value, configured)) {
    return { allowed: false, required: true, reason: 'invalid_secret', from };
  }
  return { allowed: true, required: true, reason: null, from };
}

module.exports = { authorizeCron, extractSecret, timingSafeEqual };
