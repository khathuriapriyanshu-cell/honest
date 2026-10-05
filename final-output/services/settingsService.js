'use strict';

const { DEFAULT_SETTINGS } = require('../database/db');
const { all, run } = require('../database/helpers');
const { resolveTimezone, isValidTimezone, SERVER_TIMEZONE } = require('../utils/time');
const validate = require('../utils/validate');

/**
 * Settings service.
 *
 * Settings are stored as plain key/value rows. Only the keys listed in
 * DEFAULT_SETTINGS (plus the validated extras below) are ever read or written,
 * so a client cannot inject arbitrary configuration keys.
 */

const WRITABLE_KEYS = [
  'accountabilityTime',
  'dailyReset',
  'gracePeriod',
  'notifications',
  'weekStart',
  'theme',
  'timezone',
  'offDayCutoff',
];

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return value === 'true' || value === '1' || value === true;
}

function readRaw(db) {
  const rows = all(db, 'SELECT key, value FROM settings');
  const bag = { ...DEFAULT_SETTINGS };
  for (const row of rows) bag[row.key] = row.value;
  return bag;
}

/** Public (typed) representation returned by GET /api/settings. */
function getSettings(db) {
  const raw = readRaw(db);
  const grace = Number.parseInt(raw.gracePeriod, 10);
  return {
    accountabilityTime: raw.accountabilityTime,
    dailyReset: raw.dailyReset,
    gracePeriod: Number.isFinite(grace) ? grace : DEFAULT_SETTINGS.gracePeriod,
    notifications: parseBool(raw.notifications, true),
    weekStart: raw.weekStart,
    theme: raw.theme,
    timezone: raw.timezone || 'auto',
    offDayCutoff: raw.offDayCutoff ? raw.offDayCutoff : null,
  };
}

/** Everything the scheduler needs, already resolved (no "auto" left). */
function getRuntimeSettings(db) {
  const settings = getSettings(db);
  return {
    ...settings,
    resolvedTimezone: resolveTimezone(settings.timezone),
    // The deadline for activating today's off day. Defaults to the daily reset
    // (midnight), i.e. an off day may never be activated for a day that is
    // already over.
    offDayCutoff: settings.offDayCutoff || settings.dailyReset || '00:00',
  };
}

function writeKey(db, key, value) {
  run(
    db,
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value === null ? '' : String(value)]
  );
}

/**
 * Validates and persists a partial settings update.
 * Returns the full, typed settings object after the write.
 */
function updateSettings(db, patch) {
  validate.requireObject(patch, 'body');
  // Reject unknown keys loudly instead of silently ignoring a frontend typo.
  const unknown = Object.keys(patch).filter((key) => !WRITABLE_KEYS.includes(key));
  if (unknown.length > 0) {
    validate.fail('UNKNOWN_SETTING', `Unknown setting key(s): ${unknown.join(', ')}.`, {
      allowed: WRITABLE_KEYS,
    });
  }

  const updates = {};

  if (patch.accountabilityTime !== undefined) {
    updates.accountabilityTime = validate.asTime(patch.accountabilityTime, 'accountabilityTime');
  }
  if (patch.dailyReset !== undefined) {
    updates.dailyReset = validate.asTime(patch.dailyReset, 'dailyReset');
  }
  if (patch.gracePeriod !== undefined) {
    updates.gracePeriod = validate.asInt(patch.gracePeriod, 'gracePeriod', { min: 0, max: 240 });
  }
  if (patch.notifications !== undefined) {
    updates.notifications = validate.asBoolean(patch.notifications, 'notifications');
  }
  if (patch.weekStart !== undefined) {
    updates.weekStart = validate.asEnum(patch.weekStart, 'weekStart', validate.WEEK_STARTS, {
      normalise: (v) => v.toLowerCase(),
    });
  }
  if (patch.theme !== undefined) {
    updates.theme = validate.asEnum(patch.theme, 'theme', validate.THEMES, { normalise: (v) => v.toLowerCase() });
  }
  if (patch.timezone !== undefined) {
    updates.timezone = validate.asTimezone(patch.timezone, 'timezone');
  }
  if (patch.offDayCutoff !== undefined) {
    updates.offDayCutoff =
      patch.offDayCutoff === null || patch.offDayCutoff === ''
        ? null
        : validate.asTime(patch.offDayCutoff, 'offDayCutoff');
  }

  // Nothing is written unless every field above validated successfully.
  for (const [key, value] of Object.entries(updates)) {
    writeKey(db, key, value);
  }

  return getSettings(db);
}

function getSetting(db, key) {
  const raw = readRaw(db);
  return raw[key];
}

module.exports = {
  DEFAULT_SETTINGS,
  WRITABLE_KEYS,
  SERVER_TIMEZONE,
  isValidTimezone,
  getSettings,
  getRuntimeSettings,
  updateSettings,
  getSetting,
  writeKey,
  parseBool,
};
