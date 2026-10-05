'use strict';

/**
 * Tiny repository helpers shared by every service.
 *
 * Keeping prepared statements and the run/get/all passthroughs in one place
 * makes it obvious that *all* SQL in this project is parameterised - no string
 * concatenation of user input ever happens in the service or route layer.
 */

function all(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function get(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function run(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** Runs `fn` inside a SQLite transaction, rolling back on any throw. */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackErr) {
      // The original error is more useful than a failed rollback.
    }
    throw err;
  }
}

/** Better-sqlite3 style `RETURNING` is available in SQLite 3.35+ (Node 22+ ships far newer). */
function insertReturning(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

module.exports = { all, get, run, transaction, insertReturning };
