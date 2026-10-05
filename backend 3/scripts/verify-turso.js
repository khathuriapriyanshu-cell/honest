'use strict';

/**
 * Verifies the remote (Turso / libSQL) database path end to end, without a
 * Turso account and without any external network access.
 *
 *   node scripts/verify-turso.js
 *
 * `scripts/fake-turso-server.js` runs in its own process and speaks the Hrana v2
 * pipeline protocol - the same protocol Turso uses. Pointing the backend at it
 * exercises the entire chain: driver selection, the synchronous helper process,
 * the JSON protocol between parent and helper, Hrana encoding/decoding,
 * statement batching, connected pragmas, error handling and clean shutdown.
 *
 * Only Turso's own network and authentication remain untested by this script;
 * the protocol handling they depend on is covered here and in the test suite.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPort(portFile, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const value = Number(fs.readFileSync(portFile, 'utf8').trim());
      if (Number.isInteger(value) && value > 0) return value;
    }
    await sleep(50);
  }
  throw new Error('the fake Turso server did not report a port in time');
}

function readLog(logFile) {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-turso-'));
  const portFile = path.join(dir, 'port');
  const logFile = path.join(dir, 'requests.jsonl');

  const server = spawn(
    process.execPath,
    [path.join(ROOT, 'scripts', 'fake-turso-server.js'), '--port', '0', '--port-file', portFile, '--log-file', logFile],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));

  let failures = 0;
  const check = (label, ok, detail = '') => {
    if (!ok) failures += 1;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`);
  };

  try {
    const port = await readPort(portFile);
    const url = `http://127.0.0.1:${port}`;
    console.log(`\nRemote database endpoint: ${url}\n`);

    const { openDatabase } = require('../database/db');
    const opened = openDatabase({ url, authToken: 'test-token' });

    check('the libSQL driver is selected for a remote URL', opened.driver === 'libsql', opened.driver);
    check('the schema was created through the remote endpoint', readLog(logFile).length > 0);
    check('the schema version was read back', opened.migration.to >= 3, String(opened.migration.to));

    const { db } = opened;

    const inserted = db
      .prepare(
        `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('Remote promise', 'Study', 'daily', '[]', '2026-10-05', 'x', 'x', 'active');
    check('a write reports its row id', Number(inserted.lastInsertRowid) === 1, String(inserted.lastInsertRowid));
    check('a write reports its change count', inserted.changes === 1, String(inserted.changes));

    const rows = db.prepare('SELECT id, name FROM tasks').all();
    check(
      'a read returns the row that was written',
      rows.length === 1 && rows[0].name === 'Remote promise',
      JSON.stringify(rows)
    );

    const settings = db.prepare('SELECT key, value FROM settings').all();
    check('the seeded settings round-tripped', settings.length >= 6, `${settings.length} rows`);

    // Batching: several statements issued together travel as one HTTP request.
    const before = readLog(logFile).length;
    db.exec('CREATE INDEX IF NOT EXISTS idx_x ON tasks (id); CREATE INDEX IF NOT EXISTS idx_y ON tasks (name);');
    const after = readLog(logFile).length;
    check('multiple statements travel in one pipeline request', after - before === 1, `${after - before} request(s)`);

    // Connected pragmas are answered client-side.
    const pragmaBefore = readLog(logFile).length;
    db.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    check('connection pragmas never reach the network', readLog(logFile).length === pragmaBefore);

    // Arguments are transported as typed Hrana values, quoted in SQL, never interpolated raw.
    const injection = db
      .prepare('INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run("Robert'); DROP TABLE tasks; --", 'Study', 'daily', '[]', '2026-10-05', 'x', 'x', 'active');
    check('a hostile value is stored, not executed', injection.changes === 1);
    const stored = db.prepare('SELECT id, name FROM tasks').all();
    check('the hostile value round-tripped verbatim', stored.some((r) => r.name === "Robert'); DROP TABLE tasks; --"));

    const log = readLog(logFile);
    check(
      'the auth token was sent as a bearer header on every request',
      log.every((entry) => entry.authorization === 'Bearer test-token'),
      log[0] && String(log[0].authorization)
    );
    check('the Hrana pipeline endpoint was used', log.every((entry) => entry.url === '/v2/pipeline'), log[0] && log[0].url);
    // Values are delivered as quoted SQL literals with doubled quotes, never as
    // raw interpolated text - which is exactly how a hostile value stays data.
    const allStatements = log.flatMap((entry) => entry.statements);
    check(
      'bound values were inlined as quoted literals',
      allStatements.some((statement) => /VALUES \('Remote promise'/.test(statement)),
      'expected an inlined, quoted value'
    );
    check(
      'a hostile value was escaped, not executed',
      allStatements.some((statement) => statement.includes("'Robert''); DROP TABLE tasks; --'")),
      'expected doubled quotes around the hostile value'
    );

    db.close();

    // A closed connection must refuse further work rather than silently drop it.
    let closedThrew = false;
    try {
      db.prepare('SELECT 1 AS ok').get();
    } catch (err) {
      closedThrew = true;
    }
    check('a closed remote connection refuses further statements', closedThrew);

    // An unreachable host must fail loudly with a useful message.
    let threw = false;
    let message = '';
    try {
      const unreachable = openDatabase({ url: 'http://127.0.0.1:1', authToken: 'nope' });
      unreachable.db.prepare('SELECT 1 AS ok').get();
    } catch (err) {
      threw = true;
      message = err.message;
    }
    check('an unreachable remote database fails loudly', threw, 'no error was raised');
    check(
      'the failure message is actionable',
      /helper|refused|unreachable|ECONNREFUSED|fetch|timed out/i.test(message),
      message.slice(0, 160)
    );

    if (process.env.HONEST_VERBOSE === '1') {
      console.log('\nStatements that reached the remote endpoint:');
      for (const entry of log) {
        for (const statement of entry.statements) console.log(`  ${statement}`);
      }
    }
  } finally {
    server.kill('SIGTERM');
    await sleep(200);
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      /* temp cleanup is best effort */
    }
  }

  console.log(`\n${failures === 0 ? 'REMOTE (TURSO / libSQL) PATH VERIFIED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('verification crashed:', err);
  process.exitCode = 1;
});
