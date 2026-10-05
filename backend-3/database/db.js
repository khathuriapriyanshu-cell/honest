'use strict';

const { SCHEMA_SQL, SCHEMA_VERSION } = require('./schema');
const { createDatabase } = require('./drivers');
const { ensureDirectory } = require('../config/env');
const path = require('node:path');

/**
 * Database connection.
 *
 * Uses Node's built-in SQLite driver (`node:sqlite`, available since Node 22.5)
 * so the backend has no native build step. The database file is created
 * automatically on first run, the schema is applied idempotently on every
 * start, and the file lives on disk so all state survives restarts.
 *
 * Enable verbose SQL logging with HONEST_SQL_LOG=1 (useful while debugging).
 */

const DEFAULT_SETTINGS = {
  accountabilityTime: '22:30',
  dailyReset: '00:00',
  gracePeriod: 15, // minutes
  notifications: true, // stored as "true"/"false"
  weekStart: 'monday',
  theme: 'dark',
  timezone: 'auto',
  offDayCutoff: null, // "HH:MM" or null -> defaults to the daily reset time
};

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
}

function migrate(db) {
  // The version table must exist before it can be read. Creating it through the
  // full (idempotent) schema script also initialises a brand new database.
  db.exec(SCHEMA_SQL);

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const current = row ? Number(row.value) : 0;

  if (current >= SCHEMA_VERSION && current > 0) {
    return { from: current, to: current, applied: false };
  }

  const hasColumn = (table, column) => {
    try {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    } catch (err) {
      return false;
    }
  };

  // v2 -> v3: structured minimum-completion support and waive reasons.
  if (!hasColumn('tasks', 'minimum_completion_spec')) {
    db.exec('ALTER TABLE tasks ADD COLUMN minimum_completion_spec TEXT;');
  }
  if (!hasColumn('task_occurrences', 'waive_reason')) {
    db.exec('ALTER TABLE task_occurrences ADD COLUMN waive_reason TEXT;');
  }
  if (!hasColumn('tasks', 'snapshot')) {
    db.exec('ALTER TABLE tasks ADD COLUMN snapshot TEXT;');
  }
  if (!hasColumn('tasks', 'inactive_from')) {
    db.exec('ALTER TABLE tasks ADD COLUMN inactive_from TEXT;');
  }
  if (!hasColumn('off_days', 'updated_at')) {
    db.exec('ALTER TABLE off_days ADD COLUMN updated_at TEXT;');
  }
  // v3: freeze the promise content that a past day actually answered, so editing
  // a recurring promise later can never rewrite its history.
  for (const column of ['task_name', 'task_definition', 'task_category']) {
    if (!hasColumn('task_occurrences', column)) {
      db.exec(`ALTER TABLE task_occurrences ADD COLUMN ${column} TEXT;`);
    }
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(SCHEMA_VERSION));

  return { from: current, to: SCHEMA_VERSION, applied: true };
}

function seedSettings(db) {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    insert.run(key, value === null ? '' : String(value));
  }
}

/**
 * Opens (creating if necessary) the HONEST database.
 *
 * @param {string|object} target
 *   A filename (`:memory:` for tests), or an options object:
 *     { filename, url, authToken, driver, label }
 *   With no argument the environment decides (TURSO_DATABASE_URL, HONEST_DB,
 *   or the default project path). See config/env.js.
 * @returns {{ db, migration, filename, driver, target, label }}
 */
function openDatabase(target) {
  const options =
    target === undefined || target === null
      ? {}
      : typeof target === 'string'
        ? { filename: target }
        : target;

  let registration;
  try {
    registration = createDatabase(options);
  } catch (err) {
    throw new Error(
      'This backend requires the built-in node:sqlite module (Node.js 22.5+) for local databases. ' +
        'Upgrade Node.js, or configure a remote database with TURSO_DATABASE_URL. Original error: ' +
        err.message
    );
  }

  const { DatabaseSync, driver, target: resolved } = registration;
  const location = options.url || (resolved && resolved.kind === 'remote' ? resolved.url : null) ||
    options.filename || (resolved && resolved.filename) || ':memory:';

  // The database directory is created on demand, so a deployment only needs the
  // path to be writable - not pre-existing.
  if (driver !== 'libsql' && location !== ':memory:') {
    ensureDirectory(path.dirname(path.resolve(location)));
  }

  const db = driver === 'libsql'
    ? new DatabaseSync({ url: location, authToken: options.authToken || (resolved && resolved.authToken) })
    : new DatabaseSync(location);

  // Connection pragmas are meaningful for a local file only.
  if (driver !== 'libsql') applyPragmas(db);

  const migration = migrate(db);
  seedSettings(db);

  if (process.env.HONEST_SQL_LOG === '1') {
    const original = db.prepare.bind(db);
    db.prepare = (sql) => {
      console.log('[sql]', sql.replace(/\s+/g, ' ').trim());
      return original(sql);
    };
  }

  return {
    db,
    migration,
    filename: location,
    driver,
    description: registration.description,
    target: resolved,
  };
}

module.exports = { openDatabase, DEFAULT_SETTINGS, SCHEMA_VERSION };
