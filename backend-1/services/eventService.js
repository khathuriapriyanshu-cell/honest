'use strict';

/**
 * Accountability event log + server-side scheduler tick.
 *
 * Architecture (simple and reliable):
 * - GET endpoints always compute truth live from the database + server clock,
 *   so correctness never depends on a tick having fired.
 * - A 30s server-side tick (see server.js) additionally records phase
 *   transitions into `events` as a durable audit trail, deduplicated per
 *   (type, date). The tick only writes facts it observes; it never
 *   backfills history for moments nobody observed.
 */

const { getTodayState } = require('./accountabilityService');

const EVENT_TYPES = ['day_rolled', 'accountability_check', 'final_warning'];

function recordEvent(db, type, forDate, payload) {
  db.run(
    'INSERT OR IGNORE INTO events (type, for_date, payload, created_at) VALUES (?,?,?,?)',
    type,
    forDate,
    JSON.stringify(payload ?? {}),
    new Date().toISOString()
  );
}

function tick(db, { clock }) {
  const state = getTodayState(db, { clock });
  recordEvent(db, 'day_rolled', clock.todayDate, {
    timezone: clock.timezone,
    yesterday: state.yesterday
      ? { date: state.yesterday.date, status: state.yesterday.status, resolved: state.yesterday.resolved }
      : null,
  });
  if (!state.offDay) {
    const order = { open: 0, accountability: 1, grace_ended: 2, final_warning: 3 };
    if (order[clock.phase] >= 1) {
      recordEvent(db, 'accountability_check', clock.todayDate, {
        total: state.counts.promised,
        completed: state.counts.completed,
        unfinished: state.counts.unfinishedPromises,
      });
    }
    if (clock.phase === 'final_warning') {
      recordEvent(db, 'final_warning', clock.todayDate, {
        minutesLeft: Math.max(1, Math.round((clock.resetAt.getTime() - clock.now.getTime()) / 60000)),
        unfinished: state.counts.unfinishedPromises,
      });
    }
  }
  return { recorded: true, phase: clock.phase, date: clock.todayDate };
}

function listEvents(db, { limit } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db.all('SELECT * FROM events ORDER BY created_at DESC, id DESC LIMIT ?', cap).map((e) => ({
    id: e.id,
    type: e.type,
    date: e.for_date,
    payload: safeParse(e.payload),
    createdAt: e.created_at,
  }));
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

module.exports = { EVENT_TYPES, recordEvent, tick, listEvents };
