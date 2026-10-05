'use strict';

/**
 * Off days.
 *
 * CRITICAL RULE (backend-enforced, never trusted to the frontend):
 * an off day can only be activated (or removed) BEFORE its deadline — the
 * accountability time plus the grace period on that date. Once the deadline
 * has passed, the day is history and stays as it was recorded. This prevents
 * retroactively erasing a red day after the fact.
 */

const { conflict, notFound } = require('../utils/errors');
const { diffDays } = require('../utils/dates');
const { fail, assertBodyObject, assertOnlyKeys, vDate, vString } = require('../utils/validate');
const { getDayDetail, daySummary, offDayPublic } = require('./dayService');
const { offDayDeadlineFor } = require('./settingsService');

function activateOffDay(db, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, ['date', 'reason', 'note']);
  const date = vDate(input.date, 'date', { required: true });
  const reason = vString(input.reason, 'reason', { required: true, max: 100 });
  const note = vString(input.note, 'note', { max: 300 });

  const ahead = diffDays(clock.todayDate, date);
  if (ahead < -1 || ahead > 366) throw fail('date', 'must be within a reasonable window around today.');

  const deadline = offDayDeadlineFor(clock, date);
  if (clock.now.getTime() >= deadline.getTime()) {
    throw conflict(
      'OFF_DAY_DEADLINE_PASSED',
      `An off day for ${date} can no longer be activated — its deadline (${clock.settings.accountabilityTime} + ${clock.graceMinutes} min grace) has passed. Off days cannot be claimed retroactively.`
    );
  }
  if (db.get('SELECT id FROM off_days WHERE date = ?', date)) {
    throw conflict('OFF_DAY_EXISTS', `${date} is already marked as an off day.`);
  }

  const ins = db.run(
    'INSERT INTO off_days (date, reason, note, activated_at) VALUES (?,?,?,?)',
    date,
    reason,
    note ?? null,
    clock.now.toISOString()
  );
  const row = db.get('SELECT * FROM off_days WHERE id = ?', ins.lastInsertRowid);
  const detail = getDayDetail(db, date, { clock });
  return { offDay: offDayPublic(row), day: daySummary(detail) };
}

function deleteOffDay(db, id, { clock }) {
  const row = db.get('SELECT * FROM off_days WHERE id = ?', id);
  if (!row) throw notFound('OFF_DAY_NOT_FOUND', `Off day ${id} does not exist.`);
  const deadline = offDayDeadlineFor(clock, row.date);
  if (clock.now.getTime() >= deadline.getTime()) {
    throw conflict(
      'OFF_DAY_LOCKED',
      'This off day has become part of your history and can no longer be removed.'
    );
  }
  db.run('DELETE FROM off_days WHERE id = ?', id);
  return { id, deleted: true };
}

function listOffDays(db, { from, to } = {}) {
  if (from || to) {
    return db
      .all('SELECT * FROM off_days WHERE date BETWEEN ? AND ? ORDER BY date', from || '0000-01-01', to || '9999-12-31')
      .map(offDayPublic);
  }
  return db.all('SELECT * FROM off_days ORDER BY date DESC LIMIT 200').map(offDayPublic);
}

module.exports = { activateOffDay, deleteOffDay, listOffDays };
