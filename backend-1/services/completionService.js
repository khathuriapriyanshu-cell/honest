'use strict';

/**
 * Completion logic.
 *
 * Business rules:
 * - A completion can only be recorded while the day is still open
 *   (now < the day's reset instant). After the day closes, the honest path is
 *   a reflection — not a late checkmark. The backend enforces this; the
 *   frontend cannot bypass it.
 * - Completing is an upsert on (task, date): re-completing updates the note /
 *   minutes while keeping the original completed_at moment.
 * - Undo (uncomplete) is allowed for any date — correcting a false record is
 *   honesty, and the day's status is simply recomputed from the truth.
 */

const { badRequest, notFound, conflict } = require('../utils/errors');
const { assertBodyObject, assertOnlyKeys, vDate, vNumber, vString } = require('../utils/validate');
const { getTaskRow } = require('./taskService');
const { getDayDetail, daySummary, isTaskScheduledOn } = require('./dayService');
const { dayResetInstant } = require('./settingsService');

function completeTask(db, taskId, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, ['date', 'minutes', 'note']);
  const date = vDate(input.date, 'date', { defaultValue: clock.todayDate });
  if (date > clock.todayDate) {
    throw badRequest('DATE_IN_FUTURE', 'You cannot complete a task for a future date.');
  }
  getTaskRow(db, taskId); // 404 if missing
  const minutes = vNumber(input.minutes, 'minutes', { min: 0, max: 1440, integer: true });
  const note = vString(input.note, 'note', { max: 500 });

  const resetAt = dayResetInstant(clock, date);
  if (clock.now.getTime() >= resetAt.getTime()) {
    throw conflict(
      'DAY_CLOSED',
      `The day ${date} has already closed. Record a reflection for it instead — honesty about a miss is worth more than a late checkmark.`
    );
  }
  if (!isTaskScheduledOn(db, taskId, date)) {
    throw conflict('TASK_NOT_SCHEDULED', `This task was not scheduled on ${date}.`);
  }

  const existing = db.get('SELECT * FROM completions WHERE task_id = ? AND date = ?', taskId, date);
  if (existing) {
    db.run(
      'UPDATE completions SET minutes_spent = ?, note = ? WHERE id = ?',
      minutes !== undefined ? minutes : existing.minutes_spent,
      note !== undefined ? note : existing.note,
      existing.id
    );
  } else {
    db.run(
      'INSERT INTO completions (task_id, date, minutes_spent, note, completed_at) VALUES (?,?,?,?,?)',
      taskId,
      date,
      minutes ?? null,
      note ?? null,
      clock.now.toISOString()
    );
  }

  const detail = getDayDetail(db, date, { clock });
  return { date, day: daySummary(detail), task: detail.tasks.find((t) => t.taskId === taskId) };
}

function uncompleteTask(db, taskId, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, ['date']);
  const date = vDate(input.date, 'date', { defaultValue: clock.todayDate });
  getTaskRow(db, taskId);

  const row = db.get('SELECT * FROM completions WHERE task_id = ? AND date = ?', taskId, date);
  if (!row) {
    throw notFound('COMPLETION_NOT_FOUND', `No completion is recorded for this task on ${date}.`);
  }
  db.run('DELETE FROM completions WHERE id = ?', row.id);
  const detail = getDayDetail(db, date, { clock });
  return { date, removed: true, day: daySummary(detail) };
}

module.exports = { completeTask, uncompleteTask };
