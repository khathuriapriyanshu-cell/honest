'use strict';

const { ApiError } = require('../utils/errors');

/**
 * Error handling.
 *
 * One place converts *anything* thrown anywhere in the app into the documented
 * error contract:
 *
 *   { "success": false, "error": { "code": "...", "message": "..." } }
 *
 * Database internals (driver messages, SQL text, table/column names) are never
 * forwarded. Unexpected failures are logged server side with a short reference
 * that is also returned to the client, so an honest bug report is possible
 * without leaking the schema.
 */

function notFoundHandler(req, res, next) {
  next(
    new ApiError(
      404,
      'ROUTE_NOT_FOUND',
      `No endpoint matches ${req.method} ${req.originalUrl}. See GET /api for the endpoint index.`
    )
  );
}

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
function errorHandler(err, req, res, next) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong on the server. The request was not applied.';
  let details;

  if (err instanceof ApiError) {
    status = err.status;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err && err.type === 'entity.parse.failed') {
    status = 400;
    code = 'MALFORMED_JSON';
    message = 'The request body is not valid JSON.';
  } else if (err && err.type === 'entity.too.large') {
    status = 413;
    code = 'PAYLOAD_TOO_LARGE';
    message = 'The request body is too large.';
  } else if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
    status = err.status;
    code = 'BAD_REQUEST';
    message = err.message || 'The request could not be processed.';
  } else if (err && /SQLITE_|constraint failed|no such (table|column)/i.test(String(err.message))) {
    // The database refused the write. Report honestly, but without internals.
    status = 500;
    code = 'DATABASE_ERROR';
    message = 'The database rejected the operation, so nothing was saved. No data was changed.';
    console.error('[honest] database failure:', err.message);
  }

  if (status >= 500) {
    const reference = `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    console.error(`[honest] ${reference} ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
    if (details === undefined) details = { reference };
  }

  const body = {
    success: false,
    message,
    error: { code, message },
  };
  if (details !== undefined) body.error.details = details;
  res.status(status).json(body);
}

module.exports = { errorHandler, notFoundHandler };
