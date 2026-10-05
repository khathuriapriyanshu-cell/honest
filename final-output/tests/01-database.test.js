'use strict';

/**
 * Database layer: automatic creation, schema, migrations, integrity, and the
 * promise that state survives a restart.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDatabase, DEFAULT_SETTINGS, SCHEMA_VERSION } = require('../database/db');
const { DatabaseSync } = require('node:sqlite');

const { assertTrue, assertEqual, assertIncludes, assertNotEqual } = require('./helpers');

function tempFile(name = 'db-test') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-db-'));
  return { dir, file: path.join(dir, `${name}.db`) };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = function databaseTests() {
  return {
    'creates the database file and every table automatically': () => {
      const { dir, file } = tempFile();
      try {
        assertEqual(fs.existsSync(file), false, 'the database file should not exist before open');
        const { db, migration } = openDatabase(file);
        assertEqual(fs.existsSync(file), true, 'opening the database should create the file');
        assertEqual(migration.applied, true, 'a fresh database should be migrated');
        assertEqual(migration.to, SCHEMA_VERSION, 'a fresh database should be at the current schema version');

        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all()
          .map((r) => r.name);
        for (const expected of [
          'meta',
          'settings',
          'tasks',
          'task_occurrences',
          'reflections',
          'off_days',
          'notification_log',
        ]) {
          assertIncludes(tables, expected, `table "${expected}" should be created`);
        }
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'seeds default settings (22:30 accountability, 15 minute grace, midnight reset)': () => {
      const { dir, file } = tempFile();
      try {
        const { db } = openDatabase(file);
        const rows = db.prepare('SELECT key, value FROM settings').all();
        const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
        assertEqual(map.accountabilityTime, DEFAULT_SETTINGS.accountabilityTime, 'default accountability time');
        assertEqual(map.accountabilityTime, '22:30', 'accountability default is 22:30');
        assertEqual(map.gracePeriod, '15', 'default grace period is 15 minutes');
        assertEqual(map.dailyReset, '00:00', 'default daily reset is midnight');
        assertEqual(map.timezone, 'auto', 'default timezone is automatic');
        assertEqual(map.notifications, 'true', 'notifications default to on');
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'enforces foreign keys between occurrences and promises': () => {
      const { dir, file } = tempFile();
      try {
        const { db } = openDatabase(file);
        let threw = false;
        try {
          db.prepare(
            `INSERT INTO task_occurrences (task_id, date, status, created_at, updated_at)
             VALUES (99999, '2026-01-01', 'completed', 'now', 'now')`
          ).run();
        } catch (err) {
          threw = true;
        }
        assertTrue(threw, 'an occurrence referencing a missing promise must be rejected');
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'rejects a duplicate occurrence for the same promise and date': () => {
      const { dir, file } = tempFile();
      try {
        const { db } = openDatabase(file);
        db.prepare(
          `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at, status)
           VALUES ('Test', 'General', 'daily', '[]', '2026-01-01', 'now', 'now', 'active')`
        ).run();
        const insert = db.prepare(
          `INSERT INTO task_occurrences (task_id, date, status, created_at, updated_at)
           VALUES (1, '2026-01-01', 'completed', 'now', 'now')`
        );
        insert.run();
        let threw = false;
        try {
          insert.run();
        } catch (err) {
          threw = true;
        }
        assertTrue(threw, 'a promise can only have one occurrence per date');
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'rejects an unknown repeat type at the database level': () => {
      const { dir, file } = tempFile();
      try {
        const { db } = openDatabase(file);
        let threw = false;
        try {
          db.prepare(
            `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at)
             VALUES ('Bad', 'General', 'hourly', '[]', '2026-01-01', 'now', 'now')`
          ).run();
        } catch (err) {
          threw = true;
        }
        assertTrue(threw, 'repeat_type is constrained to once/daily/selected');
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'migrates an older database in place without losing rows': () => {
      const { dir, file } = tempFile('legacy');
      try {
        // Simulate a v1 database: baseline tables, no newer columns.
        const legacy = new DatabaseSync(file);
        legacy.exec(`
          CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
          CREATE TABLE tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'General',
            repeat_type TEXT NOT NULL DEFAULT 'daily',
            repeat_days TEXT NOT NULL DEFAULT '[]',
            reminder TEXT,
            accountability_time TEXT,
            minimum_completion TEXT,
            start_date TEXT NOT NULL,
            end_date TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            completed_at TEXT,
            source TEXT NOT NULL DEFAULT 'user'
          );
        `);
        legacy
          .prepare(
            `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at)
             VALUES ('Existing promise', 'Study', 'daily', '[]', '2025-01-01', 'x', 'x')`
          )
          .run();
        legacy.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
        legacy.close();

        const { db, migration } = openDatabase(file);
        assertEqual(migration.applied, true, 'an outdated database should be migrated');
        assertEqual(migration.to, SCHEMA_VERSION, 'it should end up at the current version');

        const row = db.prepare('SELECT * FROM tasks WHERE id = 1').get();
        assertEqual(row.name, 'Existing promise', 'existing data must survive the migration');
        assertTrue(
          Object.prototype.hasOwnProperty.call(row, 'inactive_from'),
          'the migration should add the inactive_from column'
        );
        assertTrue(
          Object.prototype.hasOwnProperty.call(row, 'minimum_completion_spec'),
          'the migration should add the structured minimum-completion column'
        );

        const occColumns = db.prepare('PRAGMA table_info(task_occurrences)').all().map((c) => c.name);
        assertIncludes(occColumns, 'task_name', 'occurrences should gain the frozen promise name column');
        assertIncludes(occColumns, 'task_definition', 'occurrences should gain the frozen definition column');
        db.close();
      } finally {
        cleanup(dir);
      }
    },

    'is idempotent: reopening an up-to-date database does not migrate again': () => {
      const { dir, file } = tempFile();
      try {
        const first = openDatabase(file);
        first.db.close();
        const second = openDatabase(file);
        assertEqual(second.migration.applied, false, 'no migration should be needed the second time');
        assertNotEqual(second.migration.to, 0, 'the schema version should still be known');
        second.db.close();
      } finally {
        cleanup(dir);
      }
    },

    'keeps data after the connection is closed and reopened (persistence)': () => {
      const { dir, file } = tempFile('persist');
      try {
        const first = openDatabase(file);
        first.db
          .prepare(
            `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at, status)
             VALUES ('Persisted promise', 'DSA', 'daily', '[1,2]', '2026-01-01', 'now', 'now', 'active')`
          )
          .run();
        first.db
          .prepare(
            `INSERT INTO task_occurrences (task_id, date, status, completed, created_at, updated_at, task_name)
             VALUES (1, '2026-01-02', 'completed', 1, 'now', 'now', 'Persisted promise')`
          )
          .run();
        first.db
          .prepare(
            `INSERT INTO reflections (task_id, date, task_name, reason, source, created_at)
             VALUES (1, '2026-01-03', 'Persisted promise', 'Got back late from college.', 'night_check', 'now')`
          )
          .run();
        first.db.close();

        const second = openDatabase(file);
        assertEqual(second.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1, 'promise persisted');
        assertEqual(
          second.db.prepare('SELECT COUNT(*) AS n FROM task_occurrences').get().n,
          1,
          'occurrence persisted'
        );
        const reflection = second.db.prepare('SELECT * FROM reflections WHERE id = 1').get();
        assertEqual(reflection.reason, 'Got back late from college.', 'reflection persisted verbatim');
        second.db.close();
      } finally {
        cleanup(dir);
      }
    },

    'records the schema version in meta': () => {
      const { dir, file } = tempFile();
      try {
        const { db } = openDatabase(file);
        const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
        assertEqual(Number(row.value), SCHEMA_VERSION, 'the schema version should be recorded');
        db.close();
      } finally {
        cleanup(dir);
      }
    },
  };
};
