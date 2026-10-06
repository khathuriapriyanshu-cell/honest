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

/**
 * Field aliases.
 *
 * The mobile client names two settings differently from the original web
 * contract. Both spellings are accepted on the way in and both are returned on
 * the way out, so no client has to be rewritten - and they can never disagree,
 * because the aliases are not stored, only translated.
 */
const FIELD_ALIASES = {
  dailyCheckTime: 'accountabilityTime',
  dayResetTime: 'dailyReset',
};

/**
 * Fields accepted from a client but owned by the client itself.
 *
 * `apiUrl` is where *this* app points its fetches; the server has no use for it
 * and never stores it. It is accepted (and echoed back) so that a client which
 * sends it does not get its whole settings update rejected.
 */
const CLIENT_OWNED_KEYS = ['apiUrl'];

/** Every key a client may send. */
const WRITABLE_KEYS = [
  ...Object.keys(DEFAULT_SETTINGS),
  ...Object.keys(FIELD_ALIASES),
  ...CLIENT_OWNED_KEYS,
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
  const settings = {
    accountabilityTime: raw.accountabilityTime,
    dailyReset: raw.dailyReset,
    gracePeriod: Number.isFinite(grace) ? grace : DEFAULT_SETTINGS.gracePeriod,
    notifications: parseBool(raw.notifications, true),
    weekStart: raw.weekStart,
    theme: raw.theme,
    timezone: raw.timezone || 'auto',
    offDayCutoff: raw.offDayCutoff ? raw.offDayCutoff : null,
  };

  // Aliases mirror the canonical values so both clients can read their own name.
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    settings[alias] = settings[canonical];
  }

  // Client-owned fields are echoed back for convenience, never persisted.
  for (const key of CLIENT_OWNED_KEYS) settings[key] = null;

  return settings;
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

  // Fold aliases onto their canonical names, refusing a request that supplies
  // the same setting twice with two different values.
  const canonicalPatch = { ...patch };
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    if (patch[alias] === undefined) continue;
    if (patch[canonical] !== undefined && String(patch[canonical]) !== String(patch[alias])) {
      validate.fail(
        'CONFLICTING_SETTING',
        `"${canonical}" and its alias "${alias}" were both supplied with different values. Send only one.`,
        { [canonical]: patch[canonical], [alias]: patch[alias] }
      );
    }
    canonicalPatch[canonical] = patch[alias];
    delete canonicalPatch[alias];
  }

  const updates = {};

  if (canonicalPatch.accountabilityTime !== undefined) {
    updates.accountabilityTime = validate.asTime(canonicalPatch.accountabilityTime, 'accountabilityTime');
  }
  if (canonicalPatch.dailyReset !== undefined) {
    updates.dailyReset = validate.asTime(canonicalPatch.dailyReset, 'dailyReset');
  }
  if (canonicalPatch.gracePeriod !== undefined) {
    updates.gracePeriod = validate.asInt(canonicalPatch.gracePeriod, 'gracePeriod', { min: 0, max: 240 });
  }
  if (canonicalPatch.notifications !== undefined) {
    updates.notifications = validate.asBoolean(canonicalPatch.notifications, 'notifications');
  }
  if (canonicalPatch.weekStart !== undefined) {
    updates.weekStart = validate.asEnum(canonicalPatch.weekStart, 'weekStart', validate.WEEK_STARTS, {
      normalise: (v) => v.toLowerCase(),
    });
  }
  if (canonicalPatch.theme !== undefined) {
    updates.theme = validate.asEnum(canonicalPatch.theme, 'theme', validate.THEMES, {
      normalise: (v) => v.toLowerCase(),
    });
  }
  if (canonicalPatch.timezone !== undefined) {
    updates.timezone = validate.asTimezone(canonicalPatch.timezone, 'timezone');
  }
  if (canonicalPatch.offDayCutoff !== undefined) {
    updates.offDayCutoff =
      canonicalPatch.offDayCutoff === null || canonicalPatch.offDayCutoff === ''
        ? null
        : validate.asTime(canonicalPatch.offDayCutoff, 'offDayCutoff');
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
  FIELD_ALIASES,
  CLIENT_OWNED_KEYS,
  SERVER_TIMEZONE,
  isValidTimezone,
  getSettings,
  getRuntimeSettings,
  updateSettings,
  getSetting,
  writeKey,
  parseBool,
};
