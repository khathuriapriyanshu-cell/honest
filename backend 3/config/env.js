'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Environment configuration.
 *
 * One module reads every environment variable the backend understands, so the
 * values are parsed, validated and documented in one place instead of being
 * scattered through `process.env` lookups.
 *
 * Supported variables
 * -------------------
 *   PORT                     HTTP port                                   (default 3000)
 *   NODE_ENV                 'production' | 'development'                (default development)
 *   HONEST_DB               SQLite file path, :memory:, file: URL, or a
 *                           libsql/https Turso endpoint                  (see resolveDatabaseTarget)
 *   TURSO_DATABASE_URL       remote libSQL/Turso endpoint (also accepts LIBSQL_URL)
 *   TURSO_AUTH_TOKEN         Turso auth token (also accepts LIBSQL_AUTH_TOKEN)
 *   HONEST_TIMEZONE          IANA zone, or 'automatic'/'auto' to follow the host
 *   CRON_SECRET              shared secret for GET /api/cron/tick
 *   ALLOWED_ORIGINS          comma separated origins / wildcard patterns (default '*')
 *   HONEST_DISABLE_SCHEDULER '1' to disable the in-process background timer
 *   HONEST_SCHEDULER_INTERVAL_MS  background tick interval              (default 30000)
 *   HONEST_FRONTEND_DIR      optional folder served statically
 *   HONEST_SQL_LOG           '1' to log every SQL statement
 *   HONEST_DB_PERSISTENT     '1' to force a local path even where it looks ephemeral
 *   HONEST_TIME_OFFSET_MIN   simulation offset for "now" (testing)
 */

const SERVERLESS_HINTS = ['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY', 'CF_PAGES', 'FUNCTIONS_WORKER_RUNTIME'];

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function boolEnv(value) {
  if (value === undefined || value === null) return false;
  const raw = String(value).trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** True when this process appears to be running inside a serverless platform. */
function isServerless(env = process.env) {
  return SERVERLESS_HINTS.some((name) => Boolean(env[name]));
}

function isWritableDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * True when the directory either exists and is writable, or does not exist yet
 * but its nearest existing ancestor is writable (so it can be created).
 *
 * Without this, pointing HONEST_DB at `./data/honest.db` on a fresh clone would
 * be misreported as an unwritable location and silently moved to a temp file.
 */
function canWriteToDirectory(dir) {
  let current = path.resolve(dir);
  // Walk up until an existing directory is found.
  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(current)) return isWritableDirectory(current);
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/**
 * Creates a directory (and its parents) if it is missing.
 * @returns {boolean} whether the directory exists and is writable afterwards
 */
function ensureDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    return false;
  }
  return isWritableDirectory(dir);
}

function normalizeTimezone(value) {
  if (!value) return 'auto';
  const raw = String(value).trim();
  const lowered = raw.toLowerCase();
  if (lowered === 'auto' || lowered === 'automatic') return 'auto';
  return raw;
}

/**
 * Works out what the database should be:
 *
 *   { kind: 'remote', url, authToken, label }     Turso / libSQL over HTTP
 *   { kind: 'local',  filename, label, ephemeral, reason }
 *
 * A remote target wins over a local path, because pointing at Turso is an
 * explicit decision. A local path that cannot be written falls back to a
 * temporary file rather than crashing the deployment.
 */
function resolveDatabaseTarget(env = process.env) {
  const remoteUrl = firstDefined(env.TURSO_DATABASE_URL, env.LIBSQL_URL, env.HONEST_TURSO_URL);
  if (remoteUrl) {
    return {
      kind: 'remote',
      url: remoteUrl,
      authToken: firstDefined(env.TURSO_AUTH_TOKEN, env.LIBSQL_AUTH_TOKEN, env.HONEST_TURSO_AUTH_TOKEN),
      label: `remote libSQL (${remoteUrl.replace(/\/\/.*@/, '//')})`,
      configured: true,
      ephemeral: false,
    };
  }

  const configured = firstDefined(env.HONEST_DB, env.DATABASE_URL);
  if (!configured) {
    return localTarget(path.resolve(__dirname, '..', 'data', 'honest.db'), false, 'default project path', {
      configured: false,
    });
  }

  if (configured === ':memory:' || configured.startsWith('file::memory:')) {
    return {
      kind: 'local',
      filename: ':memory:',
      label: 'in-memory (nothing is persisted)',
      ephemeral: true,
      configured: true,
    };
  }

  // A libSQL/Turso endpoint given as HONEST_DB still means "remote".
  if (/^(libsql|https?|wss?):\/\//i.test(configured)) {
    return {
      kind: 'remote',
      url: configured,
      authToken: firstDefined(env.TURSO_AUTH_TOKEN, env.LIBSQL_AUTH_TOKEN),
      label: `remote libSQL (${configured.replace(/\/\/.*@/, '//')})`,
      configured: true,
      ephemeral: false,
    };
  }

  // "file:./x.db" style URLs and plain paths both work locally.
  let filename = configured;
  if (filename.startsWith('file:')) filename = filename.slice('file:'.length);
  return localTarget(path.resolve(filename), false, 'HONEST_DB', { configured: true });
}

function localTarget(filename, ephemeral, reason, { configured = false } = {}) {
  const dir = path.dirname(filename);
  const forcedPersistent = boolEnv(process.env.HONEST_DB_PERSISTENT);

  if (!forcedPersistent && !canWriteToDirectory(dir)) {
    const fallback = path.join(os.tmpdir(), 'honest.db');
    return {
      kind: 'local',
      filename: fallback,
      label: `temporary file (${fallback})`,
      ephemeral: true,
      configured: false,
      reason: `${reason}: "${dir}" is not writable`,
      warning:
        'No persistent database is configured. Data will be lost when this instance is recycled. ' +
        'Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or HONEST_DB to a path on a persistent volume.',
    };
  }

  return {
    kind: 'local',
    filename,
    label: `local file (${filename})`,
    ephemeral: Boolean(ephemeral),
    configured,
    reason,
  };
}

/**
 * Is the database likely to disappear?
 *
 * An explicitly configured path is always respected: the operator said where the
 * data lives, and second-guessing them would be wrong (and would also flag the
 * test suite, which points HONEST_DB at a temporary directory on purpose). The
 * check therefore only applies to the *default* location.
 */
function targetIsEphemeral(target, env = process.env) {
  if (!target) return true;
  if (target.kind === 'remote') return false;
  if (target.filename === ':memory:') return true;
  if (target.ephemeral) return true;
  if (boolEnv(env.HONEST_DB_PERSISTENT)) return false;
  if (target.configured) return false;

  if (isServerless(env)) {
    // A default path inside the platform temp directory is never durable.
    const temp = os.tmpdir();
    return String(target.filename).startsWith(temp) || String(target.filename).startsWith('/tmp');
  }
  return false;
}

/**
 * Reads and validates the whole environment once.
 * Throws on a value that would otherwise cause confusing behaviour later.
 */
function readEnv(env = process.env) {
  const portRaw = firstDefined(env.PORT);
  const port = portRaw === null ? 3000 : Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535 (received "${portRaw}").`);
  }

  const nodeEnv = firstDefined(env.NODE_ENV) || 'development';
  const intervalRaw = firstDefined(env.HONEST_SCHEDULER_INTERVAL_MS);
  const interval = intervalRaw === null ? 30000 : Number(intervalRaw);
  if (!Number.isFinite(interval) || interval < 1000) {
    throw new Error(
      `HONEST_SCHEDULER_INTERVAL_MS must be at least 1000 milliseconds (received "${intervalRaw}").`
    );
  }

  const target = resolveDatabaseTarget(env);

  return {
    port,
    nodeEnv,
    isProduction: nodeEnv === 'production',
    serverless: isServerless(env),
    timezone: normalizeTimezone(firstDefined(env.HONEST_TIMEZONE)),
    cronSecret: firstDefined(env.CRON_SECRET),
    allowedOrigins: firstDefined(env.ALLOWED_ORIGINS) || '*',
    schedulerDisabled: boolEnv(env.HONEST_DISABLE_SCHEDULER),
    schedulerIntervalMs: interval,
    /**
     * Run the in-process timer even on a platform that looks serverless. Only
     * useful when the process really does stay alive despite matching a
     * serverless hint (for example a Vercel-like container you control).
     */
    forceTimerScheduler: boolEnv(env.HONEST_FORCE_TIMER_SCHEDULER),
    frontendDir: firstDefined(env.HONEST_FRONTEND_DIR),
    sqlLog: boolEnv(env.HONEST_SQL_LOG),
    timeOffsetMinutes: Number(firstDefined(env.HONEST_TIME_OFFSET_MIN) || 0) || 0,
    database: target,
    databaseIsEphemeral: targetIsEphemeral(target, env),
    raw: env,
  };
}

module.exports = {
  readEnv,
  resolveDatabaseTarget,
  targetIsEphemeral,
  isServerless,
  isWritableDirectory,
  canWriteToDirectory,
  ensureDirectory,
  normalizeTimezone,
  firstDefined,
  boolEnv,
};
