'use strict';

const dayService = require('../services/dayService');
const statsService = require('../services/statsService');
const notificationService = require('../services/notificationService');
const { getRuntimeSettings, getSettings } = require('../services/settingsService');

/**
 * Shared route helpers.
 *
 * `deps` is the small object every route module receives: the SQLite handle and
 * the clock. Passing it explicitly (instead of importing a singleton) is what
 * lets the test suite run against an isolated database with a simulated clock.
 */

/** Full daily state, including the honest-day streak and live accountability state. */
function dayStatePayload(deps, date = null) {
  const { db, clock } = deps;
  const streak = statsService.currentHonestStreak(deps);
  const state = dayService.buildDayState(deps, date, { honestDays: streak.current });
  const notifications = notificationService.activeNotifications(deps, { limit: 3 });
  return {
    ...state,
    // The frontend contract names the ISO date `isoDate`; both spellings are
    // provided so no client has to guess.
    isoDate: state.date,
    honestDays: streak.current,
    honestDaysDetail: { current: streak.current, todayHonest: streak.todayHonest, todayPending: streak.todayPending },
    notifications,
    settings: publicSettings(deps),
  };
}

/**
 * Settings plus the server's resolved view of time - the frontend never guesses.
 *
 * Built by spreading `getSettings()` rather than listing fields by hand, so any
 * field the settings service adds (the mobile aliases `dailyCheckTime` /
 * `dayResetTime`, or the client-owned `apiUrl`) is surfaced here automatically
 * instead of being silently dropped.
 */
function publicSettings(deps) {
  const { db, clock } = deps;
  const runtime = getRuntimeSettings(db);
  return {
    ...getSettings(db),
    timezoneResolved: runtime.resolvedTimezone,
    serverDate: clock.today(runtime.resolvedTimezone),
    serverTime: clock.currentHhmm(runtime.resolvedTimezone),
  };
}

/** Reads a query string value, treating empty strings as absent. */
function queryValue(req, key) {
  const value = req.query[key];
  if (value === undefined || value === null || value === '') return null;
  return Array.isArray(value) ? value[0] : value;
}

module.exports = { dayStatePayload, publicSettings, queryValue };
