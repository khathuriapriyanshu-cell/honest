'use strict';

const { ApiError } = require('./errors');

/**
 * Declarative input validation helpers.
 *
 * Rule: the frontend is never trusted. Every field that reaches a service has
 * been through one of these functions, and every failure produces a 400 with a
 * stable error code so the frontend can react without parsing prose.
 */

const REPEAT_TYPES = ['once', 'daily', 'selected'];
const REPEAT_ALIASES = {
  once: 'once',
  'one-time': 'once',
  onetime: 'once',
  single: 'once',
  daily: 'daily',
  every_day: 'daily',
  everyday: 'daily',
  selected: 'selected',
  'selected-days': 'selected',
  selecteddays: 'selected',
  custom: 'selected',
  weekly: 'selected',
};

const OFF_DAY_REASONS = ['Sick', 'Travel', 'Exams finished', 'Personal day'];

const THEMES = ['dark', 'light'];
const WEEK_STARTS = ['monday', 'sunday'];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(code, message, details) {
  throw ApiError.badRequest(code, message, details);
}

function requireObject(value, field = 'body') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_BODY', `Request ${field} must be a JSON object.`);
  }
  return value;
}

function asString(value, field, { required = true, min = 1, max = 500, trim = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return null;
  }
  if (typeof value !== 'string') {
    fail('INVALID_FIELD', `"${field}" must be a string.`);
  }
  const out = trim ? value.trim() : value;
  if (out.length < min) {
    fail('INVALID_FIELD', `"${field}" must be at least ${min} character(s).`);
  }
  if (out.length > max) {
    fail('INVALID_FIELD', `"${field}" must be at most ${max} characters.`);
  }
  return out;
}

/** Accepts "14:30" or "14:30:00" and normalises to "HH:MM". */
function asTime(value, field, { required = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required && fallback === null) fail('MISSING_FIELD', `"${field}" is required.`);
    return fallback;
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `"${field}" must be a "HH:MM" string.`);
  const raw = value.trim();
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(raw);
  if (!match) fail('INVALID_TIME', `"${field}" must use 24-hour "HH:MM" format (received "${raw}").`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    fail('INVALID_TIME', `"${field}" must be a valid time of day between 00:00 and 23:59.`);
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Strict calendar date check: 2026-02-30 is rejected, 2024-02-29 is accepted. */
function asDate(value, field, { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return null;
  }
  if (typeof value !== 'string' || !DATE_RE.test(value.trim())) {
    fail('INVALID_DATE', `"${field}" must be an ISO calendar date formatted as YYYY-MM-DD.`);
  }
  const raw = value.trim();
  const [y, m, d] = raw.split('-').map(Number);
  if (m < 1 || m > 12) fail('INVALID_DATE', `"${field}" has an invalid month.`);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (d < 1 || d > daysInMonth) fail('INVALID_DATE', `"${field}" has an invalid day for that month.`);
  if (y < 1970 || y > 2200) fail('INVALID_DATE', `"${field}" must be between 1970 and 2200.`);
  return raw;
}

function asInt(value, field, { required = true, min = null, max = null, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required && fallback === null) fail('MISSING_FIELD', `"${field}" is required.`);
    return fallback;
  }
  const num = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(num)) fail('INVALID_FIELD', `"${field}" must be an integer.`);
  if (min !== null && num < min) fail('INVALID_FIELD', `"${field}" must be >= ${min}.`);
  if (max !== null && num > max) fail('INVALID_FIELD', `"${field}" must be <= ${max}.`);
  return num;
}

function asBoolean(value, field, { required = true, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required && fallback === null) fail('MISSING_FIELD', `"${field}" is required.`);
    return fallback;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 0 || value === '0') return false;
  fail('INVALID_FIELD', `"${field}" must be a boolean.`);
}

function asEnum(value, field, allowed, { required = true, fallback = null, normalise } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required && fallback === null) fail('MISSING_FIELD', `"${field}" is required.`);
    return fallback;
  }
  const raw = String(value).trim();
  const candidate = normalise ? normalise(raw) : raw.toLowerCase();
  if (!allowed.includes(candidate)) {
    fail('INVALID_FIELD', `"${field}" must be one of: ${allowed.join(', ')}.`, { allowed });
  }
  return candidate;
}

/**
 * Repeat types. Accepts the canonical frontend values (once | daily | selected)
 * plus a few friendly aliases so the API is forgiving about wording - while the
 * stored value is always canonical.
 */
function asRepeatType(value, field = 'repeat', { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return null;
  }
  const raw = String(value).trim().toLowerCase().replace(/\s+/g, '-');
  const mapped = REPEAT_ALIASES[raw];
  if (!mapped) {
    fail('INVALID_REPEAT', `"${field}" must be one of: once (one-time), daily, selected (selected days).`, {
      allowed: REPEAT_TYPES,
    });
  }
  return mapped;
}

/** selectedDays: array of weekday numbers, Monday = 1 ... Sunday = 7 (ISO-8601). */
function asWeekdayList(value, field = 'selectedDays', { required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return [];
  }
  if (!Array.isArray(value)) fail('INVALID_FIELD', `"${field}" must be an array of weekday numbers (1=Monday .. 7=Sunday).`);
  const out = [];
  for (const item of value) {
    const num = typeof item === 'number' ? item : Number(String(item).trim());
    if (!Number.isInteger(num) || num < 1 || num > 7) {
      fail('INVALID_FIELD', `"${field}" may only contain integers from 1 (Monday) to 7 (Sunday).`);
    }
    if (!out.includes(num)) out.push(num);
  }
  return out.sort((a, b) => a - b);
}

/** IANA timezone validation through Intl (throws RangeError for unknown zones). */
function asTimezone(value, field = 'timezone', { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return null;
  }
  const raw = String(value).trim();
  if (raw.toLowerCase() === 'auto') return 'auto';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw }).format(new Date());
  } catch (err) {
    fail('INVALID_TIMEZONE', `"${field}" is not a recognised IANA timezone (for example "Asia/Kolkata").`, {
      received: raw,
    });
  }
  return raw;
}

function asOffDayReason(value, field = 'reason', { required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail('MISSING_FIELD', `"${field}" is required.`);
    return null;
  }
  const raw = String(value).trim();
  if (raw.length < 2) fail('INVALID_FIELD', `"${field}" must be at least 2 characters.`);
  if (raw.length > 120) fail('INVALID_FIELD', `"${field}" must be at most 120 characters.`);
  return raw;
}

/**
 * Reflection text. Deliberately generous but never empty: an unexplained
 * promise must not be closable with a blank or whitespace-only reason.
 */
function asReflectionReason(value, field = 'reason') {
  if (value === undefined || value === null || value === '') {
    fail('MISSING_FIELD', `"${field}" is required - a reflection needs your actual words.`);
  }
  if (typeof value !== 'string') fail('INVALID_FIELD', `"${field}" must be a string.`);
  const raw = value.trim();
  if (raw.length < 3) {
    fail('INVALID_REFLECTION', `"${field}" is too short. Write at least 3 characters so the reflection means something.`);
  }
  if (raw.length > 2000) {
    fail('INVALID_REFLECTION', `"${field}" must be at most 2000 characters.`);
  }
  return raw;
}

/** Positive integer identifier (task / occurrence / reflection ids). */
function asId(value, field = 'id') {
  const num = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(num) || num <= 0) {
    fail('INVALID_ID', `"${field}" must be a positive integer id.`);
  }
  return num;
}

function asIdList(value, field = 'taskIds') {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail('INVALID_FIELD', `"${field}" must be an array of task ids.`);
  return value.map((item) => asId(item, field));
}

module.exports = {
  REPEAT_TYPES,
  OFF_DAY_REASONS,
  THEMES,
  WEEK_STARTS,
  TIME_RE,
  DATE_RE,
  fail,
  requireObject,
  asString,
  asTime,
  asDate,
  asInt,
  asBoolean,
  asEnum,
  asRepeatType,
  asWeekdayList,
  asTimezone,
  asOffDayReason,
  asReflectionReason,
  asId,
  asIdList,
};
