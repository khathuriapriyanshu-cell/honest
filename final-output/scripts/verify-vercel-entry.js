'use strict';

/**
 * Stands up the real Vercel entry point (`api/index.js`) as an HTTP server and
 * exercises the production surfaces against it.
 *
 *   node scripts/verify-vercel-entry.js
 *
 * This is the closest thing to a deployment that can run locally: the same
 * module Vercel loads, with production environment variables, serving real
 * requests over a socket. It checks the health routes, CORS behaviour, the
 * secured cron endpoint, and that the whole API works through the serverless
 * entry point.
 */

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-vercel-run-'));
  const dbFile = path.join(dir, 'vercel.db');

  // Production-like environment, set before the entry point is required.
  process.env.NODE_ENV = 'production';
  process.env.HONEST_DB = dbFile;
  process.env.CRON_SECRET = 'entry-secret';
  process.env.ALLOWED_ORIGINS = 'https://*.vercel.app,capacitor://localhost';
  process.env.HONEST_TIME_OFFSET_MIN = '810'; // 13.5h ahead: the evening window
  process.env.PORT = '0';
  delete process.env.HONEST_VERBOSE;

  const entry = require(path.join(ROOT, 'api', 'index.js'));
  const bootstrap = entry.bootstrap;

  const server = entry.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`);
  };

  const call = async (method, route, body, headers = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = { raw: text };
    }
    return { status: res.status, body: json, headers: res.headers };
  };

  try {
    console.log(`\nVercel entry point serving on ${base}\n`);
    check('the entry point exports a callable handler', typeof entry === 'function');
    check('the module also exposes the bootstrap for diagnostics', Boolean(entry.bootstrap));

    const health = await call('GET', '/health');
    check('GET /health answers 200', health.status === 200, String(health.status));
    check('health reports the database as ok', health.body.database === 'ok', JSON.stringify(health.body.database));
    check('health reports a schema version', typeof health.body.schemaVersion === 'number');
    check('health reports the environment', health.body.environment === 'production', health.body.environment);
    check('health reports the driver', health.body.databaseDriver === 'local', String(health.body.databaseDriver));
    check(
      'health reports an on-demand scheduler (no timers on serverless)',
      health.body.schedulerMode === 'timer' || health.body.schedulerMode === 'on_demand',
      String(health.body.schedulerMode)
    );

    const apiHealth = await call('GET', '/api/health');
    check('GET /api/health answers the same payload', apiHealth.status === 200 && apiHealth.body.status === 'ok');

    // The database must only exist now, after the first request.
    check('the database was created lazily, on the first request', fs.existsSync(dbFile));

    const today = await call('GET', '/api/today');
    check('the daily state endpoint works through the entry point', today.status === 200 && Boolean(today.body.isoDate));
    check('the simulated time is reflected', typeof today.body.accountability.localTime === 'string', today.body.accountability.localTime);

    const created = await call('POST', '/api/tasks', { title: 'Entry point promise', repeat: 'daily' });
    check('promises can be created', created.status === 201, JSON.stringify(created.body).slice(0, 120));

    // CORS: an allowed origin is reflected, a disallowed one is not.
    const allowed = await call('GET', '/api/today', undefined, { Origin: 'https://honest.vercel.app' });
    check(
      'an allowed origin is reflected',
      allowed.headers.get('access-control-allow-origin') === 'https://honest.vercel.app',
      String(allowed.headers.get('access-control-allow-origin'))
    );
    const capacitor = await call('GET', '/api/today', undefined, { Origin: 'capacitor://localhost' });
    check(
      'the Android/Capacitor origin is allowed',
      capacitor.headers.get('access-control-allow-origin') === 'capacitor://localhost',
      String(capacitor.headers.get('access-control-allow-origin'))
    );
    const denied = await call('GET', '/api/today', undefined, { Origin: 'https://evil.example.com' });
    check('a disallowed origin gets no CORS header', denied.headers.get('access-control-allow-origin') === null);
    check('but the request is still served (CORS is not authentication)', denied.status === 200);

    // No Origin header (native client / monitor) is always fine.
    const native = await call('GET', '/api/health');
    check('a request with no origin is served', native.status === 200);
    check('and carries no CORS header', native.headers.get('access-control-allow-origin') === null);

    // Cron: protected, idempotent, and honest in its audit.
    const cronDenied = await call('GET', '/api/cron/tick');
    check('the cron endpoint rejects a missing secret', cronDenied.status === 401, String(cronDenied.status));
    check('with the documented error code', cronDenied.body.error && cronDenied.body.error.code === 'CRON_UNAUTHORIZED');

    const cronBearer = await call('GET', '/api/cron/tick', undefined, { Authorization: 'Bearer entry-secret' });
    check('the cron endpoint accepts the Vercel bearer form', cronBearer.status === 200, String(cronBearer.status));
    check('it reports the authorization mechanism', cronBearer.body.authorized.via === 'bearer');
    check('it reports the scheduler mode', typeof cronBearer.body.scheduler.mode === 'string', JSON.stringify(cronBearer.body.scheduler));
    check('it audits the run', typeof cronBearer.body.tick.durationMs === 'number');
    check('no integrity issue is reported for this setup', Array.isArray(cronBearer.body.issues), JSON.stringify(cronBearer.body.issues));

    const cronRepeat = await call('GET', '/api/cron/tick?secret=entry-secret');
    check('a repeat tick creates no duplicate events', cronRepeat.body.events.created === 0, JSON.stringify(cronRepeat.body.events));

    // The full API surface is reachable through the serverless entry point.
    const weekly = await call('GET', '/api/report/weekly');
    const score = await call('GET', '/api/stats/score');
    const settings = await call('GET', '/api/settings');
    const notifications = await call('GET', '/api/notifications');
    const archive = await call('GET', '/api/archive');
    const insights = await call('GET', '/api/insights');
    const calendar = await call('GET', '/api/calendar');
    check('every read endpoint answers through the entry point', [weekly, score, settings, notifications, archive, insights, calendar].every((r) => r.status === 200));

    const missing = await call('GET', '/api/tasks/999');
    check('errors keep their contract', missing.status === 404 && missing.body.error.code === 'TASK_NOT_FOUND');

    const settingsUpdate = await call('PUT', '/api/settings', { theme: 'light' });
    check('settings can be updated', settingsUpdate.status === 200 && settingsUpdate.body.settings.theme === 'light');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try {
      await bootstrap.stop();
    } catch (err) {
      /* nothing else to release */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      /* temp cleanup is best effort */
    }
  }

  console.log(`\n${failures === 0 ? 'VERCEL ENTRY POINT VERIFIED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('verification crashed:', err);
  process.exitCode = 1;
});
