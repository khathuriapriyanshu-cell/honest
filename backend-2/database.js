/**
 * HONEST Backend 2 (KBAI) - Database Initialization & Connection
 * 
 * Powered by Node.js native SQLite (node:sqlite DatabaseSync)
 * Provides persistent SQLite storage with zero external binary build dependencies.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = path.join(__dirname, 'honest.db');
let dbInstance = null;

function getDatabase() {
  if (dbInstance) return dbInstance;

  dbInstance = new DatabaseSync(DB_PATH);
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  
  initializeSchema(dbInstance);
  return dbInstance;
}

function initializeSchema(db) {
  // Settings Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Tasks Table (Promises)
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      repeat_type TEXT NOT NULL, -- 'once', 'daily', 'selected'
      selected_days TEXT,        -- JSON array e.g. '[1,2,3,4,5]'
      reminder_time TEXT,        -- 'HH:MM' or null
      accountability_time TEXT NOT NULL DEFAULT '22:30',
      minimum_completion_definition TEXT NOT NULL,
      created_date TEXT NOT NULL, -- 'YYYY-MM-DD'
      created_at TEXT NOT NULL,   -- ISO timestamp
      is_active INTEGER NOT NULL DEFAULT 1
    );
  `);

  // Task Daily Completions
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_completions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      date TEXT NOT NULL,        -- 'YYYY-MM-DD'
      completed INTEGER NOT NULL DEFAULT 1,
      completed_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, date)
    );
  `);

  // Reflections Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,        -- 'YYYY-MM-DD'
      task_name TEXT,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Off Days Table
  db.exec(`
    CREATE TABLE IF NOT EXISTS off_days (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL UNIQUE, -- 'YYYY-MM-DD'
      reason TEXT NOT NULL,
      declared_at TEXT NOT NULL
    );
  `);

  // Seed default settings if not already present
  const defaultSettings = {
    accountabilityTime: '22:30',
    dailyReset: '00:00',
    gracePeriod: '15',
    weekStart: 'monday',
    notifications: 'true',
    theme: 'dark',
    timezone: 'automatic'
  };

  const checkStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const insertStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');

  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = checkStmt.get(key);
    if (!existing) {
      insertStmt.run(key, value);
    }
  }
}

module.exports = {
  getDatabase,
  DB_PATH
};
