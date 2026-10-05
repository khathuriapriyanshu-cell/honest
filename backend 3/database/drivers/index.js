'use strict';

const { resolveDatabaseTarget } = require('../../config/env');

/**
 * Database driver registry.
 *
 * Two drivers speak exactly the same synchronous API (the subset of
 * `node:sqlite` this backend uses):
 *
 *   local   the built-in `node:sqlite` module - the default, no dependency
 *   libsql  Turso / libSQL over HTTP (see drivers/libsql.js)
 *
 * Everything downstream of `openDatabase()` is identical for both, which is why
 * the REST API, the scheduler and the whole test suite are unchanged.
 */

const LOCAL = 'local';
const LIBSQL = 'libsql';

/**
 * Decides which driver a target needs.
 *
 * A URL (libsql://, https://, wss://) selects the remote driver. Everything
 * else - a path, `:memory:`, or nothing at all - selects the built-in driver.
 */
function driverFor(target) {
  if (!target) return LOCAL;
  if (target.kind === 'remote') return LIBSQL;
  if (typeof target.filename === 'string' && /^(libsql|https?|wss?):\/\//i.test(target.filename)) return LIBSQL;
  return LOCAL;
}

function describe(driver) {
  return driver === LIBSQL ? 'libSQL / Turso (HTTP)' : 'node:sqlite (built-in)';
}

/**
 * Opens a database and returns `{ DatabaseSync, driver, target, banner }`.
 *
 * @param {object} options
 *   target  an already resolved target (see config/env.resolveDatabaseTarget)
 *   url     explicit libSQL URL (overrides the target)
 *   authToken explicit libSQL token
 *   filename explicit local file (overrides the target)
 *   driver  'auto' (default) | 'local' | 'libsql'
 */
function createDatabase(options = {}) {
  let target = options.target || null;

  if (options.url) {
    target = { kind: 'remote', url: options.url, authToken: options.authToken || null, label: `remote libSQL (${options.url})` };
  } else if (options.filename) {
    target = { kind: 'local', filename: options.filename, label: `local file (${options.filename})`, ephemeral: false };
  } else if (!target) {
    target = resolveDatabaseTarget();
  }

  const requested = options.driver || 'auto';
  const driver = requested === 'auto' ? driverFor(target) : requested;

  if (driver === LIBSQL) {
    const { LibsqlDatabaseSync } = require('./libsql');
    return {
      DatabaseSync: LibsqlDatabaseSync,
      driver,
      target,
      description: describe(driver),
    };
  }

  const { DatabaseSync } = require('node:sqlite');
  return {
    DatabaseSync,
    driver,
    target,
    description: describe(driver),
  };
}

module.exports = { createDatabase, driverFor, describe, LOCAL, LIBSQL };
