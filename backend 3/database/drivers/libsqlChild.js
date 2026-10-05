'use strict';

/**
 * Remote libSQL executor.
 *
 * This module is run as a short-lived process by `database/drivers/libsql.js`.
 * It exists so the rest of the backend can stay synchronous: the parent sends a
 * batch of statements in one go and reads the results back from this process's
 * standard output, while the actual HTTP conversation with Turso happens here.
 *
 * Protocol (deliberately trivial so nothing can go wrong in transit)
 * ------------------------------------------------------------------
 *   stdin   a JSON payload { check?: boolean, statements: [{ sql, args }] }
 *   stdout  a JSON envelope, preceded by nothing else, e.g.
 *             {"ok":true,"results":[{"rows":[],"changes":1,"lastInsertRowid":7}]}
 *             {"ok":false,"message":"...","code":"SQLITE_ERROR"}
 *
 * The URL and token arrive through the environment (HONEST_LIBSQL_URL /
 * HONEST_LIBSQL_TOKEN) so a token never appears in a process listing.
 */

function readStdin() {
  try {
    return require('node:fs').readFileSync(0, 'utf8');
  } catch (err) {
    return '';
  }
}

function write(payload) {
  process.stdout.write(JSON.stringify(payload));
}

async function main() {
  const url = process.env.HONEST_LIBSQL_URL;
  const authToken = process.env.HONEST_LIBSQL_TOKEN || null;
  if (!url) {
    write({ ok: false, message: 'HONEST_LIBSQL_URL is not set for the remote database helper.', code: 'NO_URL' });
    return;
  }

  const protocol = require(process.env.HONEST_PROTOCOL_PATH || '../libsqlProtocol');

  const request = JSON.parse(readStdin() || '{}');

  if (request.check) {
    // A trivial round trip proves the endpoint, the token and the network all work.
    const probe = protocol.buildPipelineRequest([{ sql: 'SELECT 1 AS ok', args: [] }], { url, authToken });
    const response = await fetch(probe.url, {
      method: 'POST',
      headers: probe.headers,
      body: JSON.stringify(probe.body),
    });
    if (!response.ok) {
      write({
        ok: false,
        message: `The remote database refused the connection (HTTP ${response.status}). Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.`,
        code: `HTTP_${response.status}`,
      });
      return;
    }
    await response.text();
    write({ ok: true, results: [{ rows: [{ ok: 1 }], changes: 0, lastInsertRowid: 0 }] });
    return;
  }

  const statements = Array.isArray(request.statements) ? request.statements : [];
  if (statements.length === 0) {
    write({ ok: true, results: [] });
    return;
  }

  const pipeline = protocol.buildPipelineRequest(statements, { url, authToken });
  const response = await fetch(pipeline.url, {
    method: 'POST',
    headers: pipeline.headers,
    body: JSON.stringify(pipeline.body),
  });

  const text = await response.text();
  if (!response.ok) {
    write({
      ok: false,
      message: `The remote database returned HTTP ${response.status}: ${text.slice(0, 400)}`,
      code: `HTTP_${response.status}`,
    });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    write({ ok: false, message: `The remote database returned a non-JSON response: ${text.slice(0, 200)}`, code: 'BAD_RESPONSE' });
    return;
  }

  try {
    const results = protocol.parsePipelineResponse(payload);
    write({ ok: true, results });
  } catch (err) {
    write({ ok: false, message: err.message, code: err.code || 'LIBSQL_ERROR' });
  }
}

main().catch((err) => {
  write({ ok: false, message: err && err.message ? err.message : String(err), code: 'HELPER_FAILURE' });
});
