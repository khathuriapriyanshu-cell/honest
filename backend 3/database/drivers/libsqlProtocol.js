'use strict';

/**
 * libSQL / Turso Hrana protocol helpers.
 *
 * Turso speaks the Hrana v2 pipeline protocol over HTTP, which is *batch*
 * oriented: many statements travel in one request and their results come back
 * in order. That property is what lets the backend keep its synchronous service
 * layer while talking to a remote database - a whole tick or request is sent as
 * one round trip.
 *
 * Everything in this file is pure (no I/O), so it is unit tested directly.
 */

/** Serialises a JavaScript value into a Hrana argument. */
function encodeArg(value) {
  if (value === null || value === undefined) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString() };
  if (typeof value === 'number') {
    if (Number.isInteger(value) && Number.isSafeInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'float', value };
  }
  if (typeof value === 'boolean') return { type: 'integer', value: value ? '1' : '0' };
  if (typeof value === 'string') return { type: 'text', value };
  if (Buffer.isBuffer(value)) return { type: 'blob', base64: value.toString('base64') };
  if (value instanceof Date) return { type: 'text', value: value.toISOString() };
  if (Array.isArray(value) || typeof value === 'object') return { type: 'text', value: JSON.stringify(value) };
  return { type: 'text', value: String(value) };
}

function decodeCell(cell) {
  if (cell === null || cell === undefined) return null;
  switch (cell.type) {
    case 'null':
      return null;
    case 'integer':
      // Stay within Number while it is exact; fall back to BigInt beyond that.
      return Number.isSafeInteger(Number(cell.value)) ? Number(cell.value) : BigInt(cell.value);
    case 'float':
      return Number(cell.value);
    case 'text':
      return cell.value;
    case 'blob':
      return Buffer.from(cell.base64, 'base64');
    default:
      return null;
  }
}

function decodeRows(result) {
  if (!result || !result.cols || !result.rows) return [];
  const columns = result.cols.map((col) => col.name);
  return result.rows.map((row) => {
    const out = {};
    for (let i = 0; i < columns.length; i += 1) out[columns[i]] = decodeCell(row[i]);
    return out;
  });
}

/**
 * Splits a `PRAGMA name = value;` statement into its parts.
 * @returns {{ name: string, value: string|null }|null}
 */
function parsePragma(statement) {
  const match = /^\s*pragma\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\s*([^)]*)\s*\)|=([^;]*))?;?\s*$/i.exec(statement);
  if (!match) return null;
  return { name: match[1].toLowerCase(), value: match[3] !== undefined ? match[3].trim() : null };
}

/** Escapes a value for embedding in a literal SQL statement. */
function quoteSqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  return `'${JSON.stringify(value).replace(/'/g, "''")}'`;
}

/**
 * Rebuilds a parameterised statement into a literal statement, because the
 * vendored SQL parser in front of remote libSQL accepts plain statements.
 *
 * Every parameter that came from a bound value is quoted as a SQL literal, never
 * interpolated as raw text, so this cannot become an injection vector.
 */
function reconstructStatement(sql, args = []) {
  let index = 0;
  const consumed = [];
  const rebuilt = sql.replace(/(\?|:\w+|\$\d+|@\w+)/g, (match, token) => {
    if (/^[?]$/.test(token)) {
      const value = args[index];
      consumed.push(index);
      index += 1;
      return quoteSqlLiteral(value);
    }
    return match;
  });
  if (consumed.length !== args.length && args.length > 0) {
    // Positional placeholders did not account for every value: refuse rather
    // than silently dropping data.
    throw new Error(
      `Cannot forward statement to the remote database: ${args.length} value(s) bound but ${consumed.length} placeholder(s) found.`
    );
  }
  return rebuilt;
}

/** One Hrana pipeline request for a list of statements. */
function buildPipelineRequest(statements, { url, authToken } = {}) {
  if (!url) throw new Error('A libSQL URL is required to build a request.');
  const endpoint = `${url.replace(/\/+$/, '')}/v2/pipeline`;
  const headers = { 'Content-Type': 'application/json' };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;

  return {
    url: endpoint,
    headers,
    body: {
      baton: null,
      requests: [
        ...statements.map((statement) => ({
          type: 'execute',
          stmt: {
            sql: statement.sql,
            args: (statement.args || []).map(encodeArg),
            want_rows: statement.wantRows !== false,
          },
        })),
        { type: 'close' },
      ],
    },
  };
}

/**
 * Turns a Hrana pipeline response into executor results.
 * @returns {Array<{rows: object[], changes: number, lastInsertRowid: number|bigint}>}
 */
function parsePipelineResponse(payload) {
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('Unexpected response from the remote database (no results array).');
  }

  const results = [];
  for (const entry of payload.results) {
    if (entry.type === 'error') {
      const error = new Error(entry.error && entry.error.message ? entry.error.message : 'Remote database error.');
      error.code = entry.error && entry.error.code ? entry.error.code : 'LIBSQL_ERROR';
      throw error;
    }
    if (entry.type !== 'ok') continue;
    const response = entry.response || {};
    if (response.type === 'execute') {
      const result = response.result || {};
      const changes = typeof result.affected_row_count === 'number' ? result.affected_row_count : 0;
      let lastInsertRowid = 0;
      if (result.last_insert_rowid !== undefined && result.last_insert_rowid !== null) {
        const raw = String(result.last_insert_rowid);
        lastInsertRowid = Number.isSafeInteger(Number(raw)) ? Number(raw) : BigInt(raw);
      } else if (changes > 0) {
        lastInsertRowid = null; // Caller may ask explicitly; unknown here.
      }
      results.push({ rows: decodeRows(result), changes, lastInsertRowid });
    }
    // "close" responses carry nothing useful.
  }
  return results;
}

module.exports = {
  encodeArg,
  decodeCell,
  decodeRows,
  parsePragma,
  quoteSqlLiteral,
  reconstructStatement,
  buildPipelineRequest,
  parsePipelineResponse,
};
