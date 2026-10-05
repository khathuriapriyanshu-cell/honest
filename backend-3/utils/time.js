'use strict';

/**
 * Timezone and calendar-date helpers.
 *
 * The backend - never the browser - decides what "today" is. Every date
 * sensitive rule (daily task lists, midnight, accountability time, grace
 * period, reflections, calendar history, recurring tasks, reports) is resolved
 * through this module using the user's configured timezone.
 *
 * Timestamps are persisted as UTC ISO-8601 strings ("...Z"). Calendar dates are
 * persisted as plain "YYYY-MM-DD" strings that are already expressed in the
 * user's timezone. That split keeps sorting/comparison trivial while remaining
 * correct when the user changes timezone.
 */

const DATE_FMT_CACHE = new Map();
const PART_FMT_CACHE = new Map();
const OFFSET_FMT_CACHE = new Map();

const SERVER_TIMEZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (err) {
    return 'UTC';
  }
})();

function isValidTimezone(zone) {
  if (typeof zone !== 'string' || zone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Resolves a configured timezone value to a concrete IANA zone.
 * "auto" (the default) follows the server/host timezone.
 */
function resolveTimezone(configured) {
  if (!configured || String(configured).toLowerCase() === 'auto') return SERVER_TIMEZONE;
  const raw = String(configured).trim();
  return isValidTimezone(raw) ? raw : SERVER_TIMEZONE;
}

function dateFormatter(zone) {
  let fmt = DATE_FMT_CACHE.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DATE_FMT_CACHE.set(zone, fmt);
  }
  return fmt;
}

function partFormatter(zone) {
  let fmt = PART_FMT_CACHE.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PART_FMT_CACHE.set(zone, fmt);
  }
  return fmt;
}

function offsetFormatter(zone) {
  let fmt = OFFSET_FMT_CACHE.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    OFFSET_FMT_CACHE.set(zone, fmt);
  }
  return fmt;
}

/**
 * Wall-clock parts for an instant in a zone.
 * @param {Date} date
 * @param {string} zone
 * @returns {{year:number,month:number,day:number,hour:number,minute:number,second:number,isoDate:string,hhmm:string,isoWeekday:number}}
 */
function getZonedParts(date, zone) {
  const dtf = partFormatter(zone);
  const parts = dtf.formatToParts(date);
  const bag = {};
  for (const part of parts) {
    if (part.type !== 'literal') bag[part.type] = part.value;
  }
  let hour = Number(bag.hour);
  // Some ICU builds render midnight as "24" with hour12:false.
  if (hour === 24) hour = 0;
  const year = Number(bag.year);
  const month = Number(bag.month);
  const day = Number(bag.day);
  const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    isoDate,
    hhmm: `${String(hour).padStart(2, '0')}:${String(bag.minute).padStart(2, '0')}`,
    isoWeekday: isoWeekdayFromDate(isoDate),
  };
}

/** Minutes to add to UTC to obtain wall time in `zone` at instant `date`. */
function getOffsetMinutes(date, zone) {
  const parts = getZonedParts(date, zone);
  // Fractional part of the wall clock is not needed; second precision is enough
  // because offsets are whole minutes in every zone SQLite/Intl knows about.
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const utcSeconds = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - utcSeconds) / 60000);
}

function shiftIsoDate(isoDate, days) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const shifted = new Date(base + days * 86400000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate()
  ).padStart(2, '0')}`;
}

/** ISO-8601 weekday: Monday = 1 ... Sunday = 7. */
function isoWeekdayFromDate(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return dow === 0 ? 7 : dow;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Inclusive list of ISO dates between two dates. */
function enumerateDates(fromIso, toIso) {
  const out = [];
  let cursor = fromIso;
  let guard = 0;
  while (cursor <= toIso && guard < 4000) {
    out.push(cursor);
    cursor = shiftIsoDate(cursor, 1);
    guard += 1;
  }
  return out;
}

/**
 * Converts a wall-clock time in a zone into the corresponding UTC instant.
 *
 * Works by guessing the instant from the naive UTC encoding, reading the real
 * offset at that guess and correcting. One iteration is enough for every real
 * zone; a second pass handles DST boundary ambiguity deterministically (the
 * pre-transition offset is preferred, matching how calendars read a clock).
 */
function zonedTimeToUtc(isoDate, hhmm, zone) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const [hh, mm] = String(hhmm || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  let offset = getOffsetMinutes(new Date(naive), zone);
  let instant = naive - offset * 60000;
  const corrected = getOffsetMinutes(new Date(instant), zone);
  if (corrected !== offset) {
    offset = corrected;
    instant = naive - offset * 60000;
  }
  return new Date(instant);
}

/** Current instant as a Date (kept in one place so it can be time-shifted in tests). */
function nowInstant(clock) {
  return clock ? clock.now() : new Date();
}

function nowIso(clock) {
  return nowInstant(clock).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The calendar date (in `zone`) that an instant belongs to. */
function dateForInstant(date, zone) {
  return getZonedParts(date, zone).isoDate;
}

/** "Monday - 5 October" - the exact display format the frontend expects. */
function formatLongDate(isoDate, locale) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const weekday = new Intl.DateTimeFormat(locale || 'en-GB', { weekday: 'long', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat(locale || 'en-GB', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday} - ${d} ${month}`;
}

/** "October 3, 2026" - used by the archive. */
function formatArchiveDate(isoDate, locale) {
  const [y, m, d] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const month = new Intl.DateTimeFormat(locale || 'en-GB', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${month} ${d}, ${y}`;
}

/** "October 2026" */
function formatMonthLabel(year, month, locale) {
  const date = new Date(Date.UTC(year, month - 1, 1));
  const monthName = new Intl.DateTimeFormat(locale || 'en-GB', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${monthName} ${year}`;
}

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12) return false;
  if (d < 1 || d > daysInMonth(y, m)) return false;
  return true;
}

module.exports = {
  SERVER_TIMEZONE,
  isValidTimezone,
  resolveTimezone,
  getZonedParts,
  getOffsetMinutes,
  zonedTimeToUtc,
  shiftIsoDate,
  isoWeekdayFromDate,
  daysInMonth,
  enumerateDates,
  nowInstant,
  nowIso,
  dateForInstant,
  formatLongDate,
  formatArchiveDate,
  formatMonthLabel,
  isValidIsoDate,
};
