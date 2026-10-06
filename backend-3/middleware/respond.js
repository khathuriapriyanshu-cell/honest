'use strict';

/**
 * Response envelope.
 *
 * Every successful response carries `success: true`, the top-level payload
 * fields documented in API.md, and a copy under `data`. Clients that prefer the
 * documented flat shape and clients that prefer `{ success, data }` both work
 * against the same endpoint - there is never a second, divergent representation
 * of the same numbers.
 *
 * `extra.data` overrides the default mirror, which lets an endpoint present an
 * array as its documented `data` value (see GET /api/reflections) while the
 * top-level fields stay available for older clients.
 */

function ok(res, payload = {}, status = 200, extra = {}) {
  const { data: explicitData, ...rest } = extra;
  const body = {
    success: true,
    ...payload,
    ...rest,
    data: explicitData !== undefined ? explicitData : payload,
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
