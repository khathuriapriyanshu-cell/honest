'use strict';

const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No route matches ${req.method} ${req.originalUrl}.` },
    message: `No route matches ${req.method} ${req.originalUrl}.`,
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof AppError) {
    const error = { code: err.code, message: err.message };
    if (err.details) error.details = err.details;
    // `message` at the top level keeps the bundled frontend's error reading working.
    res.status(err.status).json({ success: false, error, message: err.message });
    return;
  }

  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON.' },
      message: 'Request body is not valid JSON.',
    });
    return;
  }

  if (err && err.type === 'entity.too.large') {
    res.status(413).json({
      success: false,
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' },
      message: 'Request body is too large.',
    });
    return;
  }

  console.error('[honest] unexpected error:', err);
  res.status(500).json({
    success: false,
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' },
    message: 'Something went wrong on our side. Please try again.',
  });
}

module.exports = { notFoundHandler, errorHandler };
