'use strict';

const express = require('express');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');

const { ok } = require('./middleware/respond');
const { errorHandler, notFoundHandler } = require('./middleware/errorHandler');
const { publicSettings } = require('./routes/helpers');
const { SCHEMA_VERSION } = require('./database/db');
const { getRuntimeSettings } = require('./services/settingsService');
const { createCorsOriginHandler } = require('./config/cors');

const { createDayRoutes } = require('./routes/dayRoutes');
const { createTaskRoutes } = require('./routes/taskRoutes');
const { createNightCheckRoutes } = require('./routes/nightCheckRoutes');
const { createCalendarRoutes } = require('./routes/calendarRoutes');
const { createReportRoutes } = require('./routes/reportRoutes');
const { createSettingsRoutes } = require('./routes/settingsRoutes');
const { createOffDayRoutes } = require('./routes/offDayRoutes');
const { createNotificationRoutes } = require('./routes/notificationRoutes');
const { createCronRoutes } = require('./routes/cronRoutes');

/**
 * Express application assembly.
 *
 * `createApp({ db, clock })` returns a fully wired app without listening, which
 * is what the test suite uses to run every scenario against a temporary
 * database and a simulated clock.
 */

const API_INDEX = {
  daily: [
    { method: 'GET', path: '/api/today', purpose: "Today's promises, status, accountability and reflection state" },
    { method: 'GET', path: '/api/day?date=YYYY-MM-DD', purpose: 'The same daily state for any date' },
  ],
  promises: [
    { method: 'GET', path: '/api/tasks', purpose: 'List promises (filters: status, repeat, category)' },
    { method: 'POST', path: '/api/tasks', purpose: 'Create a promise' },
    { method: 'GET', path: '/api/tasks/:id', purpose: 'One promise plus its state today' },
    { method: 'PUT', path: '/api/tasks/:id', purpose: 'Update a promise' },
    { method: 'PATCH', path: '/api/tasks/:id', purpose: 'Partially update a promise' },
    { method: 'DELETE', path: '/api/tasks/:id', purpose: 'Deactivate a promise (?hard=true deletes a history-free one)' },
    { method: 'PUT', path: '/api/tasks/:id/complete', purpose: 'Mark a promise done' },
    { method: 'PUT', path: '/api/tasks/:id/uncomplete', purpose: "Undo today's completion" },
  ],
  accountability: [
    { method: 'GET', path: '/api/night-check', purpose: 'Unfinished promises and the accountability window' },
    { method: 'POST', path: '/api/night-check/reflect', purpose: 'Record an honest reason for missed promises' },
    { method: 'GET', path: '/api/reflections', purpose: 'All recorded reasons' },
    { method: 'GET', path: '/api/notifications', purpose: 'Active backend-scheduled accountability messages' },
    { method: 'GET', path: '/api/notifications/history', purpose: 'Every accountability event the scheduler fired' },
    { method: 'POST', path: '/api/notifications/:id/ack', purpose: 'Acknowledge one message' },
    { method: 'POST', path: '/api/off-day', purpose: 'Activate an off day (deadline enforced server-side)' },
    { method: 'GET', path: '/api/off-day', purpose: 'Off day status and remaining eligibility' },
    { method: 'DELETE', path: '/api/off-day/:date', purpose: 'Revoke an off day' },
  ],
  history: [
    { method: 'GET', path: '/api/calendar?month=&year=', purpose: 'Month overview with per-day status' },
    { method: 'GET', path: '/api/calendar/day/:date', purpose: 'Detailed history for one day' },
    { method: 'GET', path: '/api/history?from=&to=', purpose: 'Flat range history' },
    { method: 'GET', path: '/api/archive?q=', purpose: 'Reflection archive with keyword search' },
  ],
  analytics: [
    { method: 'GET', path: '/api/report/weekly', purpose: 'Weekly honesty report' },
    { method: 'GET', path: '/api/stats/score', purpose: 'Monthly Honest Score and its breakdown' },
    { method: 'GET', path: '/api/stats/honest-days', purpose: 'Honest Days: current streak, month, lifetime' },
    { method: 'GET', path: '/api/insights', purpose: 'Deterministic behavioural patterns' },
  ],
  configuration: [
    { method: 'GET', path: '/api/settings', purpose: 'Read settings' },
    { method: 'PUT', path: '/api/settings', purpose: 'Update settings' },
    { method: 'GET', path: '/api/time', purpose: 'Server date/time in the configured timezone' },
    { method: 'GET', path: '/api/health', purpose: 'Liveness and database status' },
    { method: 'GET', path: '/health', purpose: 'The same health payload for uptime monitors' },
    {
      method: 'GET',
      path: '/api/cron/tick',
      purpose: 'Run the accountability scheduler (serverless cron; requires CRON_SECRET)',
    },
  ],
};

/**
 * Lazily resolves a dependency.
 *
 * On a serverless platform the app is constructed once per cold start but the
 * database must not be opened until the first request actually needs it. Every
 * property here is a getter, so `deps.db` opens the connection on first touch
 * and never before.
 */
function lazyDeps(resolver) {
  let value = null;
  const get = () => {
    if (!value) value = resolver();
    return value;
  };
  const proxy = {};
  for (const key of [
    'db',
    'clock',
    'scheduler',
    'databaseIsEphemeral',
    'databaseDriver',
    'databaseLabel',
    'cronSecret',
    'allowedOrigins',
    'env',
    'frontendDir',
    'version',
    'ensureReady',
  ]) {
    Object.defineProperty(proxy, key, {
      enumerable: true,
      configurable: true,
      get: () => get()[key],
    });
  }
  proxy._resolve = get;
  return proxy;
}

/**
 * Builds the Express application.
 *
 * @param {object} deps
 *   db, clock          required (may be lazy getters)
 *   scheduler          optional; exposes runNow()/status()
 *   cronSecret         shared secret for /api/cron/tick
 *   allowedOrigins     CORS policy string ('*' by default)
 *   frontendDir        optional folder to serve statically
 *   version            reported by GET /api
 *   databaseIsEphemeral  surfaced by /api/health and the cron audit
 *   databaseDriver     'local' | 'libsql'
 *   databaseLabel      human readable database description
 */
function createApp(deps) {
  const app = express();
  const corsHandler = createCorsOriginHandler(
    deps.allowedOrigins !== undefined ? deps.allowedOrigins : process.env.ALLOWED_ORIGINS
  );

  app.disable('x-powered-by');
  // Behind Vercel/most proxies the client IP arrives in X-Forwarded-For.
  app.set('trust proxy', true);
  app.use(
    cors({
      origin: corsHandler,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Cron-Secret'],
      exposedHeaders: ['Content-Length'],
      maxAge: 600,
      preflightContinue: false,
      optionsSuccessStatus: 204,
    })
  );
  app.use(express.json({ limit: '256kb' }));

  // ---------------------------------------------------------------- index/health
  app.get('/api', (req, res) =>
    ok(res, {
      name: 'HONEST backend',
      version: deps.version || '1.0.0',
      environment: deps.env ? deps.env.nodeEnv : process.env.NODE_ENV || 'development',
      endpoints: API_INDEX,
    })
  );

  /**
   * Health payload shared by /api/health and /health.
   * Always HTTP 200: uptime monitors and App Center health checks care about the
   * body, and a hard failure would hide the useful diagnostic detail.
   */
  const health = (req, res) => {
    let database = 'ok';
    let databaseError = null;
    let schemaVersion = SCHEMA_VERSION;
    let timezone = null;

    try {
      deps.db.prepare('SELECT 1 AS ok').get();
      timezone = getRuntimeSettings(deps.db).resolvedTimezone;
      const row = deps.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      if (row) schemaVersion = Number(row.value);
    } catch (err) {
      database = 'unavailable';
      databaseError = err && err.message ? err.message : String(err);
    }

    const scheduler = deps.scheduler ? deps.scheduler.status() : null;

    return ok(res, {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      schemaVersion,
      timestamp: new Date().toISOString(),
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      environment: deps.env ? deps.env.nodeEnv : process.env.NODE_ENV || 'development',
      timezone,
      databaseDriver: deps.databaseDriver || null,
      databaseLabel: deps.databaseLabel || null,
      databaseIsEphemeral: Boolean(deps.databaseIsEphemeral),
      schedulerMode: scheduler ? scheduler.mode : null,
      lastSchedulerRun: scheduler ? scheduler.lastRun : null,
      ...(databaseError ? { databaseError } : {}),
    });
  };

  app.get('/api/health', health);
  app.get('/health', health);

  app.get('/api/time', (req, res) => {
    const settings = publicSettings(deps);
    const runtime = getRuntimeSettings(deps.db);
    return ok(res, {
      serverTimeUtc: deps.clock.now().toISOString(),
      serverDate: settings.serverDate,
      serverTime: settings.serverTime,
      timezone: runtime.resolvedTimezone,
      timezoneSetting: runtime.timezone,
      dailyReset: runtime.dailyReset,
      accountabilityTime: runtime.accountabilityTime,
      gracePeriod: runtime.gracePeriod,
      clockOffsetMinutes: deps.clock.offsetMinutes,
      note: 'The backend is the source of truth for dates. Do not derive the current day from the browser clock.',
    });
  });

  // ---------------------------------------------------------------- domain routes
  app.use('/api', createDayRoutes(deps));
  app.use('/api', createTaskRoutes(deps));
  app.use('/api', createNightCheckRoutes(deps));
  app.use('/api', createCalendarRoutes(deps));
  app.use('/api', createReportRoutes(deps));
  app.use('/api', createSettingsRoutes(deps));
  app.use('/api', createOffDayRoutes(deps));
  app.use('/api', createNotificationRoutes(deps));
  app.use('/api', createCronRoutes(deps));

  // ---------------------------------------------------------- optional frontend
  // Serving the sibling frontend folder from the same origin keeps the browser
  // free of CORS complications. It is strictly optional: if the folder is not
  // present the API still works and the frontend can be hosted separately.
  //
  // The lookup is deferred to the first request on purpose. Reading
  // `deps.frontendDir` while the app is being built would initialise the lazy
  // bootstrap (and open the database) during module evaluation, which is exactly
  // what a serverless cold start must avoid.
  let staticHandler = null;
  app.use((req, res, next) => {
    if (staticHandler === null) {
      let dir = null;
      try {
        dir = deps.frontendDir || null;
      } catch (err) {
        dir = null;
      }
      staticHandler = dir && fs.existsSync(dir) ? express.static(dir, { extensions: ['html'] }) : false;
    }
    if (!staticHandler) {
      next();
      return;
    }
    staticHandler(req, res, next);
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Locates the sibling frontend folder, if it is present.
 *
 * The backend lives at `.../backend-3`, so the frontend is one level up. Set
 * `HONEST_FRONTEND_DIR` to serve it from anywhere else. Returns null when no
 * frontend folder exists - the API is fully usable without one.
 */
function defaultFrontendDir() {
  const projectRoot = path.resolve(__dirname, '..');
  const candidates = [
    process.env.HONEST_FRONTEND_DIR,
    path.join(projectRoot, 'frontend'),
    path.join(projectRoot, '..', 'frontend'),
  ].filter(Boolean);

  return (
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, 'index.html'));
      } catch (err) {
        return false;
      }
    }) || null
  );
}

module.exports = { createApp, API_INDEX, defaultFrontendDir };
