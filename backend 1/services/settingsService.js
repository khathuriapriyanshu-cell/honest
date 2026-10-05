'use strict';

/**
 * Settings + the "clock context".
 *
 * getClockContext(db, now) is the single object every date-sensitive service
 * uses: effective timezone, reset/accountability/grace minutes, today's
 * accountability date, the phase deadlines as UTC instants, and the current
 * phase. The server clock is the only authority — the browser clock is never
 * consulted.
 */

const { badRequest } = require('../utils/errors');
const { fail, assertBodyObject, vString, vNumber, vBoolean, vEnum, vTime } = require('../utils/validate');
const {
  isValidTimeZone,
  serverTimeZone,
  accountabilityDate,
  zonedTimeToInstant,
  addDays,
  parseTimeToMinutes,
} = require('../utils/dates');
const { DEFAULT_SETTINGS } = require('../database/schema');

function getRawSettings(db) {
  const rows = db.all('SELECT key, value FROM settings');
  const map = {};
  for (const row of rows) map[row.key] = row.value;
  return { ...DEFAULT_SETTINGS, ...map };
}

/** Parsed, defensively-defaulted settings (survives a corrupted row). */
function getSettings(db) {
  const raw = getRawSettings(db);
  const tzSetting =
    typeof raw.timezone === 'string' && (raw.timezone === 'auto' || isValidTimeZone(raw.timezone))
      ? raw.timezone
      : 'auto';
  const reset = parseTimeToMinutes(String(raw.daily_reset_time));
  const acc = parseTimeToMinutes(String(raw.accountability_time));
  const graceRaw = Number(raw.grace_period_minutes);
  return {
    timezone: tzSetting,
    timezoneEffective: tzSetting === 'auto' ? serverTimeZone() : tzSetting,
    dailyResetTime: reset !== null ? String(raw.daily_reset_time) : DEFAULT_SETTINGS.daily_reset_time,
    accountabilityTime: acc !== null ? String(raw.accountability_time) : DEFAULT_SETTINGS.accountability_time,
    gracePeriodMinutes:
      Number.isFinite(graceRaw) && graceRaw >= 0 && graceRaw <= 360 ? Math.round(graceRaw) : 15,
    notificationsEnabled: String(raw.notifications_enabled) !== 'false',
    weekStarts: raw.week_starts === 'sunday' ? 'sunday' : 'monday',
    theme: typeof raw.theme === 'string' && raw.theme.trim() ? raw.theme.trim() : DEFAULT_SETTINGS.theme,
  };
}

/**
 * Cross-field timing rules (so the phase machine is always well-ordered):
 * - accountability must happen strictly after the daily reset (same day);
 * - accountability + two grace windows must not spill past the next reset.
 */
function validateTiming(resetMin, accMin, graceMin) {
  if (!(accMin > resetMin)) {
    throw badRequest(
      'INVALID_SETTINGS',
      'Accountability time must come after the daily reset time (within the same day).'
    );
  }
  if (accMin + 2 * graceMin > resetMin + 1440) {
    throw badRequest(
      'INVALID_SETTINGS',
      'Accountability time plus two grace windows would pass the next daily reset. Move the accountability time earlier or shorten the grace period.'
    );
  }
}

function getClockContext(db, now) {
  const s = getSettings(db);
  const tz = s.timezoneEffective;
  const resetMin = parseTimeToMinutes(s.dailyResetTime) ?? 0;
  const accMin = parseTimeToMinutes(s.accountabilityTime) ?? 1350;
  const graceMin = s.gracePeriodMinutes;
  const todayDate = accountabilityDate(now, tz, resetMin);

  const accountabilityAt = zonedTimeToInstant(todayDate, accMin, tz);
  const graceEndAt = new Date(accountabilityAt.getTime() + graceMin * 60000);
  const resetAt = zonedTimeToInstant(addDays(todayDate, 1), resetMin, tz);
  const finalWarningAt = new Date(resetAt.getTime() - graceMin * 60000);

  const t = now.getTime();
  let phase = 'open';
  if (t >= accountabilityAt.getTime()) phase = 'accountability';
  if (graceMin > 0 && t >= graceEndAt.getTime()) phase = 'grace_ended';
  if (t >= finalWarningAt.getTime()) phase = 'final_warning';

  return {
    now,
    timezoneSetting: s.timezone,
    timezone: tz,
    resetMinutes: resetMin,
    accountabilityMinutes: accMin,
    graceMinutes: graceMin,
    weekStarts: s.weekStarts,
    notificationsEnabled: s.notificationsEnabled,
    theme: s.theme,
    settings: s,
    todayDate,
    accountabilityAt,
    graceEndAt,
    finalWarningAt,
    resetAt,
    phase,
  };
}

/** Instant at which dateStr's day closes (its next daily reset). */
function dayResetInstant(clock, dateStr) {
  return zonedTimeToInstant(addDays(dateStr, 1), clock.resetMinutes, clock.timezone);
}

/** Deadline for activating (or removing) an off day for dateStr: accountability + grace. */
function offDayDeadlineFor(clock, dateStr) {
  const accAt = zonedTimeToInstant(dateStr, clock.accountabilityMinutes, clock.timezone);
  return new Date(accAt.getTime() + clock.graceMinutes * 60000);
}

/**
 * Update settings. Accepts canonical keys (dailyResetTime, gracePeriodMinutes,
 * weekStarts, notificationsEnabled) and the frontend's flat keys
 * (dailyReset, gracePeriod, weekStart, notifications). Unknown keys are
 * ignored on purpose — the frontend stores its own client-side preferences
 * (e.g. apiUrl) in the same object.
 */
function updateSettings(db, body) {
  const input = assertBodyObject(body);
  const current = getSettings(db);

  const timezone = vString(input.timezone, 'timezone', { max: 100, defaultValue: current.timezone });
  if (timezone !== 'auto' && !isValidTimeZone(timezone)) {
    throw fail('timezone', 'must be "auto" or a valid IANA timezone (e.g. "Asia/Kolkata").');
  }
  const dailyResetTime = vTime(
    input.dailyResetTime !== undefined ? input.dailyResetTime : input.dailyReset,
    'dailyResetTime',
    { defaultValue: current.dailyResetTime }
  );
  const accountabilityTime = vTime(input.accountabilityTime, 'accountabilityTime', {
    defaultValue: current.accountabilityTime,
  });
  const gracePeriodMinutes = vNumber(
    input.gracePeriodMinutes !== undefined ? input.gracePeriodMinutes : input.gracePeriod,
    'gracePeriodMinutes',
    { min: 0, max: 360, integer: true, defaultValue: current.gracePeriodMinutes }
  );
  const notificationsEnabled = vBoolean(
    input.notificationsEnabled !== undefined ? input.notificationsEnabled : input.notifications,
    'notificationsEnabled',
    { defaultValue: current.notificationsEnabled }
  );
  const weekStarts = vEnum(
    input.weekStarts !== undefined ? input.weekStarts : input.weekStart,
    'weekStarts',
    ['monday', 'sunday'],
    { defaultValue: current.weekStarts }
  );
  const theme = vString(input.theme, 'theme', { max: 30, defaultValue: current.theme });

  validateTiming(parseTimeToMinutes(dailyResetTime), parseTimeToMinutes(accountabilityTime), gracePeriodMinutes);

  const entries = {
    timezone,
    daily_reset_time: dailyResetTime,
    accountability_time: accountabilityTime,
    grace_period_minutes: String(gracePeriodMinutes),
    notifications_enabled: String(notificationsEnabled),
    week_starts: weekStarts,
    theme,
  };
  for (const [key, value] of Object.entries(entries)) {
    db.run(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value
    );
  }
  return getSettings(db);
}

module.exports = {
  getSettings,
  getClockContext,
  updateSettings,
  validateTiming,
  dayResetInstant,
  offDayDeadlineFor,
};
