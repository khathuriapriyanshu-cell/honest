'use strict';

/**
 * SQLite schema + default settings.
 *
 * Design notes:
 * - `tasks` holds the current definition of a promise (name, category,
 *   reminder, per-task accountability time, minimum completion definition).
 * - `task_schedules` holds the repeat RULES over time. Every definition change
 *   closes the current row and opens a new one, so "which tasks belonged to a
 *   date" is answered from history, and later edits never rewrite the past.
 * - `completions` is one row per (task, date): the persistent, historical
 *   completion record.
 * - `reflections` stores honest reasons; `task_id` NULL = day-level note.
 * - `off_days` marks an excused day (never retroactive after its deadline).
 * - `events` is a durable audit trail of accountability phase transitions,
 *   deduplicated per (type, date).
 */

const DEFAULT_SETTINGS = {
  timezone: 'auto',
  daily_reset_time: '00:00',
  accountability_time: '22:30',
  grace_period_minutes: '15',
  notifications_enabled: 'true',
  week_starts: 'monday',
  theme: 'dark',
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  name                     TEXT    NOT NULL,
  category                 TEXT    NOT NULL DEFAULT 'general',
  repeat_type              TEXT    NOT NULL CHECK (repeat_type IN ('one_time','daily','selected_days')),
  selected_days            TEXT,
  reminder_time            TEXT,
  accountability_time      TEXT,
  minimum_completion_text  TEXT,
  minimum_completion_value REAL,
  minimum_completion_unit  TEXT,
  is_active                INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(is_active);

CREATE TABLE IF NOT EXISTS task_schedules (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repeat_type   TEXT    NOT NULL CHECK (repeat_type IN ('one_time','daily','selected_days')),
  selected_days TEXT,
  start_date    TEXT    NOT NULL,
  end_date      TEXT,
  created_at    TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_task ON task_schedules(task_id);
CREATE INDEX IF NOT EXISTS idx_schedules_start ON task_schedules(start_date);

CREATE TABLE IF NOT EXISTS completions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,
  minutes_spent INTEGER,
  note          TEXT,
  completed_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_completions_task_date ON completions(task_id, date);
CREATE INDEX IF NOT EXISTS idx_completions_date ON completions(date);

CREATE TABLE IF NOT EXISTS reflections (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  reason     TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reflections_date ON reflections(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reflections_task_date
  ON reflections(date, task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_reflections_day
  ON reflections(date) WHERE task_id IS NULL;

CREATE TABLE IF NOT EXISTS off_days (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL UNIQUE,
  reason       TEXT NOT NULL,
  note         TEXT,
  activated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  for_date   TEXT NOT NULL,
  payload    TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_type_date ON events(type, for_date);
`;

function initializeSchema(db) {
  db.exec(SCHEMA_SQL);
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', key, value);
  }
}

module.exports = { initializeSchema, DEFAULT_SETTINGS };
