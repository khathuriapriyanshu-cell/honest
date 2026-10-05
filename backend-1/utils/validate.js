'use strict';

const { AppError } = require('./errors');
const { isValidDateString, parseTimeToMinutes } = require('./dates');

function fail(field, message) {
  return new AppError(400, 'VALIDATION_ERROR', 'Invalid request.', [{ field, message }]);
}

function assertBodyObject(body) {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
  }
  return body;
}

function assertOnlyKeys(body, allowed, where = 'body') {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw new AppError(400, 'VALIDATION_ERROR', `Unknown field(s) in ${where}: ${unknown.join(', ')}.`, [
      { field: unknown[0], message: 'is not a recognized field.' },
    ]);
  }
}

function vString(value, field, { required = false, min = 1, max = 200, defaultValue, allowNull = false } = {}) {
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (value === null) {
    if (allowNull) return null;
    throw fail(field, 'cannot be null.');
  }
  if (typeof value !== 'string') throw fail(field, 'must be a string.');
  const t = value.trim();
  if (t.length < min) throw fail(field, `must be at least ${min} character(s).`);
  if (t.length > max) throw fail(field, `must be at most ${max} character(s).`);
  return t;
}

function vNumber(value, field, { required = false, min, max, integer = false, defaultValue } = {}) {
  if (value === undefined || value === null || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) throw fail(field, 'must be a number.');
  if (integer && !Number.isInteger(value)) throw fail(field, 'must be a whole number.');
  if (min !== undefined && value < min) throw fail(field, `must be at least ${min}.`);
  if (max !== undefined && value > max) throw fail(field, `must be at most ${max}.`);
  return value;
}

function vBoolean(value, field, { required = false, defaultValue } = {}) {
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (typeof value !== 'boolean') throw fail(field, 'must be true or false.');
  return value;
}

function vEnum(value, field, allowed, { required = false, defaultValue } = {}) {
  if (value === undefined || value === null || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (!allowed.includes(value)) throw fail(field, `must be one of: ${allowed.join(', ')}.`);
  return value;
}

function vDate(value, field, { required = false, defaultValue } = {}) {
  if (value === undefined || value === null || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (typeof value !== 'string' || !isValidDateString(value)) {
    throw fail(field, 'must be a valid date in YYYY-MM-DD format.');
  }
  return value;
}

function vTime(value, field, { required = false, defaultValue, allowNull = false } = {}) {
  if (value === undefined || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    if (!required) return undefined;
    throw fail(field, 'is required.');
  }
  if (value === null) {
    if (allowNull) return null;
    throw fail(field, 'cannot be null.');
  }
  if (typeof value !== 'string' || parseTimeToMinutes(value) === null) {
    throw fail(field, 'must be a valid 24h time in HH:MM format.');
  }
  return value.trim();
}

function vIntArray(value, field, { required = false, min, max, maxItems } = {}) {
  if (value === undefined || value === null) {
    if (required) throw fail(field, 'is required.');
    return undefined;
  }
  if (!Array.isArray(value)) throw fail(field, 'must be an array of integers.');
  if (maxItems !== undefined && value.length > maxItems) {
    throw fail(field, `must contain at most ${maxItems} item(s).`);
  }
  for (const item of value) {
    if (!Number.isInteger(item)) throw fail(field, 'must contain only integers.');
    if (min !== undefined && item < min) throw fail(field, `items must be >= ${min}.`);
    if (max !== undefined && item > max) throw fail(field, `items must be <= ${max}.`);
  }
  return value;
}

/** Route params: strict positive-integer check (rejects 'abc', '-1', '1.5'). */
function vIdParam(raw, field = 'id') {
  if (!/^\d+$/.test(String(raw))) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid ${field}.`, [
      { field, message: 'must be a positive integer.' },
    ]);
  }
  return Number(raw);
}

module.exports = {
  fail,
  assertBodyObject,
  assertOnlyKeys,
  vString,
  vNumber,
  vBoolean,
  vEnum,
  vDate,
  vTime,
  vIntArray,
  vIdParam,
};
