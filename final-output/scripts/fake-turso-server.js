'use strict';

/**
 * A standalone stand-in for a Turso database.
 *
 *   node scripts/fake-turso-server.js --port-file <path> [--port 0]
 *
 * Why a separate process
 * ----------------------
 * The remote driver reaches the database through a child process that performs
 * the HTTP round trip synchronously (see database/drivers/libsql.js). A server
 * listening inside the *same* process would deadlock: the parent's event loop is
 * blocked while the child waits for a reply. That is a property of the
 * synchronous bridge, not of this stand-in - a real Turso lives on another
 * machine, so it is unaffected. Running this fake in its own process reproduces
 * those real conditions.
 *
 * It speaks the Hrana v2 pipeline protocol and understands just enough SQL for
 * this backend, so it verifies the plumbing (driver selection, helper process,
 * JSON protocol, Hrana encoding, batching, error handling) rather than the SQL
 * engine itself.
 *
 * Every statement it receives is appended to the log file it was given, so a
 * test can inspect exactly what travelled over the wire.
 */

const http = require('node:http');
const fs = require('node:fs');

const protocol = require('../database/drivers/libsqlProtocol');

function parseArgs(argv) {
  const args = { port: 0, portFile: null, logFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') args.port = Number(argv[i + 1]);
    if (argv[i] === '--port-file') args.portFile = argv[i + 1];
    if (argv[i] === '--log-file') args.logFile = argv[i + 1];
  }
  return args;
}

/** Reads the string literals out of a `VALUES (...)` clause. */
function readValueLiterals(sql) {
  const start = sql.search(/values\s*\(/i);
  if (start === -1) return [];
  let i = sql.indexOf('(', start);
  const values = [];
  let current = null;

  for (; i < sql.length; i += 1) {
    const char = sql[i];
    if (current === null) {
      if (char === "'") current = '';
      else if (char === ')') break;
      continue;
    }
    if (char === "'") {
      // A doubled quote is an escaped quote inside the literal.
      if (sql[i + 1] === "'") {
        current += "'";
        i += 1;
      } else {
        values.push(current);
        current = null;
      }
      continue;
    }
    current += char;
  }
  return values;
}

function createEngine() {
  const rows = [];
  const sequences = new Map();
  const executed = [];

  return {
    executed,
    statementCount: () => executed.length,
    execute(sql) {
      const text = String(sql).trim().replace(/;$/, '');
      executed.push(text);

      if (/^select\s+1\s+as\s+ok$/i.test(text)) return { cols: ['ok'], rows: [[1]], changes: 0 };

      if (/^select\s+value\s+from\s+meta\s+where\s+key\s*=\s*'schema_version'$/i.test(text)) {
        const row = rows.find((r) => r.table === 'meta' && r.data.key === 'schema_version');
        return { cols: ['value'], rows: row ? [[row.data.value]] : [], changes: 0 };
      }

      if (/^insert\s+(or\s+ignore\s+)?into\s+settings/i.test(text)) {
        const [key, value] = readValueLiterals(text);
        if (key !== undefined && !rows.some((r) => r.table === 'settings' && r.data.key === key)) {
          rows.push({ table: 'settings', data: { key, value } });
        }
        return { cols: [], rows: [], changes: 1 };
      }

      if (/^select\s+key,\s*value\s+from\s+settings$/i.test(text)) {
        return {
          cols: ['key', 'value'],
          rows: rows.filter((r) => r.table === 'settings').map((r) => [r.data.key, r.data.value]),
          changes: 0,
        };
      }

      if (/^insert\s+(or\s+ignore\s+)?into\s+tasks/i.test(text)) {
        const values = readValueLiterals(text);
        const id = (sequences.get('tasks') || 0) + 1;
        sequences.set('tasks', id);
        rows.push({ table: 'tasks', data: { id, name: values[0] === undefined ? null : values[0] } });
        return { cols: [], rows: [], changes: 1, lastInsertRowid: String(id) };
      }

      if (/^select\s+id,\s*name\s+from\s+tasks/i.test(text)) {
        return {
          cols: ['id', 'name'],
          rows: rows.filter((r) => r.table === 'tasks').map((r) => [r.data.id, r.data.name]),
          changes: 0,
        };
      }

      if (/^select\s+name\s+from\s+tasks\s+where\s+id\s*=/i.test(text)) {
        const id = Number((/where\s+id\s*=\s*(\d+)/i.exec(text) || [])[1]);
        const row = rows.find((r) => r.table === 'tasks' && r.data.id === id);
        return { cols: ['name'], rows: row ? [[row.data.name]] : [], changes: 0 };
      }

      // DDL, pragma probes and anything else: accepted, nothing to store.
      return { cols: [], rows: [], changes: 0 };
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = createEngine();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch (err) {
        res.writeHead(400);
        res.end('bad json');
        return;
      }

      if (args.logFile) {
        try {
          fs.appendFileSync(
            args.logFile,
            `${JSON.stringify({
              url: req.url,
              authorization: req.headers.authorization || null,
              statements: payload.requests.filter((r) => r.type === 'execute').map((r) => r.stmt.sql),
            })}\n`
          );
        } catch (err) {
          /* logging is best effort */
        }
      }

      const results = payload.requests.map((request) => {
        if (request.type !== 'execute') return { type: 'ok', response: { type: 'close' } };
        const result = engine.execute(request.stmt.sql);
        return {
          type: 'ok',
          response: {
            type: 'execute',
            result: {
              cols: result.cols.map((name) => ({ name })),
              rows: result.rows.map((row) => row.map((value) => protocol.encodeArg(value))),
              affected_row_count: result.changes,
              ...(result.lastInsertRowid ? { last_insert_rowid: result.lastInsertRowid } : {}),
            },
          },
        };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ baton: null, results }));
    });
  });

  server.listen(args.port, '127.0.0.1', () => {
    const port = server.address().port;
    if (args.portFile) fs.writeFileSync(args.portFile, String(port));
    if (process.send) process.send({ port });
    console.log(JSON.stringify({ ready: true, port }));
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('disconnect', shutdown);
}

if (require.main === module) main();

module.exports = { createEngine };
