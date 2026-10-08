'use strict';

const { openDatabase } = require('./database/db');
const { Clock } = require('./utils/clock');
const { readEnv } = require('./config/env');
const { createApp, defaultFrontendDir } = require('./app');
const { startScheduler, createServerlessScheduler } = require('./scheduler/scheduler');
const { getRuntimeSettings, writeKey } = require('./services/settingsService');
const { SERVER_TIMEZONE, isValidTimezone } = require('./utils/time');

/**
 * Application lifecycle.
 *
 * One place builds the whole backend, so every entry point shares the same
 * behaviour:
 *
 *   server.js            long-running process (local, VPS, Render, Railway, Fly)
 *   api/index.js         Vercel serverless function
 *
 * Most important property: **the database is opened lazily**. A serverless
 * platform evaluates the module on every cold start, and connecting to a remote
 * database during module evaluation would make every cold start slower and make
 * an import failure look like a deployment failure. Nothing is touched until the
 * first request needs it.
 */

/**
 * @param {object} options
 * @param {object} options.env       result of readEnv() (defaults to reading process.env)
 * @param {boolean} options.verbose  print the start-up banner when the database opens
 */
function createBootstrap(options = {}) {
  const env = options.env || readEnv();
  const verbose = options.verbose !== false;

  let state = null; // { db, clock, scheduler, migration, driver, label }
  let initialising = false;
  let readyError = null;

  function initialise() {
    if (state) return state;
    if (readyError) throw readyError;

    // ---- database ---------------------------------------------------------
    // A remote target (Turso) or a local file, decided by config/env.js.
    const opened = openDatabase({
      url: env.database.kind === 'remote' ? env.database.url : undefined,
      authToken: env.database.kind === 'remote' ? env.database.authToken : undefined,
      filename: env.database.kind === 'local' ? env.database.filename : undefined,
      target: env.database,
    });

    const { db } = opened;

    // ---- timezone ---------------------------------------------------------
    // HONEST_TIMEZONE overrides the stored setting for this process only.
    if (env.timezone && env.timezone !== 'auto') {
      if (isValidTimezone(env.timezone)) writeKey(db, 'timezone', env.timezone);
      else console.warn(`[honest] HONEST_TIMEZONE="${env.timezone}" is not a valid IANA zone; keeping the stored setting.`);
    }

    const clock = new Clock(db);
    if (env.timeOffsetMinutes) clock.setOffsetMinutes(env.timeOffsetMinutes);

    // ---- scheduler --------------------------------------------------------
    // Serverless platforms cannot rely on timers; they use /api/cron/tick.
    const useTimer = !env.schedulerDisabled && (!env.serverless || env.forceTimerScheduler);
    const schedulerDeps = { db, clock };
    const scheduler = useTimer
      ? startScheduler(schedulerDeps, { intervalMs: env.schedulerIntervalMs })
      : createServerlessScheduler(schedulerDeps);

    const frontendDir = env.frontendDir || defaultFrontendDir();
    const runtime = getRuntimeSettings(db);

    state = {
      db,
      clock,
      scheduler,
      migration: opened.migration,
      driver: opened.driver,
      label: opened.description,
      frontendDir,
      runtime,
    };

    if (verbose) printBanner({ env, opened, runtime, scheduler, frontendDir });

    return state;
  }

  function ensureReady() {
    if (state) return state;
    if (readyError) throw readyError;
    if (initialising) return state; // re-entrant guard (should not happen)
    initialising = true;
    try {
      return initialise();
    } catch (err) {
      readyError = err;
      throw err;
    } finally {
      initialising = false;
    }
  }

  /**
   * Lazily built dependency object. Every property opens the database on first
   * access; nothing happens at require time.
   */
  const deps = {};
  const define = (key, resolve) => {
    Object.defineProperty(deps, key, { enumerable: true, configurable: true, get: resolve });
  };

  define('db', () => ensureReady().db);
  define('clock', () => ensureReady().clock);
  define('scheduler', () => ensureReady().scheduler);
  define('frontendDir', () => env.frontendDir || defaultFrontendDir());
  define('databaseDriver', () => ensureReady().driver);
  define('databaseLabel', () => ensureReady().label);
  define('databaseIsEphemeral', () => env.databaseIsEphemeral);
  define('cronSecret', () => env.cronSecret);
  define('allowedOrigins', () => env.allowedOrigins);
  define('env', () => env);
  define('version', () => require('./package.json').version);
  define('ensureReady', () => ensureReady);

  const app = createApp(deps);

  /** Starts the timer scheduler if the platform supports one. No-op otherwise. */
  function start() {
    ensureReady();
    if (state.scheduler && typeof state.scheduler.start === 'function') state.scheduler.start();
    return state;
  }

  /** Releases resources. Async because HTTP servers close asynchronously. */
  async function stop() {
    if (state && state.scheduler) state.scheduler.stop();
    if (state && state.db) {
      try {
        state.db.close();
      } catch (err) {
        /* already closed */
      }
    }
  }

  return {
    app,
    deps,
    env,
    ensureReady,
    start,
    stop,
    status() {
      return {
        ready: Boolean(state),
        error: readyError ? readyError.message : null,
        driver: state ? state.driver : null,
        label: state ? state.label : null,
      };
    },
    /** Exposed for scripts and tests that need the raw pieces. */
    get state() {
      return state;
    },
  };
}

function printBanner({ env, opened, runtime, scheduler, frontendDir }) {
  const lines = [
    '',
    '  HONEST backend - BE HONEST WITH YOURSELF.',
    '  ---------------------------------------------------------------',
    `  Environment    ${env.nodeEnv}${env.serverless ? ' (serverless)' : ''}`,
    `  Database       ${opened.description}`,
    `  Schema         v${opened.migration.to}${opened.migration.applied ? ' (migrated)' : ''}`,
    `  Timezone       ${runtime.resolvedTimezone} (setting: ${runtime.timezone}, host: ${SERVER_TIMEZONE})`,
    `  Accountability ${runtime.accountabilityTime}  |  reset ${runtime.dailyReset}  |  grace ${runtime.gracePeriod} min`,
    `  Scheduler      ${scheduler.mode}${scheduler.mode === 'timer' ? ` every ${env.schedulerIntervalMs} ms` : ' (driven by GET /api/cron/tick)'}`,
    `  CORS           ${env.allowedOrigins}`,
    `  Cron secret    ${env.cronSecret ? 'configured' : 'NOT SET (endpoint is open)'}`,
    `  Frontend files ${frontendDir || 'not served (API only)'}`,
  ];
  if (env.databaseIsEphemeral) {
    lines.push('');
    lines.push('  !! WARNING: the database is NOT persistent on this platform.');
    if (env.database && env.database.warning) lines.push(`     ${env.database.warning}`);
    lines.push('     Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN, or HONEST_DB to a path on a');
    lines.push('     persistent volume. Data will be lost when this instance is recycled.');
  }

  if (env.isProduction && env.allowedOrigins === '*') {
    lines.push('');
    lines.push('  NOTE: ALLOWED_ORIGINS is "*" in production, so any website may call this API.');
    lines.push('        Native clients are unaffected. Set ALLOWED_ORIGINS to restrict browsers.');
  }

  if (env.isProduction && !env.cronSecret) {
    lines.push('');
    lines.push('  NOTE: CRON_SECRET is not set, so /api/cron/tick is publicly callable.');
  }

  lines.push('  ---------------------------------------------------------------');
  console.log(lines.join('\n'));
}

module.exports = { createBootstrap, printBanner };
