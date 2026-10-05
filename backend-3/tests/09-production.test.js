'use strict';

/**
 * Production / deployment behaviour.
 *
 * Covers the things a deployment depends on and that are easy to get subtly
 * wrong: the CORS origin policy, the secured serverless scheduler endpoint, the
 * environment parsing and database target resolution, the health/readiness
 * payload, the Vercel entry point contract, and the remote libSQL protocol.
 *
 * Nothing here talks to a real Turso database: the Hrana conversation is
 * verified against the pure protocol helpers and a local stand-in for the
 * remote endpoint, so the suite stays offline and deterministic.
 */

const path = require('node:path');
const fs = require('node:fs');

const {
  createContext,
  assertTrue,
  assertEqual,
  assertIncludes,
} = require('./helpers');

const { createBootstrap } = require('../bootstrap');

const { createOriginMatcher, parseOrigin } = require('../config/cors');
const { readEnv, resolveDatabaseTarget, targetIsEphemeral } = require('../config/env');
const { driverFor, createDatabase } = require('../database/drivers');
const protocol = require('../database/drivers/libsqlProtocol');
const { authorizeCron } = require('../utils/cronAuth');
const { createServerlessScheduler } = require('../scheduler/scheduler');

/** A fake request object just rich enough for authorizeCron(). */
function fakeRequest({ header, bearer, query } = {}) {
  return {
    query: query || {},
    get(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-cron-secret') return header;
      if (key === 'authorization') return bearer;
      return undefined;
    },
  };
}

/**
 * Removes a temporary directory, tolerating Windows locking quirks.
 * A leftover temp folder must never fail a test.
 */
function removeDir(dir) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      // Windows can hold a handle briefly after a socket or file was closed.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        return true;
      } catch (retryErr) {
        /* fall through to the next attempt */
      }
    }
  }
  return false;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(require('node:os').tmpdir(), prefix));
}

module.exports = function productionTests() {
  return {
    'CORS: the default policy allows any origin': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', allowedOrigins: '*' });
      try {
        const res = await ctx.request('GET', '/api/today', undefined, { Origin: 'https://anything.example.com' });
        assertEqual(res.status, 200, 'the request is served');
        assertEqual(res.headers.get('access-control-allow-origin'), 'https://anything.example.com', 'the origin is reflected');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'CORS: an allow-list reflects only the configured origins': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        allowedOrigins: 'https://honest.vercel.app,https://*.vercel.app,capacitor://localhost,https://localhost',
      });
      try {
        const allowed = [
          'https://honest.vercel.app',
          'https://honest-git-main-user.vercel.app',
          'https://a.b.vercel.app',
          'capacitor://localhost',
          'https://localhost',
        ];
        for (const origin of allowed) {
          const res = await ctx.request('GET', '/api/today', undefined, { Origin: origin });
          assertEqual(
            res.headers.get('access-control-allow-origin'),
            origin,
            `${origin} should be allowed`
          );
        }

        const denied = [
          'https://evil.example.com',
          'https://evil-vercel.app',
          'http://localhost:5500',
          'https://honest.vercel.app.evil.com',
        ];
        for (const origin of denied) {
          const res = await ctx.request('GET', '/api/today', undefined, { Origin: origin });
          assertEqual(res.headers.get('access-control-allow-origin'), null, `${origin} should not be allowed`);
        }
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'CORS: requests without an Origin header are always served': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        allowedOrigins: 'https://honest.vercel.app',
      });
      try {
        // Native Android clients and uptime monitors send no Origin.
        const res = await ctx.get('/api/health');
        assertEqual(res.status, 200, 'the request succeeds');
        assertEqual(res.headers.get('access-control-allow-origin'), null, 'and simply carries no CORS header');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'CORS: preflight advertises the cron header too': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', allowedOrigins: '*' });
      try {
        const preflight = await ctx.request('OPTIONS', '/api/cron/tick', undefined, {
          Origin: 'https://honest.vercel.app',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,x-cron-secret',
        });
        assertTrue(preflight.status === 204 || preflight.status === 200, 'the preflight is accepted');
        assertIncludes(preflight.headers.get('access-control-allow-methods') || '', 'POST', 'POST is advertised');
        const headers = (preflight.headers.get('access-control-allow-headers') || '').toLowerCase();
        assertIncludes(headers, 'x-cron-secret', 'the cron header is advertised');
        assertIncludes(headers, 'authorization', 'and the bearer token header');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'origin matching handles ports, wildcards and lookalike hosts': () => {
      const matcher = createOriginMatcher('https://*.vercel.app,http://localhost:*,https://localhost,capacitor://localhost');

      assertTrue(matcher.isAllowed('https://honest.vercel.app'), 'exact sub-domain');
      assertTrue(matcher.isAllowed('https://a.b.vercel.app'), 'nested sub-domain');
      assertTrue(matcher.isAllowed('http://localhost:5173'), 'any port on localhost over http');
      assertTrue(matcher.isAllowed('http://localhost:3000'), 'another port');
      assertTrue(matcher.isAllowed('http://localhost'), 'http localhost with the default port');
      assertTrue(matcher.isAllowed('https://localhost'), 'https localhost is its own pattern');
      assertTrue(matcher.isAllowed('capacitor://localhost'), 'the Capacitor scheme');

      assertEqual(matcher.isAllowed('https://vercel.app'), false, 'the bare domain is not a sub-domain');
      assertEqual(matcher.isAllowed('https://evil-vercel.app'), false, 'a lookalike host is rejected');
      assertEqual(matcher.isAllowed('https://vercel.app.evil.com'), false, 'a suffix attack is rejected');
      assertEqual(matcher.isAllowed('nonsense'), false, 'a non-origin string is rejected');
      assertEqual(matcher.isAllowed(''), false, 'an empty origin is rejected');

      // A port-scoped pattern must not authorise a different scheme.
      const httpOnly = createOriginMatcher('http://localhost:*');
      assertEqual(httpOnly.isAllowed('https://localhost:5173'), false, 'https is not covered by an http pattern');
      assertEqual(httpOnly.isAllowed('http://localhost:5173'), true, 'while http is');

      assertEqual(parseOrigin('https://localhost:5173').port, '5173', 'the port is parsed');
      assertEqual(parseOrigin('https://user:pass@honest.vercel.app').host, 'honest.vercel.app', 'userinfo is stripped');
    },

    'cron endpoint: refuses a wrong or missing secret and accepts the right one': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:31',
        cronSecret: 'super-secret-value',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });

        const missing = await ctx.get('/api/cron/tick');
        assertEqual(missing.status, 401, 'a missing secret is rejected');
        assertEqual(missing.body.success, false, 'with a failure envelope');
        assertEqual(missing.body.error.code, 'CRON_UNAUTHORIZED', 'and a specific code');
        assertEqual(ctx.count('notification_log'), 0, 'and nothing ran');

        const wrong = await ctx.get('/api/cron/tick', undefined, { 'x-cron-secret': 'nope' });
        assertEqual(wrong.status, 401, 'a wrong secret is rejected');

        const viaHeader = await ctx.request('GET', '/api/cron/tick', undefined, { 'x-cron-secret': 'super-secret-value' });
        assertEqual(viaHeader.status, 200, 'the header form is accepted');
        assertEqual(viaHeader.body.authorized.required, true, 'and reports that a secret was required');
        assertEqual(viaHeader.body.authorized.via, 'header', 'naming the mechanism used');

        const viaBearer = await ctx.request('GET', '/api/cron/tick', undefined, {
          Authorization: 'Bearer super-secret-value',
        });
        assertEqual(viaBearer.status, 200, 'the bearer form is accepted');
        assertEqual(viaBearer.body.authorized.via, 'bearer', 'and detected as bearer');

        const viaQuery = await ctx.get('/api/cron/tick?secret=super-secret-value');
        assertEqual(viaQuery.status, 200, 'the query form is accepted');
        assertEqual(viaQuery.body.authorized.via, 'query', 'and detected as query');

        const viaPost = await ctx.post('/api/cron/tick?secret=super-secret-value');
        assertEqual(viaPost.status, 200, 'POST works too (GitHub Actions style)');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'cron endpoint: runs the scheduler, is idempotent, and reports an honest audit': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:31',
        cronSecret: 'tick-secret',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });

        const first = await ctx.get('/api/cron/tick?secret=tick-secret');
        assertEqual(first.status, 200, 'the tick succeeds');
        assertEqual(first.body.success, true, 'with a success envelope');
        assertEqual(first.body.events.created, 1, 'the accountability event was created');
        assertEqual(first.body.accountability.counts.unresolved, 2, 'and the audit reports the real unfinished count');
        assertIncludes(first.body.tick.serverDate, String(new Date().getUTCFullYear()), 'a server date is reported');
        assertEqual(first.body.tick.durationMs >= 0, true, 'and how long it took');
        // The test context runs a timer scheduler; on Vercel the bootstrap
        // selects 'on_demand' instead (covered by the serverless-mode test).
        assertEqual(first.body.scheduler.mode, 'timer', 'the scheduler reports which mode it is in');
        assertEqual(first.body.scheduler.ran, true, 'the scheduler recorded the run');
        assertEqual(ctx.count('notification_log'), 1, 'exactly one event row was written');

        const second = await ctx.get('/api/cron/tick?secret=tick-secret');
        assertEqual(second.body.events.created, 0, 'a second tick creates nothing new');
        assertEqual(ctx.count('notification_log'), 1, 'and does not duplicate the row');

        const issues = second.body.issues.map((issue) => issue.code);
        assertEqual(issues.includes('EPHEMERAL_DATABASE'), false, 'a writable test database is not flagged');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'cron endpoint: warns when the endpoint is not protected': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const res = await ctx.get('/api/cron/tick');
        assertEqual(res.status, 200, 'without CRON_SECRET the endpoint stays callable');
        assertEqual(res.body.authorized.required, false, 'and says so');
        const codes = res.body.issues.map((issue) => issue.code);
        assertIncludes(codes, 'CRON_SECRET_NOT_SET', 'the audit flags the missing secret');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'cron authorization helper is constant-time and explicit': () => {
      const request = fakeRequest({ header: 'abc123' });
      assertEqual(authorizeCron(request, 'abc123').allowed, true, 'the right secret is allowed');
      assertEqual(authorizeCron(request, 'abc124').allowed, false, 'a near miss is rejected');
      assertEqual(authorizeCron(request, 'abc124').reason, 'invalid_secret', 'with a reason');
      assertEqual(authorizeCron(fakeRequest(), 'abc123').reason, 'missing_secret', 'a missing secret has its own reason');
      assertEqual(authorizeCron(fakeRequest(), '').required, false, 'an empty secret means no requirement');
      assertEqual(authorizeCron(fakeRequest(), undefined).allowed, true, 'and the endpoint is open');
    },

    'environment parsing: defaults, overrides and validation': () => {
      const defaults = readEnv({});
      assertEqual(defaults.port, 3000, 'the port defaults to 3000');
      assertEqual(defaults.nodeEnv, 'development', 'the environment defaults to development');
      assertEqual(defaults.isProduction, false, 'and is not production');
      assertEqual(defaults.allowedOrigins, '*', 'CORS defaults to any origin');
      assertEqual(defaults.timezone, 'auto', 'the timezone defaults to automatic');
      assertEqual(defaults.cronSecret, null, 'no cron secret by default');
      assertEqual(defaults.schedulerIntervalMs, 30000, 'the scheduler interval defaults to 30s');
      assertEqual(defaults.schedulerDisabled, false, 'and is enabled by default');

      const configured = readEnv({
        PORT: '8080',
        NODE_ENV: 'production',
        HONEST_TIMEZONE: 'Asia/Calcutta',
        CRON_SECRET: 's3cret',
        ALLOWED_ORIGINS: 'https://a.example.com',
        HONEST_SCHEDULER_INTERVAL_MS: '5000',
        HONEST_DISABLE_SCHEDULER: '1',
      });
      assertEqual(configured.port, 8080, 'PORT is honoured');
      assertEqual(configured.isProduction, true, 'NODE_ENV is honoured');
      assertEqual(configured.timezone, 'Asia/Calcutta', 'HONEST_TIMEZONE is honoured');
      assertEqual(configured.cronSecret, 's3cret', 'CRON_SECRET is honoured');
      assertEqual(configured.allowedOrigins, 'https://a.example.com', 'ALLOWED_ORIGINS is honoured');
      assertEqual(configured.schedulerIntervalMs, 5000, 'the interval is honoured');
      assertEqual(configured.schedulerDisabled, true, 'the scheduler can be disabled');

      assertEqual(readEnv({ HONEST_TIMEZONE: 'automatic' }).timezone, 'auto', '"automatic" normalises to auto');

      let threw = false;
      try {
        readEnv({ PORT: 'not-a-port' });
      } catch (err) {
        threw = true;
        assertIncludes(err.message, 'PORT', 'the error names the variable');
      }
      assertTrue(threw, 'an invalid PORT is rejected at start-up');

      threw = false;
      try {
        readEnv({ HONEST_SCHEDULER_INTERVAL_MS: '10' });
      } catch (err) {
        threw = true;
      }
      assertTrue(threw, 'an interval that would hammer the database is rejected');
    },

    'database target resolution: remote wins, local default, safe fallback': () => {
      const remote = resolveDatabaseTarget({ TURSO_DATABASE_URL: 'libsql://honest.turso.io', TURSO_AUTH_TOKEN: 'tok' });
      assertEqual(remote.kind, 'remote', 'a Turso URL selects the remote driver');
      assertEqual(remote.authToken, 'tok', 'and carries the token');
      assertEqual(targetIsEphemeral(remote), false, 'a remote database is persistent');

      const libsqlUrl = resolveDatabaseTarget({ LIBSQL_URL: 'https://honest.turso.io' });
      assertEqual(libsqlUrl.kind, 'remote', 'the LIBSQL_URL alias works');

      const viaHonestDb = resolveDatabaseTarget({ HONEST_DB: 'libsql://honest.turso.io' });
      assertEqual(viaHonestDb.kind, 'remote', 'a URL in HONEST_DB is treated as remote');

      const local = resolveDatabaseTarget({ HONEST_DB: './data/custom.db' });
      assertEqual(local.kind, 'local', 'a path selects the local driver');
      assertIncludes(local.filename, 'custom.db', 'and is used as given');

      const memory = resolveDatabaseTarget({ HONEST_DB: ':memory:' });
      assertEqual(memory.kind, 'local', 'in-memory is local');
      assertEqual(targetIsEphemeral(memory), true, 'and is flagged as non-persistent');

      const fileUrl = resolveDatabaseTarget({ HONEST_DB: 'file:./data/fileurl.db' });
      assertEqual(fileUrl.kind, 'local', 'the file: URL form is understood');
      assertIncludes(fileUrl.filename, 'fileurl.db', 'with the path extracted');

      // No configuration at all: a default project path.
      const fallback = resolveDatabaseTarget({});
      assertEqual(fallback.kind, 'local', 'the default is a local file');
      assertIncludes(fallback.filename, 'honest.db', 'named honest.db');

      // A serverless platform with a temporary path must be reported ephemeral.
      assertEqual(
        targetIsEphemeral({ kind: 'local', filename: '/tmp/honest.db' }, { VERCEL: '1' }),
        true,
        'a temp path on a serverless platform is ephemeral'
      );
      assertEqual(
        targetIsEphemeral({ kind: 'local', filename: '/var/data/honest.db' }, { VERCEL: '1' }),
        false,
        'an explicitly configured volume path is trusted'
      );
    },

    'driver selection routes to the right implementation': () => {
      assertEqual(driverFor({ kind: 'remote', url: 'libsql://x' }), 'libsql', 'a remote target uses libSQL');
      assertEqual(driverFor({ kind: 'local', filename: './data/honest.db' }), 'local', 'a path uses node:sqlite');
      assertEqual(driverFor(null), 'local', 'no target falls back to node:sqlite');
      assertEqual(driverFor({ kind: 'local', filename: 'libsql://x' }), 'libsql', 'a URL hidden in filename is still remote');

      // createDatabase must not construct a connection, only resolve the class.
      const local = createDatabase({ filename: ':memory:' });
      assertEqual(local.driver, 'local', 'the local registration uses node:sqlite');
      assertIncludes(local.description, 'node:sqlite', 'and describes itself honestly');

      const remote = createDatabase({ url: 'libsql://example.turso.io', authToken: 'x' });
      assertEqual(remote.driver, 'libsql', 'the remote registration uses the libSQL driver');
      assertIncludes(remote.description, 'libSQL', 'and describes itself honestly');
      assertTrue(typeof remote.DatabaseSync === 'function', 'and exposes a constructor');
    },

    'libSQL protocol: encodes, decodes and quotes safely': () => {
      assertEqual(protocol.encodeArg(null).type, 'null', 'null is encoded as null');
      assertEqual(protocol.encodeArg(7).type, 'integer', 'a whole number becomes an integer');
      assertEqual(protocol.encodeArg(7).value, '7', 'as a string, per Hrana');
      assertEqual(protocol.encodeArg(1.5).type, 'float', 'a fraction becomes a float');
      assertEqual(protocol.encodeArg('2026-10-05').type, 'text', 'a string becomes text');
      assertEqual(protocol.encodeArg(true).value, '1', 'a boolean becomes 1');
      assertEqual(protocol.encodeArg(Buffer.from('hi')).type, 'blob', 'a buffer becomes a blob');
      assertEqual(protocol.decodeCell({ type: 'integer', value: '42' }), 42, 'integers decode to numbers');
      assertEqual(protocol.decodeCell({ type: 'null' }), null, 'null decodes to null');
      assertEqual(protocol.decodeCell({ type: 'float', value: '1.5' }), 1.5, 'floats decode to numbers');

      const rows = protocol.decodeRows({
        cols: [{ name: 'id' }, { name: 'title' }],
        rows: [[{ type: 'integer', value: '1' }, { type: 'text', value: 'Coding' }]],
      });
      assertEqual(rows.length, 1, 'one row decoded');
      assertEqual(rows[0].id, 1, 'with typed columns');
      assertEqual(rows[0].title, 'Coding', 'mapped by column name');

      assertEqual(protocol.quoteSqlLiteral("O'Brien"), "'O''Brien'", 'a quote in text is doubled, never a break-out');
      assertEqual(protocol.quoteSqlLiteral(null), 'NULL', 'null becomes NULL');
      assertEqual(protocol.quoteSqlLiteral(5), '5', 'numbers stay unquoted');
      assertEqual(protocol.quoteSqlLiteral("'; DROP TABLE tasks; --"), "'''; DROP TABLE tasks; --'", 'an injection attempt stays inside the literal');

      assertEqual(
        protocol.reconstructStatement('SELECT * FROM tasks WHERE id = ?', [3]),
        'SELECT * FROM tasks WHERE id = 3',
        'a positional parameter is substituted'
      );
      assertEqual(
        protocol.reconstructStatement("SELECT * FROM tasks WHERE name = ?", ["a'b"]),
        "SELECT * FROM tasks WHERE name = 'a''b'",
        'and safely quoted'
      );

      let threw = false;
      try {
        protocol.reconstructStatement('SELECT 1', [1, 2]);
      } catch (err) {
        threw = true;
      }
      assertTrue(threw, 'mismatched parameter counts are refused, not silently dropped');

      const pragma = protocol.parsePragma('PRAGMA foreign_keys = ON;');
      assertEqual(pragma.name, 'foreign_keys', 'pragmas are parsed');
      assertEqual(protocol.parsePragma('PRAGMA table_info(tasks)').name, 'table_info', 'including the query form');
    },

    'libSQL protocol: builds a batch request and parses a batch response': () => {
      const request = protocol.buildPipelineRequest(
        [
          { sql: 'SELECT 1', args: [] },
          { sql: 'INSERT INTO x (a) VALUES (?)', args: ['v'] },
        ],
        { url: 'libsql://example.turso.io', authToken: 'tok' }
      );
      assertEqual(request.url, 'libsql://example.turso.io/v2/pipeline', 'the pipeline endpoint is used');
      assertEqual(request.headers.Authorization, 'Bearer tok', 'the token travels as a bearer header');
      assertEqual(request.body.requests.length, 3, 'two statements plus the closing request');
      assertEqual(request.body.requests[1].stmt.args[0].value, 'v', 'arguments are encoded');

      const parsed = protocol.parsePipelineResponse({
        results: [
          { type: 'ok', response: { type: 'execute', result: { cols: [{ name: 'n' }], rows: [[{ type: 'integer', value: '1' }]], affected_row_count: 0 } } },
          { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [], affected_row_count: 1, last_insert_rowid: '9' } } },
          { type: 'ok', response: { type: 'close' } },
        ],
      });
      assertEqual(parsed.length, 2, 'the close response is not returned as a result');
      assertEqual(parsed[0].rows[0].n, 1, 'query rows are decoded');
      assertEqual(parsed[1].changes, 1, 'affected row counts are reported');
      assertEqual(parsed[1].lastInsertRowid, 9, 'and the inserted row id');

      let threw = false;
      try {
        protocol.parsePipelineResponse({ results: [{ type: 'error', error: { message: 'no such table: tasks', code: 'SQLITE_ERROR' } }] });
      } catch (err) {
        threw = true;
        assertIncludes(err.message, 'no such table', 'the database message is preserved');
        assertEqual(err.code, 'SQLITE_ERROR', 'and its code');
      }
      assertTrue(threw, 'a remote error is raised, never swallowed');
    },

    'libSQL driver: batches, answers pragmas locally and refuses after close': () => {
      const { LibsqlDatabaseSync, splitStatements } = require('../database/drivers/libsql');
      const db = new LibsqlDatabaseSync({ url: 'libsql://example.turso.io', authToken: 'x' });

      // Replace the executor so no network is involved. The adapter only needs
      // `run()` to return one result object per statement, which is exactly the
      // shape the helper process produces.
      const calls = [];
      const fakeRun = (statements) => {
        calls.push(statements);
        return statements.map((statement) => ({
          rows: /^\s*select/i.test(statement.sql) ? [{ ok: 1, sql: statement.sql }] : [],
          changes: /^\s*(insert|update|delete)/i.test(statement.sql) ? 1 : 0,
          lastInsertRowid: /^\s*insert/i.test(statement.sql) ? 5 : 0,
        }));
      };
      db.executor.run = fakeRun;

      const insert = db.prepare('INSERT INTO tasks (name) VALUES (?)').run('Coding');
      assertEqual(insert.changes, 1, 'a write reports its change count');
      assertEqual(insert.lastInsertRowid, 5, 'and its row id');
      assertEqual(calls.length, 1, 'one round trip for the write');
      assertIncludes(calls[0][0].sql, "'Coding'", 'the bound value was inlined safely');

      const rows = db.prepare('SELECT * FROM tasks').all();
      assertEqual(rows.length, 1, 'a read returns rows');
      assertEqual(calls.length, 2, 'and took its own round trip');

      calls.length = 0;
      db.prepare('INSERT INTO tasks (name) VALUES (?)').run('A');
      db.prepare('INSERT INTO tasks (name) VALUES (?)').run('B');
      assertEqual(calls.length, 2, 'each write is flushed so it can report its row id');

      // Connection pragmas are answered locally, even through exec().
      calls.length = 0;
      db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
      assertEqual(calls.length, 0, 'connection pragmas never reach the network');

      // The query form is a real query and must be forwarded.
      calls.length = 0;
      const pragmaQuery = db.prepare('PRAGMA table_info(tasks)').all();
      assertEqual(Array.isArray(pragmaQuery), true, 'the query form of a pragma is forwarded, not faked');
      assertEqual(calls.length, 1, 'which means it took a round trip');

      assertEqual(splitStatements('CREATE TABLE a (x); CREATE TABLE b (y);').length, 2, 'scripts are split');
      assertEqual(
        splitStatements("INSERT INTO t VALUES ('a;b');").length,
        1,
        'a semicolon inside a string is not a separator'
      );

      db.close();
      let threw = false;
      try {
        db.prepare('SELECT 1').get();
      } catch (err) {
        threw = true;
      }
      assertTrue(threw, 'using a closed remote connection is an error, not silence');
    },

    'serverless scheduler runs on demand and shares the timer behaviour': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:31',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });

        const onDemand = createServerlessScheduler({ db: ctx.db, clock: ctx.clock });
        assertEqual(onDemand.mode, 'on_demand', 'it reports its mode');
        assertEqual(onDemand.status().running, false, 'and runs no timer');
        const result = onDemand.runNow();
        assertEqual(result.ran, true, 'a manual run reports success');
        assertEqual(result.created, 1, 'and creates the due event');
        onDemand.stop();
        assertEqual(onDemand.status().running, false, 'stopping is safe');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'bootstrap opens the database lazily, only when first needed': async () => {
      const dir = makeTempDir('honest-lazy-');
      const dbFile = path.join(dir, 'lazy.db');
      try {
        const bootstrap = createBootstrap({
          env: readEnv({ HONEST_DB: dbFile, HONEST_DISABLE_SCHEDULER: '1' }),
          verbose: false,
        });

        // Importing/bootstrapping must not touch the filesystem.
        assertEqual(fs.existsSync(dbFile), false, 'the database file does not exist yet');
        assertEqual(bootstrap.status().ready, false, 'and nothing is initialised');

        // The first request opens it.
        const server = bootstrap.app.listen(0);
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const res = await fetch(`${base}/api/health`);
        const body = await res.json();
        assertEqual(res.status, 200, 'the first request is served');
        assertEqual(body.database, 'ok', 'and the database opened on demand');
        assertEqual(fs.existsSync(dbFile), true, 'creating the file at that point');
        assertEqual(bootstrap.status().ready, true, 'and the bootstrap is now ready');

        // Live serving from a lazily opened database.
        const today = await fetch(`${base}/api/today`);
        const todayBody = await today.json();
        assertEqual(today.status, 200, 'the API works');
        assertTrue(typeof todayBody.isoDate === 'string', 'and returns real data');

        await new Promise((resolve) => server.close(resolve));
        await bootstrap.stop();
      } finally {
        removeDir(dir);
      }
    },

    'health endpoints answer 200 with database status, schema version and timestamp': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        for (const route of ['/api/health', '/health']) {
          const res = await ctx.get(route);
          assertEqual(res.status, 200, `${route} answers 200`);
          assertEqual(res.body.success, true, `${route} uses the success envelope`);
          assertEqual(res.body.status, 'ok', `${route} reports ok`);
          assertEqual(res.body.database, 'ok', `${route} reports the database as reachable`);
          assertTrue(typeof res.body.schemaVersion === 'number', `${route} reports the schema version`);
          assertTrue(typeof res.body.timestamp === 'string', `${route} reports a timestamp`);
          assertTrue(!Number.isNaN(Date.parse(res.body.timestamp)), `${route} reports a parseable timestamp`);
          assertIncludes(res.body.databaseDriver, 'local', `${route} reports which driver is in use`);
          assertEqual(typeof res.body.uptimeSeconds, 'number', `${route} reports uptime`);
        }

        const admin = await ctx.get('/api');
        assertEqual(admin.body.environment, 'development', 'the endpoint index reports the environment');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'the Vercel entry point exports an Express handler without opening a database': () => {
      const entry = path.resolve(__dirname, '..', 'api', 'index.js');
      assertEqual(fs.existsSync(entry), true, 'api/index.js exists for Vercel');

      const env = require('../config/env');
      const original = { ...process.env };
      try {
        // Point the entry at a file that must not be created during import.
        const dir = makeTempDir('honest-vercel-');
        process.env.HONEST_DB = path.join(dir, 'entry.db');
        delete require.cache[entry];
        const handler = require(entry);

        assertTrue(typeof handler === 'function', 'the default export is a request handler');
        assertEqual(typeof handler.default, 'function', 'a .default export exists for ESM interop');
        assertEqual(typeof handler.handler, 'function', 'a named .handler export exists');
        assertEqual(typeof handler.use, 'function', 'and it really is an Express app');
        assertEqual(fs.existsSync(path.join(dir, 'entry.db')), false, 'importing it opens no database');

        removeDir(dir);
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
        Object.assign(process.env, original);
      }
    },

    'the serverless scheduler is selected automatically on Vercel': () => {
      const dir = makeTempDir('honest-vercel-mode-');
      try {
        const env = readEnv({
          VERCEL: '1',
          HONEST_DB: path.join(dir, 'v.db'),
        });
        assertEqual(env.serverless, true, 'the platform is detected');

        const bootstrap = createBootstrap({ env, verbose: false });
        bootstrap.ensureReady();
        assertEqual(bootstrap.state.scheduler.mode, 'on_demand', 'and no background timer is started');
        assertEqual(bootstrap.env.databaseIsEphemeral, false, 'an explicit path is respected');
      } finally {
        removeDir(dir);
      }
    },

    'documentation and deployment files ship with the backend': () => {
      const root = path.resolve(__dirname, '..');
      for (const file of ['vercel.json', '.env.example', 'api/index.js', 'bootstrap.js', 'config/env.js', 'config/cors.js']) {
        assertEqual(fs.existsSync(path.join(root, file)), true, `${file} is present`);
      }

      const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
      assertEqual(vercel.builds[0].src, 'api/index.js', 'Vercel builds the API function');
      assertEqual(vercel.routes[0].dest, 'api/index.js', 'and routes everything to it');
      assertEqual(vercel.crons[0].path, '/api/cron/tick', 'with a cron pointing at the tick endpoint');
      assertTrue(vercel.functions['api/index.js'].maxDuration >= 10, 'with a workable timeout');

      const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
      for (const topic of ['TURSO_DATABASE_URL', 'CRON_SECRET', 'ALLOWED_ORIGINS', 'Vercel', 'serverless']) {
        assertIncludes(readme, topic, `README documents ${topic}`);
      }

      const apiDoc = fs.readFileSync(path.join(root, 'API.md'), 'utf8');
      assertIncludes(apiDoc, '/api/cron/tick', 'API.md documents the cron endpoint');
      assertIncludes(apiDoc, '/health', 'API.md documents the health endpoint');
    },
  };
};
