'use strict';

/**
 * HONEST backend — Be honest with yourself.
 *
 * Start:            npm start   (default port 3000 — the frontend's default)
 * Custom port/db:   PORT=4000 HONEST_DB_PATH=./database/honest.sqlite node server.js
 *
 * Scheduling mechanism (simple + reliable):
 *   - Every API response is computed live from SQLite + the server clock, so
 *     correctness never depends on a scheduler having fired.
 *   - A 30-second tick additionally records accountability phase transitions
 *     (accountability_check, final_warning, day_rolled) into the events
 *     table — a durable audit trail, deduplicated per (type, date).
 */

const { createApp } = require('./app');
const { getClockContext } = require('./services/settingsService');
const eventService = require('./services/eventService');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.HONEST_DB_PATH || undefined;

const app = createApp({ dbPath: DB_PATH });
const db = app.locals.db;
const now = app.locals.now;

function tick() {
  try {
    eventService.tick(db, { clock: getClockContext(db, now()) });
  } catch (err) {
    console.error('[honest] scheduler tick failed:', err.message);
  }
}
const timer = setInterval(tick, 30 * 1000);
timer.unref();
tick(); // record state immediately at boot (deduplicated per date)

const server = app.listen(PORT, () => {
  const clock = getClockContext(db, now());
  console.log('HONEST backend listening on http://localhost:' + PORT);
  console.log(`Timezone: ${clock.timezone} | Today: ${clock.todayDate} | Local time: ${clock.now.toISOString()}`);
  console.log('API documentation: API.md | Health: http://localhost:' + PORT + '/api/health');
});

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
