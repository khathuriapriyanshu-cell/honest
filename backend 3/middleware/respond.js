'use strict';

/**
 * Response envelope.
 *
 * Every successful response carries `success: true`, the top-level payload
 * fields documented in API.md, and an identical copy under `data`. Clients that
 * prefer the documented flat shape and clients that prefer `{ success, data }`
 * both work against the same endpoint - there is never a second, divergent
 * representation of the same numbers.
 */

function ok(res, payload = {}, status = 200, extra = {}) {
  const body = {
    success: true,
    ...payload,
    ...extra,
    data: payload,
  };
  return res.status(status).json(body);
}

function created(res, payload = {}) {
  return ok(res, payload, 201);
}

function fail(res, status, code, message, details) {
  const body = {
    success: false,
    // Kept for frontend clients that read `error.message` at the top level.
    message,
    error: { code, message },
  };
  if (details !== undefined) body.error.details = details;
  return res.status(status).json(body);
}

module.exports = { ok, created, fail };
