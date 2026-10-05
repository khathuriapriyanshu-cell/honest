'use strict';

/**
 * Minimal test framework + isolated application harness.
 *
 * No test runner dependency: `node tests/run.js` executes every test file in
 * this folder sequentially against a temporary SQLite database and reports a
 * summary. Each test gets:
 *
 *   - its own database file (deleted on teardown);
 *   - its own Clock, whose offset from real time is set explicitly, so midnight
 *     rollovers, grace periods, grace expiry and off-day deadlines are tested
 *     deterministically instead of depending on when the suite happens to run;
 *   - a real HTTP server on an ephemeral port, so routes, validation, status
 *     codes and JSON shapes are all exercised exactly as the frontend sees them.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDatabase } = require('../database/db');
const { Clock } = require('../utils/clock');
const { createApp } = require('../app');
const { startScheduler } = require('../scheduler/scheduler');

const state = { passed: 0, failed: 0, files: [] };
const assertions = [];

function isDeepStrictEqual(a, b) {
  return require('node:util').isDeepStrictEqual(a, b);
}

function record(ok, message) {
  assertions.push({ ok, message });
  if (ok) {
    state.passed += 1;
  } else {
    state.failed += 1;
    console.error(`  ✗ ${message}`);
  }
}

function format(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text.length > 220 ? `${text.slice(0, 220)}…` : text;
  } catch (err) {
    return String(value);
  }
}

function assertTrue(value, message = 'expected a truthy value') {
  record(Boolean(value), `${message} (received ${format(value)})`);
}

function assertEqual(actual, expected, message = 'values should be equal') {
  record(isDeepStrictEqual(actual, expected), `${message} — expected ${format(expected)}, received ${format(actual)}`);
}

function assertNotEqual(actual, expected, message = 'values should differ') {
  record(!isDeepStrictEqual(actual, expected), `${message} — both were ${format(actual)}`);
}

function assertIncludes(haystack, needle, message = 'value should be included') {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  record(text.includes(needle), `${message} — "${needle}" not found in ${format(haystack)}`);
}

function assertNotIncludes(haystack, needle, message = 'value should not be included') {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  record(!text.includes(needle), `${message} — "${needle}" unexpectedly found in ${format(haystack)}`);
}

function assertMatch(text, regex, message = 'value should match') {
  record(regex.test(String(text)), `${message} — ${format(text)} does not match ${regex}`);
}

function assertThrows(fn, message = 'expected a throw') {
  try {
    fn();
    record(false, `${message} (nothing was thrown)`);
  } catch (err) {
    record(true, message);
  }
}

/**
 * Boots an isolated instance of the whole backend.
 *
 * @param {object} options
 *   localTime {string}   "HH:MM" that the clock should report in the test timezone
 *   timezone  {string}   IANA zone for the instance (default Europe/London)
 *   offsetMinutes {number} explicit clock offset, overrides localTime
 *   tempDb    {boolean}  false to keep the database for a persistence test
 */
async function createContext(options = {}) {
  const timezone = options.timezone || 'Europe/London';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-test-'));
  const dbFile = path.join(dir, 'test.db');
  const { db } = openDatabase(dbFile);

  if (options.timezone !== undefined) {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('timezone', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(timezone);
  }
  if (options.settings) {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    for (const [key, value] of Object.entries(options.settings)) upsert.run(key, String(value));
  }

  const clock = new Clock(db);
  // "auto" is a setting, not a zone: resolve it before any wall-clock math.
  const resolvedZone = require('../services/settingsService').getRuntimeSettings(db).resolvedTimezone;
  if (options.offsetMinutes !== undefined) {
    clock.setOffsetMinutes(options.offsetMinutes);
  } else {
    // Every simulated run starts from the same fictional "now" so that dates in
    // assertions are deterministic. 2026-10-05T12:00Z is a Monday, which also
    // makes weekday-dependent rules easy to reason about.
    clock.setOffsetMinutes((Date.UTC(2026, 9, 5, 12, 0, 0) - Date.now()) / 60000);
    if (options.localTime) {
      const parts = clock.parts(resolvedZone);
      const current = parts.hour * 60 + parts.minute;
      const wanted = String(options.localTime).split(':').map(Number);
      clock.advanceMinutes(wanted[0] * 60 + wanted[1] - current);
    }
  }

  const deps = {
    db,
    clock,
    frontendDir: null,
    // Production surfaces, overridable per test:
    cronSecret: options.cronSecret,
    allowedOrigins: options.allowedOrigins !== undefined ? options.allowedOrigins : '*',
    databaseDriver: 'local',
    databaseLabel: 'local file (test)',
    databaseIsEphemeral: false,
  };
  const scheduler = startScheduler(deps, { intervalMs: 60000 });
  deps.scheduler = scheduler;
  const app = createApp(deps);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // The simulated day the instance started on, captured before any test moves
  // the clock. Fixtures anchor to this so they stay stable.
  const baseDate = clock.today(
    require('../services/settingsService').getRuntimeSettings(db).resolvedTimezone
  );

  const context = {
    db,
    clock,
    deps,
    scheduler,
    server,
    dbFile,
    dir,
    timezone,
    baseUrl,

    /** True when the simulated clock's local date equals the real date. */
    isAtRealDate() {
      return clock.today(timezone) === new Date().toISOString().slice(0, 10);
    },

    today() {
      // Reads the timezone from settings so a test that changes it mid-run sees
      // the same day the backend does.
      return clock.today(require('../services/settingsService').getRuntimeSettings(db).resolvedTimezone);
    },

    /**
     * The day the instance was created on. Tests that move the clock around
     * still need a stable "today" to anchor their fixtures to.
     */
    baseDay() {
      return baseDate;
    },

    shiftDate(date, days) {
      return require('../utils/time').shiftIsoDate(date, days);
    },

    /** Sets the simulated local wall-clock time on the current simulated day. */
    setLocalTime(hhmm) {
      const parts = clock.parts(timezone);
      const current = parts.hour * 60 + parts.minute;
      const wanted = String(hhmm).split(':').map(Number);
      clock.advanceMinutes(wanted[0] * 60 + wanted[1] - current);
      return clock.parts(timezone);
    },

    /**
     * Jumps the simulated clock to a wall-clock time on the *current simulated
     * day*, resolving the exact UTC instant in the test timezone (so DST and
     * half-hour offsets are handled by the production code, not by the test).
     */
    advanceToLocal(hhmm) {
      const parts = clock.parts(timezone);
      const target = require('../utils/time').zonedTimeToUtc(parts.isoDate, hhmm, timezone);
      clock.setOffsetMinutes((target.getTime() - Date.now()) / 60000);
      return clock.parts(timezone);
    },

    /** Jumps to an exact local date and wall-clock time. */
    goTo(date, hhmm) {
      const target = require('../utils/time').zonedTimeToUtc(date, hhmm || '20:00', timezone);
      clock.setOffsetMinutes((target.getTime() - Date.now()) / 60000);
      return clock.parts(timezone);
    },

    /**
     * Rolls the simulated clock to just after the next daily reset, `extraMinutes`
     * past it. Always positioned relative to the current simulated day so tests
     * do not have to do minute arithmetic by hand.
     */
    advanceToNextDay(extraMinutes = 1) {
      const parts = clock.parts(timezone);
      const nextDay = require('../utils/time').shiftIsoDate(parts.isoDate, 1);
      const runtime = require('../services/settingsService').getRuntimeSettings(db);
      const target = require('../utils/time').zonedTimeToUtc(nextDay, runtime.dailyReset, timezone);
      clock.setOffsetMinutes((target.getTime() - Date.now()) / 60000 + Number(extraMinutes || 0));
      return clock.parts(timezone);
    },

    setOffsetMinutes(minutes) {
      clock.setOffsetMinutes(minutes);
    },

    async request(method, url, body, headers = {}) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = { parseError: true, raw: text };
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },

    get(url) {
      return context.request('GET', url);
    },
    post(url, body) {
      return context.request('POST', url, body);
    },
    put(url, body) {
      return context.request('PUT', url, body);
    },
    patch(url, body) {
      return context.request('PATCH', url, body);
    },
    del(url) {
      return context.request('DELETE', url);
    },

    /** Direct repository access for assertions about persisted rows. */
    count(table) {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },

    /** Re-opens the same database file with a brand new connection. */
    reopen() {
      return openDatabase(dbFile);
    },

    async close() {
      scheduler.stop();
      await new Promise((resolve) => server.close(resolve));
      try {
        db.close();
      } catch (err) {
        /* already closed */
      }
    },

    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        /* best effort */
      }
    },
  };

  return context;
}

/**
 * Boots a second instance against an existing context's database file, which is
 * how a server restart is simulated. Returns an object with the same request
 * helpers as a context, plus its own db/clock/scheduler.
 */
async function restartContext(ctx, { frontendDir = null } = {}) {
  const { db } = openDatabase(ctx.dbFile);
  const clock = new Clock(db);
  clock.setOffsetMinutes(ctx.clock.offsetMinutes);

  const deps = { db, clock, frontendDir };
  const scheduler = startScheduler(deps, { intervalMs: 60000 });
  deps.scheduler = scheduler;
  const app = createApp(deps);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  return {
    db,
    clock,
    baseUrl,
    scheduler,
    async request(method, url, body) {
      const res = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (err) {
        json = { parseError: true, raw: text };
      }
      return { status: res.status, body: json, text, headers: res.headers };
    },
    get(url) {
      return this.request('GET', url);
    },
    post(url, body) {
      return this.request('POST', url, body);
    },
    put(url, body) {
      return this.request('PUT', url, body);
    },
    count(table) {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },
    async close() {
      scheduler.stop();
      await new Promise((resolve) => server.close(resolve));
      try {
        db.close();
      } catch (err) {
        /* already closed */
      }
    },
  };
}

/** Runs a test body, guaranteeing teardown and reporting unexpected throws. */
async function test(name, fn) {
  const before = state.failed;
  try {
    await fn();
  } catch (err) {
    state.failed += 1;
    console.error(`  ✗ ${name} threw: ${err && err.stack ? err.stack : err}`);
  }
  return state.failed === before;
}

async function runFiles(files, { filter = null } = {}) {
  for (const file of files) {
    const label = path.basename(file);
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(file);
    const tests = typeof mod === 'function' ? mod() : mod;
    const names = Object.keys(tests).filter((name) => !filter || name.toLowerCase().includes(filter));
    if (names.length === 0) continue;
    console.log(`\n${label}`);
    state.files.push(label);
    for (const name of names) {
      await test(name, tests[name]);
    }
  }

  console.log('\n──────────────────────────────────────────────');
  console.log(`assertions passed: ${state.passed}`);
  console.log(`assertions failed: ${state.failed}`);
  console.log('──────────────────────────────────────────────');
  return state.failed === 0 ? 0 : 1;
}

module.exports = {
  test,
  createContext,
  restartContext,
  assertTrue,
  assertEqual,
  assertNotEqual,
  assertIncludes,
  assertNotIncludes,
  assertMatch,
  assertThrows,
  runFiles,
  state,
  assertions,
};
