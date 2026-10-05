'use strict';

/**
 * HONEST - SQLite schema.
 *
 * Design notes
 * ------------
 * tasks              The promise itself: what was promised, how often, how
 *                    strictly, and when accountability happens. Historical
 *                    occurrences reference the task, and the task row carries
 *                    a `snapshot` of its own content at the time it was last
 *                    edited so that history is never silently rewritten.
 * task_occurrences   One row per (promise, calendar date) that has actually
 *                    been touched: completed, reflected on, or explicitly
 *                    waived. This is what makes history durable when a
 *                    recurring promise is later edited or deactivated.
 * reflections        The honest reason. One row per (promise, date) at most.
 * off_days           A day the user declared off, with the reason and the
 *                    instant it was activated (the retroactive-activation rule
 *                    is enforced against that instant).
 * notification_log   Backend-scheduled accountability events. `dedupe_key`
 *                    guarantees each event fires exactly once per day, which is
 *                    what makes the scheduler restart-safe.
 * settings           Single-user key/value configuration.
 * meta               Schema version and the persisted clock offset (testing).
 */

const SCHEMA_VERSION = 3;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  name                        TEXT    NOT NULL,
  category                    TEXT    NOT NULL DEFAULT 'General',
  repeat_type                 TEXT    NOT NULL DEFAULT 'daily'
                              CHECK (repeat_type IN ('once','daily','selected')),
  repeat_days                 TEXT    NOT NULL DEFAULT '[]',   -- JSON array of ISO weekdays 1..7
  reminder                    TEXT,                            -- "HH:MM" or NULL
  accountability_time         TEXT,                            -- "HH:MM" or NULL -> falls back to settings
  minimum_completion          TEXT,                            -- human sentence, e.g. "At least 45 minutes"
  minimum_completion_spec     TEXT,                            -- reserved structured form (JSON) for later use
  start_date                  TEXT    NOT NULL,                -- ISO date the promise becomes visible
  end_date                    TEXT,                            -- ISO date of last occurrence (one-time tasks)
  created_at                  TEXT    NOT NULL,
  updated_at                  TEXT    NOT NULL,
  status                      TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','inactive')),
  completed_at                TEXT,                            -- set once for 'once' tasks when done
  snapshot                    TEXT,                            -- JSON of task content captured at completion time
  inactive_from               TEXT,                            -- ISO date recurrence stops (history is untouched)
  source                      TEXT    NOT NULL DEFAULT 'user'
);

CREATE INDEX IF NOT EXISTS idx_tasks_status_start ON tasks (status, start_date);
CREATE INDEX IF NOT EXISTS idx_tasks_repeat ON tasks (repeat_type);

CREATE TABLE IF NOT EXISTS task_occurrences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  date          TEXT    NOT NULL,                              -- ISO date in the user's timezone
  status        TEXT    NOT NULL CHECK (status IN ('completed','missed_explained','missed_unexplained')),
  completed     INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  reflected     INTEGER NOT NULL DEFAULT 0 CHECK (reflected IN (0,1)),
  waive_reason  TEXT,                                          -- set when a day was off / promise waived
  task_name     TEXT,                                          -- promise name frozen at answer time
  task_definition TEXT,                                        -- minimum completion frozen at answer time
  task_category TEXT,                                          -- category frozen at answer time
  completed_at  TEXT,
  reflected_at  TEXT,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  UNIQUE (task_id, date)
);

CREATE INDEX IF NOT EXISTS idx_occurrences_date ON task_occurrences (date);
CREATE INDEX IF NOT EXISTS idx_occurrences_task_date ON task_occurrences (task_id, date);
CREATE INDEX IF NOT EXISTS idx_occurrences_status ON task_occurrences (status);

CREATE TABLE IF NOT EXISTS reflections (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurrence_id INTEGER REFERENCES task_occurrences(id) ON DELETE SET NULL,
  task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  date          TEXT    NOT NULL,                              -- relevant date
  task_name     TEXT    NOT NULL,                              -- snapshot of the promise name
  reason        TEXT    NOT NULL,
  source        TEXT    NOT NULL DEFAULT 'night_check',        -- night_check | midnight | carry_over | manual
  created_at    TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reflections_date ON reflections (date);
CREATE INDEX IF NOT EXISTS idx_reflections_task ON reflections (task_id);

CREATE TABLE IF NOT EXISTS off_days (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT    NOT NULL UNIQUE,
  reason          TEXT    NOT NULL,
  activated_at    TEXT    NOT NULL,                            -- instant of activation (UTC ISO)
  deadline_at     TEXT    NOT NULL,                            -- instant after which activation is impossible
  status          TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  revoked_at      TEXT,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_off_days_date ON off_days (date);

CREATE TABLE IF NOT EXISTS notification_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  dedupe_key    TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL,
  date          TEXT,
  message       TEXT    NOT NULL,
  payload       TEXT,
  fired_at      TEXT    NOT NULL,
  acknowledged  INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0,1)),
  acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notifications_fired ON notification_log (fired_at);
CREATE INDEX IF NOT EXISTS idx_notifications_ack ON notification_log (acknowledged, fired_at);
`;

module.exports = { SCHEMA_SQL, SCHEMA_VERSION };
