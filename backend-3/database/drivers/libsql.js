'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const protocol = require('./libsqlProtocol');

/**
 * libSQL / Turso driver, exposed through the same synchronous API as the
 * built-in `node:sqlite` module.
 *
 * Why a child process
 * -------------------
 * Every service in this backend is written synchronously: `db.prepare(...).run()`
 * returns its result immediately. Turso is reached over HTTP, which is
 * asynchronous. Rather than rewrite the whole service layer (and every test),
 * a short-lived helper process performs the HTTP round trip and the parent reads
 * the reply with `spawnSync`.
 *
 * The cost is paid once per batch, not once per statement: all statements issued
 * between two reads are collected and sent as a single Hrana pipeline request,
 * so a whole scheduler tick or a whole matrix of writes is one round trip.
 *
 * Connection pragmas are answered locally because they are client-side
 * concerns (`journal_mode` is meaningless over HTTP). Everything that can carry
 * data - including `PRAGMA table_info(...)`, which the migrations read - is sent
 * to the database, so the adapter never fabricates a row it should have fetched.
 *
 * Constraints of this adapter:
 *   - `db.exec()` runs one statement at a time (SQL is split on `;`);
 *   - statements are dispatched together when the next read happens, so a
 *     process that dies mid-request can lose the writes of that request;
 *   - a single batch reply is capped at 8 MB.
 */

const HELPER = path.join(__dirname, 'libsqlChild.js');
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Connection-level pragmas answered without a round trip.
 * `PRAGMA name(value)` (with parentheses) is a *query* and is never answered here.
 */
const LOCAL_PRAGMAS = {
  foreign_keys: { rows: [{ foreign_keys: 1 }] },
  journal_mode: { rows: [{ journal_mode: 'memory' }] },
  synchronous: { rows: [{ synchronous: 1 }] },
  busy_timeout: { rows: [{ timeout: 5000 }] },
  defer_foreign_keys: { rows: [{ defer_foreign_keys: 0 }] },
};

/** Splits a multi-statement script into individual statements. */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inString = null;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];

    if (inString) {
      current += char;
      if (char === inString) {
        if (sql[i + 1] === inString) {
          current += sql[i + 1];
          i += 1;
        } else {
          inString = null;
        }
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      inString = char;
      current += char;
      continue;
    }

    if (char === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      current += '\n';
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }

    if (char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

class LibsqlExecutor {
  constructor({ url, authToken }) {
    if (!url) throw new Error('The libSQL driver needs a database URL.');
    this.url = url;
    this.authToken = authToken || null;
    this.closed = false;
    this.remoteStatements = 0;
  }

  /**
   * Sends statements to the helper process.
   * @returns {Array<{rows: object[], changes: number, lastInsertRowid: number|bigint}>}
   */
  run(statements) {
    if (this.closed) throw new Error('This database connection has already been closed.');
    if (statements.length === 0) return [];

    const env = {
      ...process.env,
      HONEST_LIBSQL_URL: this.url,
      HONEST_PROTOCOL_PATH: path.join(__dirname, 'libsqlProtocol.js'),
    };
    if (this.authToken) env.HONEST_LIBSQL_TOKEN = this.authToken;
    else delete env.HONEST_LIBSQL_TOKEN;

    const child = spawnSync(process.execPath, [HELPER], {
      input: JSON.stringify({ statements }),
      encoding: 'utf8',
      env,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: 20000,
    });

    if (child.error) {
      throw new Error(`Could not reach the remote database helper: ${child.error.message}`);
    }
    if (child.status !== 0 && !child.stdout) {
      throw new Error(
        `The remote database helper exited with code ${child.status}.${child.stderr ? ` ${child.stderr.trim().slice(0, 300)}` : ''}`
      );
    }

    let payload;
    try {
      payload = JSON.parse((child.stdout || '').trim());
    } catch (err) {
      throw new Error(
        `The remote database helper produced an unreadable reply: ${String(child.stdout || '').slice(0, 200)}`
      );
    }

    if (!payload.ok) {
      const error = new Error(payload.message || 'The remote database rejected the statement.');
      error.code = payload.code || 'LIBSQL_ERROR';
      throw error;
    }

    this.remoteStatements += statements.length;
    return payload.results || [];
  }

  /** Opens the connection for real, so a bad URL or token fails immediately. */
  checkConnection() {
    const env = {
      ...process.env,
      HONEST_LIBSQL_URL: this.url,
      HONEST_PROTOCOL_PATH: path.join(__dirname, 'libsqlProtocol.js'),
    };
    if (this.authToken) env.HONEST_LIBSQL_TOKEN = this.authToken;

    const child = spawnSync(process.execPath, [HELPER], {
      input: JSON.stringify({ check: true }),
      encoding: 'utf8',
      env,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      timeout: 20000,
    });
    if (child.error) throw new Error(`Could not reach the remote database: ${child.error.message}`);
    let payload;
    try {
      payload = JSON.parse((child.stdout || '').trim());
    } catch (err) {
      throw new Error('The remote database did not answer the connection probe.');
    }
    if (!payload.ok) {
      const error = new Error(payload.message || 'The remote database refused the connection.');
      error.code = payload.code || 'LIBSQL_UNREACHABLE';
      throw error;
    }
    return true;
  }

  /** node:sqlite compatibility: `exec` runs one or more statements. */
  exec(sql) {
    const statements = splitStatements(String(sql));
    if (statements.length === 0) return;
    this.remoteStatements += statements.length;
    this.run(statements.map((statement) => ({ sql: statement, args: [] })));
  }

  dispose() {
    this.closed = true;
    this.pending = [];
  }
}

class LibsqlStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.source = sql;
    this.cached = true;
  }

  /**
   * sqlite3 reports 0 for statements it has already executed to completion, and
   * non-zero while they still have work to do. Mirrored for compatibility.
   */
  get sourceSQL() {
    return this.source;
  }

  all(...params) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return this.db._select(this.sql, args);
  }

  get(...params) {
    const rows = this.all(...params);
    return rows.length > 0 ? rows[0] : undefined;
  }

  run(...params) {
    const args = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
    return this.db._run(this.sql, args);
  }

  *iterate(...params) {
    for (const row of this.all(...params)) yield row;
  }
}

class LibsqlDatabaseSync {
  constructor(urlOrOptions, authToken) {
    const options = typeof urlOrOptions === 'object' && urlOrOptions !== null ? urlOrOptions : { url: urlOrOptions };
    this.executor = new LibsqlExecutor({
      url: options.url,
      authToken: options.authToken !== undefined ? options.authToken : authToken,
    });
    this.pending = [];
    this.closed = false;
    this.kind = 'remote';
    this.driver = 'libsql-http';
  }

  _localPragmaResult(sql) {
    const parsed = protocol.parsePragma(sql);
    if (!parsed) return null;
    // Only bare `PRAGMA name = value` forms are client-side settings. The
    // `PRAGMA name(args)` form is a query (table_info) and must be executed.
    if (/\(\s*[^)]*\s*\)/.test(sql)) return null;
    const canned = LOCAL_PRAGMAS[parsed.name];
    if (!canned) return null;
    return canned.rows;
  }

  _flush() {
    if (this.pending.length === 0) return [];
    const batch = this.pending;
    this.pending = [];

    let results;
    try {
      results = this.executor.run(batch.map((entry) => ({ sql: entry.sql, args: entry.args })));
    } catch (err) {
      // The statements were not accepted; put them back so a retry is possible
      // and the caller sees a real failure rather than silent data loss.
      this.pending = batch.concat(this.pending);
      throw err;
    }

    if (results.length !== batch.length) {
      throw new Error(
        `The remote database returned ${results.length} result(s) for ${batch.length} statement(s).`
      );
    }
    for (let i = 0; i < batch.length; i += 1) {
      batch[i].rows = results[i].rows;
      batch[i].changes = results[i].changes;
      batch[i].lastInsertRowid = results[i].lastInsertRowid;
    }
    return batch;
  }

  _queue(sql, args) {
    const entry = { sql: protocol.reconstructStatement(sql, args || []), args: [], rows: null, changes: 0, lastInsertRowid: 0 };
    this.pending.push(entry);
    return entry;
  }

  _select(sql, args) {
    if (this.closed) throw new Error('This database connection has already been closed.');
    const canned = this._localPragmaResult(sql);
    if (canned) return canned;
    const entry = this._queue(sql, args);
    // Reads must see everything issued before them.
    this._flush();
    return entry.rows || [];
  }

  _run(sql, args) {
    if (this.closed) throw new Error('This database connection has already been closed.');
    const entry = this._queue(sql, args);
    // A write must report its own row id, which means flushing it now.
    this._flush();
    return {
      changes: entry.changes || 0,
      lastInsertRowid: entry.lastInsertRowid === null || entry.lastInsertRowid === undefined ? 0 : entry.lastInsertRowid,
    };
  }

  prepare(sql) {
    return new LibsqlStatement(this, String(sql));
  }

  exec(sql) {
    const statements = splitStatements(String(sql));
    if (statements.length === 0) return;
    for (const statement of statements) {
      const canned = this._localPragmaResult(statement);
      if (canned) continue;
      this._queue(statement, []);
    }
    this._flush();
  }

  close() {
    if (this.closed) return;
    this._flush();
    this.closed = true;
    this.executor.dispose();
  }
}

module.exports = { LibsqlDatabaseSync, LibsqlExecutor, splitStatements, LOCAL_PRAGMAS };
