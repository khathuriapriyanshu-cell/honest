'use strict';

/**
 * Timezone-aware date utilities.
 *
 * The backend is the source of truth for "what day is it". All date-sensitive
 * logic flows through these helpers so the whole app honors one timezone
 * setting without any external dependency (pure Intl-based math).
 *
 * Core concepts:
 * - A "local date" is a plain 'YYYY-MM-DD' string in the user's timezone.
 * - An accountability day D spans [reset(D), reset(D+1)) in the user timezone
 *   (with the default reset of 00:00 this is simply the calendar day).
 * - zonedTimeToInstant() converts (local date, minutes-of-day) -> UTC instant,
 *   and is DST-safe via a two-pass offset refinement.
 */

const DAY_MS = 86400000;

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 100) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function serverTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getZonedParts(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  let hour = parseInt(parts.hour, 10);
  if (hour === 24) hour = 0; // some runtimes report midnight as 24
  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour,
    minute: parseInt(parts.minute, 10),
    second: parseInt(parts.second, 10),
  };
}

function localDateInTz(date, tz) {
  const p = getZonedParts(date, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function localMinutesInTz(date, tz) {
  const p = getZonedParts(date, tz);
  return p.hour * 60 + p.minute;
}

function localTimeInTz(date, tz) {
  const p = getZonedParts(date, tz);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/**
 * UTC instant for a local wall-clock moment.
 * `minutes` may exceed 1440 (e.g. 1470 = 24:30 the following day).
 */
function zonedTimeToInstant(dateStr, minutes, tz) {
  const [y, m, d] = parseDateParts(dateStr);
  const guessMs = Date.UTC(y, m - 1, d, 0, minutes, 0, 0);
  let utc = guessMs;
  for (let i = 0; i < 2; i++) {
    const p = getZonedParts(new Date(utc), tz);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const offset = asUtc - utc; // tz offset ms in effect at that instant
    utc = guessMs - offset;
  }
  return new Date(utc);
}

function parseDateParts(s) {
  return s.split('-').map(Number);
}

function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = parseDateParts(s);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(dateStr, n) {
  const [y, m, d] = parseDateParts(dateStr);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** b - a, in whole calendar days. */
function diffDays(a, b) {
  const [ay, am, ad] = parseDateParts(a);
  const [by, bm, bd] = parseDateParts(b);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday (calendar-date property, timezone-independent). */
function weekdayOf(dateStr) {
  const [y, m, d] = parseDateParts(dateStr);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * The accountability date that owns `now`:
 * day D spans [reset(D), reset(D+1)) in tz. With reset 00:00 this is the
 * plain calendar date; with a later reset (e.g. 04:00) the early-morning
 * hours still belong to the previous accountability day.
 */
function accountabilityDate(now, tz, resetMinutes) {
  const localDate = localDateInTz(now, tz);
  if (!resetMinutes) return localDate;
  const localMin = localMinutesInTz(now, tz);
  if (localMin < resetMinutes) return addDays(localDate, -1);
  return localDate;
}

/** 'HH:MM' -> minutes since midnight, or null if invalid. */
function parseTimeToMinutes(s) {
  if (typeof s !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function formatHHMM(minutes) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** '2026-10-05' -> 'Monday - 5 October' (frontend display format). */
function formatDateHuman(dateStr) {
  const dt = new Date(`${dateStr}T00:00:00Z`);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(dt);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric' }).format(dt);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long' }).format(dt);
  return `${weekday} - ${Number(day)} ${month}`;
}

/** '2026-10' -> 'October 2026'. */
function formatMonthHuman(monthStr) {
  const dt = new Date(`${monthStr}-01T00:00:00Z`);
  const month = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(dt);
  const year = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric' }).format(dt);
  return `${month} ${year}`;
}

/** '2026-10-05' -> 'October 5, 2026'. */
function formatDateLong(dateStr) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(`${dateStr}T00:00:00Z`));
}

module.exports = {
  DAY_MS,
  isValidTimeZone,
  serverTimeZone,
  pad2,
  localDateInTz,
  localMinutesInTz,
  localTimeInTz,
  zonedTimeToInstant,
  isValidDateString,
  addDays,
  diffDays,
  weekdayOf,
  accountabilityDate,
  parseTimeToMinutes,
  formatHHMM,
  formatDateHuman,
  formatMonthHuman,
  formatDateLong,
};
