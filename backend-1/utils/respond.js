'use strict';

/**
 * Response helpers.
 *
 * Every success response carries the canonical payload under `data`:
 *   { "success": true, "data": { ... } }
 *
 * For endpoints the bundled frontend consumes, we ALSO spread a flat
 * compatibility projection at the top level (same information, frontend field
 * names). This keeps one consistent envelope while letting the existing
 * frontend integrate without changes. Documented in API.md.
 */
function ok(res, data, flat = {}, status = 200) {
  return res.status(status).json({ success: true, data, ...flat });
}

/** Wrap async express handlers so rejections reach the error middleware. */
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ok, wrap };
