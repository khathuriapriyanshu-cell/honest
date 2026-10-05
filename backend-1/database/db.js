'use strict';

/**
 * SQLite access layer.
 *
 * Uses Node's built-in `node:sqlite` driver (Node >= 22.5) — zero native
 * dependencies. All statements are prepared with positional parameters, which
 * is the SQL-injection-safe path; user input never reaches string
 * interpolation into SQL.
 *
 * Booleans are normalized to 0/1 because node:sqlite does not bind JS booleans.
 */

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function normalizeParams(params) {
  return params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

function openDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  try {
    raw.exec('PRAGMA journal_mode = WAL;');
  } catch {
    /* WAL is a durability optimization; safe to continue without it */
  }

  return {
    raw,
    exec: (sql) => raw.exec(sql),
    run: (sql, ...params) => {
      const result = raw.prepare(sql).run(...normalizeParams(params));
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    get: (sql, ...params) => raw.prepare(sql).get(...normalizeParams(params)),
    all: (sql, ...params) => raw.prepare(sql).all(...normalizeParams(params)),
    close: () => raw.close(),
  };
}

module.exports = { openDatabase };
