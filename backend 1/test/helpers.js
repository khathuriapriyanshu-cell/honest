'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../app');

let counter = 0;

/**
 * Boots the real app (HTTP server on an ephemeral port) with a temp SQLite
 * file and an injectable clock. `now: () => clock.value` lets tests control
 * time precisely — midnight, grace windows and deadlines all become testable.
 */
async function startApp({ now } = {}) {
  const dbFile = path.join(os.tmpdir(), `honest-test-${process.pid}-${Date.now()}-${counter++}.sqlite`);
  const app = createApp({ dbPath: dbFile, now: now || (() => new Date()) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function call(method, p, body, rawBody) {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: body !== undefined || rawBody !== undefined ? { 'content-type': 'application/json' } : {},
      body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }
  const get = (p) => call('GET', p);
  const post = (p, b) => call('POST', p, b ?? {});
  const put = (p, b) => call('PUT', p, b ?? {});
  const patch = (p, b) => call('PATCH', p, b ?? {});
  const del = (p) => call('DELETE', p);

  /** Close the server and database but KEEP the db file (persistence tests). */
  async function disconnect() {
    // undici (global fetch) holds keep-alive sockets open; force-close them
    // so server.close() can complete instead of hanging until socket timeout.
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try {
      app.locals.db.close();
    } catch {
      /* already closed */
    }
  }

  async function stop() {
    await disconnect();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbFile + suffix);
      } catch {
        /* ignore */
      }
    }
  }

  return { app, db: app.locals.db, base, call, get, post, put, patch, del, stop, disconnect, dbFile };
}

/** Mutable clock: pass `now: () => clock.value`, then reassign clock.value. */
const clockAt = (iso) => ({ value: new Date(iso) });

module.exports = { startApp, clockAt };
