'use strict';

/**
 * Development / diagnostics helper: boots the app on an ephemeral port against a
 * fresh database and prints a few real API responses. Nothing is written to the
 * project database.
 *
 *   node scripts/smoke.js
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { openDatabase } = require('../database/db');
const { Clock } = require('../utils/clock');
const { createApp } = require('../app');
const { startScheduler } = require('../scheduler/scheduler');

async function main() {
  const file = path.join(os.tmpdir(), `honest-smoke-${Date.now()}.db`);
  const { db } = openDatabase(file);
  const clock = new Clock(db);
  const deps = { db, clock, frontendDir: null };
  const scheduler = startScheduler(deps, { intervalMs: 60000 });
  deps.scheduler = scheduler;
  const app = createApp(deps);

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const call = async (method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      json = { raw: text };
    }
    console.log(`\n${method} ${route} -> ${res.status}`);
    console.log(JSON.stringify(json, null, 2).slice(0, 1200));
    return { status: res.status, json };
  };

  await call('GET', '/health');
  const created = await call('POST', '/tasks', {
    title: 'Study Physics',
    definition: 'At least 45 minutes without phone',
    category: 'Study',
    repeat: 'daily',
    reminder: '20:00',
    accountabilityTime: '22:30',
  });
  const taskId = created.json.task && created.json.task.id;
  await call('GET', '/today');
  await call('PUT', `/tasks/${taskId}/complete`);
  await call('GET', '/today');
  await call('GET', '/report/weekly');
  await call('GET', '/stats/score');
  await call('GET', '/stats/honest-days');

  server.close();
  scheduler.stop();
  db.close();
  fs.rmSync(file, { force: true });
}

main().catch((err) => {
  console.error('smoke failed:', err);
  process.exit(1);
});
