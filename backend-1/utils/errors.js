'use strict';

/**
 * Application error type. Every intentional failure in the backend is
 * expressed as an AppError with an HTTP status, a stable machine code and a
 * human-readable, non-shaming message. The error middleware turns these into
 * the standard JSON error envelope.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const badRequest = (code, message, details) => new AppError(400, code, message, details);
const notFound = (code, message) => new AppError(404, code, message);
const conflict = (code, message) => new AppError(409, code, message);

module.exports = { AppError, badRequest, notFound, conflict };
