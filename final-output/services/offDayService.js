'use strict';

const { all, get, run } = require('../database/helpers');
const { ApiError } = require('../utils/errors');
const time = require('../utils/time');
const validate = require('../utils/validate');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Off days.
 *
 * An off day suspends a day's promises without penalty. The critical rule is
 * that an off day can never be activated retroactively: once the applicable
 * deadline (the day's off-day cutoff, defaulting to the daily reset / midnight)
 * has passed, the day is history and history is not editable.
 *
 * That rule is enforced here, from the server clock and the user's timezone -
 * never from anything the client sends.
 */

function rowToOffDay(row) {
  if (!row) return null;
  return {
    id: row.id,
    date: row.date,
    reason: row.reason,
    status: row.status,
    activatedAt: row.activated_at,
    deadlineAt: row.deadline_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * The instant after which activating an off day for `date` is impossible.
 *
 * The deadline is the START of the next day (i.e. this day's end, expressed via
 * the configured off-day cutoff, which defaults to the daily reset). So an off
 * day may be activated at any point during the day it applies to - late at
 * night included - but never once that day is over.
 */
function deadlineFor(db, date) {
  const runtime = getRuntimeSettings(db);
  const nextDay = time.shiftIsoDate(date, 1);
  const cutoff = runtime.offDayCutoff || runtime.dailyReset || '00:00';
  return time.zonedTimeToUtc(nextDay, cutoff, runtime.resolvedTimezone);
}

function getOffDay(db, date) {
  return rowToOffDay(get(db, 'SELECT * FROM off_days WHERE date = ? AND status = ?', [date, 'active']));
}

function isOffDay(db, date) {
  const row = get(db, 'SELECT 1 AS found FROM off_days WHERE date = ? AND status = ?', [date, 'active']);
  return Boolean(row);
}

function listOffDays(db, { from, to, limit = 400 } = {}) {
  const rows = all(
    db,
    `SELECT * FROM off_days
     WHERE status = 'active'
       AND (? IS NULL OR date >= ?)
       AND (? IS NULL OR date <= ?)
     ORDER BY date DESC
     LIMIT ?`,
    [from ?? null, from ?? null, to ?? null, to ?? null, limit]
  );
  return rows.map(rowToOffDay);
}

/**
 * Activates (or updates) an off day.
 *
 * @param {object} deps  { db, clock }
 * @param {object} input { reason, date? }
 */
function activateOffDay({ db, clock }, input) {
  validate.requireObject(input, 'body');
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const reason = validate.asOffDayReason(input.reason, 'reason');
  const requestedDate = input.date ? validate.asDate(input.date, 'date') : today;

  const now = clock.now();
  const deadline = deadlineFor(db, requestedDate);

  // Rule 1: never retroactively. A deadline in the past means the day is closed.
  if (now.getTime() >= deadline.getTime()) {
    const isYesterday = requestedDate < today;
    const message = isYesterday
      ? 'An off day can no longer be activated for yesterday. That day is already part of your history.'
      : requestedDate === today
        ? `The deadline to mark today as an off day has passed (${runtime.offDayCutoff}). Honesty about a day already lived is handled through a reflection, not an off day.`
        : 'An off day can no longer be activated for a day whose deadline has passed.';
    throw ApiError.forbidden('OFF_DAY_DEADLINE_PASSED', message, {
      date: requestedDate,
      deadlineAt: deadline.toISOString(),
      deadlineLocal: `${requestedDate} ${runtime.offDayCutoff} (${runtime.resolvedTimezone})`,
      serverToday: today,
      rule: 'An off day cannot be activated retroactively after its deadline.',
    });
  }

  // Rule 2: no off days in the indefinite future - they are for a real,
  // identified day, not a way to pre-emptively cancel a week.
  const horizon = time.shiftIsoDate(today, 30);
  if (requestedDate > horizon) {
    throw ApiError.badRequest(
      'OFF_DAY_TOO_FAR_AHEAD',
      'An off day can only be activated up to 30 days in advance.',
      { date: requestedDate, latestAllowed: horizon }
    );
  }

  // Rule 3: past non-today dates are always history.
  if (requestedDate < today) {
    throw ApiError.forbidden(
      'OFF_DAY_RETROACTIVE_FORBIDDEN',
      'An off day can no longer be activated for a day that has already passed.',
      { date: requestedDate, serverToday: today }
    );
  }

  const nowIso = time.nowIso(clock);
  run(
    db,
    `INSERT INTO off_days (date, reason, activated_at, deadline_at, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)
     ON CONFLICT(date) DO UPDATE SET
       reason = excluded.reason,
       activated_at = excluded.activated_at,
       deadline_at = excluded.deadline_at,
       status = 'active',
       revoked_at = NULL`,
    [requestedDate, reason, nowIso, deadline.toISOString(), nowIso]
  );

  return {
    offDay: getOffDay(db, requestedDate),
    deadlineAt: deadline.toISOString(),
    activatedFor: requestedDate,
  };
}

function revokeOffDay({ db, clock }, date) {
  const isoDate = validate.asDate(date, 'date');
  const row = get(db, 'SELECT * FROM off_days WHERE date = ? AND status = ?', [isoDate, 'active']);
  if (!row) throw ApiError.notFound('OFF_DAY_NOT_FOUND', `No active off day exists for ${isoDate}.`);
  const nowIso = time.nowIso(clock);
  run(db, "UPDATE off_days SET status = 'revoked', revoked_at = ?, updated_at = ? WHERE id = ?", [
    nowIso,
    nowIso,
    row.id,
  ]);
  return { date: isoDate, revoked: true, revokedAt: nowIso };
}

/** True when the given date may still be declared an off day by the server clock. */
function canActivateOffDay({ db, clock }, date) {
  const isoDate = validate.asDate(date, 'date');
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const deadline = deadlineFor(db, isoDate);
  return {
    date: isoDate,
    allowed: clock.now().getTime() < deadline.getTime() && isoDate >= today,
    deadlineAt: deadline.toISOString(),
    deadlineLocalTime: runtime.offDayCutoff,
    serverToday: today,
    alreadyOffDay: isOffDay(db, isoDate),
  };
}

module.exports = {
  activateOffDay,
  revokeOffDay,
  getOffDay,
  isOffDay,
  listOffDays,
  canActivateOffDay,
  deadlineFor,
  rowToOffDay,
};
