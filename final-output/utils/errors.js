'use strict';

/**
 * Application error type.
 *
 * Every error surfaced to the client carries a stable machine readable `code`,
 * a human readable `message` and the HTTP status that should be used.
 * Nothing about the database (driver errors, SQL, table names) ever reaches
 * the client - `middleware/errorHandler.js` is the single place that translates
 * internal failures into the documented `{ success: false, error: {...} }` shape.
 */
class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }

  static badRequest(code, message, details) {
    return new ApiError(400, code, message, details);
  }

  static notFound(code, message) {
    return new ApiError(404, code, message);
  }

  static conflict(code, message, details) {
    return new ApiError(409, code, message, details);
  }

  static forbidden(code, message, details) {
    return new ApiError(403, code, message, details);
  }

  static unprocessable(code, message, details) {
    return new ApiError(422, code, message, details);
  }
}

module.exports = { ApiError };
