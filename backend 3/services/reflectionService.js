'use strict';

const { all, get, run, transaction } = require('../database/helpers');
const { ApiError } = require('../utils/errors');
const time = require('../utils/time');
const validate = require('../utils/validate');
const dayService = require('./dayService');
const occurrenceService = require('./occurrenceService');
const offDayService = require('./offDayService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Reflections = reasons.
 *
 * A missed promise may receive one honest reason. Reflection is deliberately
 * never punitive: the backend records the reason, marks the promise as
 * explained, and treats "missed but explained" as an honest outcome rather
 * than a failure.
 *
 * A reflection always belongs to a specific promise on a specific date, and
 * that date is always validated against the server clock - the client cannot
 * explain a day that has not happened.
 */

function rowToReflection(row) {
  if (!row) return null;
  return {
    id: row.id,
    occurrenceId: row.occurrence_id,
    taskId: row.task_id,
    date: row.date,
    taskName: row.task_name,
    reason: row.reason,
    source: row.source,
    createdAt: row.created_at,
  };
}

/** Public (archive friendly) shape. */
function toApiShape(row) {
  const reflection = rowToReflection(row);
  if (!reflection) return null;
  return {
    id: String(reflection.id),
    reflectionId: reflection.id,
    date: time.formatArchiveDate(reflection.date),
    isoDate: reflection.date,
    taskId: reflection.taskId === null ? null : String(reflection.taskId),
    taskName: reflection.taskName,
    reason: reflection.reason,
    source: reflection.source,
    createdAt: reflection.createdAt,
  };
}

function normalizeReason(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?,;]+$/, '');
}

/**
 * Finds the date a reflection should be attached to when the client does not
 * say.
 *
 * Normally that is today. But between the daily reset and the end of the grace
 * period, yesterday's promises can still be finished - and if they were not,
 * they are what the user is being asked about. In that window an unqualified
 * reflection belongs to yesterday, which is where the unfinished promises live.
 */
function resolveReflectionDate({ db, clock }, requestedDate) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  if (requestedDate) return { date: validate.asDate(requestedDate, 'date'), today };

  const minutesNow = clock.minutesSinceMidnight(runtime.resolvedTimezone);
  const carryOpen = dayService.carryOverOpen(runtime, minutesNow);
  if (carryOpen) {
    const yesterday = time.shiftIsoDate(today, -1);
    const yesterdayDay = dayService.getDayTasks(db, yesterday);
    if (yesterdayDay.counts.unresolved > 0 && !yesterdayDay.isOffDay) {
      return { date: yesterday, today, carriedOver: true };
    }
  }
  return { date: today, today, carriedOver: false };
}

/**
 * Submits an honest reflection for one or more missed promises.
 *
 * @param {object} deps { db, clock }
 * @param {object} input { reason, date?, taskIds?, source? }
 */
function submitReflection({ db, clock }, input) {
  validate.requireObject(input, 'body');
  const reason = validate.asReflectionReason(input.reason ?? input.reflection, 'reason');
  const explicitIds = validate.asIdList(input.taskIds ?? input.taskIds, 'taskIds');
  const { date, today, carriedOver } = resolveReflectionDate({ db, clock }, input.date || null);
  const source = input.source
    ? validate.asEnum(input.source, 'source', ['night_check', 'midnight', 'carry_over', 'manual'], {
        normalise: (v) => v.toLowerCase(),
      })
    : carriedOver
      ? 'carry_over'
      : 'night_check';

  // The backend refuses to explain a future day.
  if (date > today) {
    throw ApiError.badRequest('REFLECTION_IN_FUTURE', 'A reflection cannot be recorded for a day that has not happened.', {
      date,
      serverToday: today,
    });
  }

  if (offDayService.isOffDay(db, date)) {
    throw ApiError.conflict(
      'OFF_DAY_NO_REFLECTION_NEEDED',
      `${date} is an off day, so there is nothing to explain.`,
      { date }
    );
  }

  const day = dayService.getDayTasks(db, date);
  const unresolved = day.items.filter((item) => item.unresolved);

  let targets = unresolved;
  if (explicitIds && explicitIds.length > 0) {
    const byId = new Map(day.items.map((item) => [item.task.id, item]));
    targets = [];
    for (const id of explicitIds) {
      const item = byId.get(id);
      if (!item) {
        throw ApiError.badRequest(
          'TASK_NOT_ON_DATE',
          `Promise ${id} is not part of ${date}, so it cannot be explained for that day.`,
          { taskId: id, date }
        );
      }
      if (!item.unresolved) {
        throw ApiError.conflict(
          'TASK_ALREADY_RESOLVED',
          `"${item.displayTask.name}" on ${date} is already completed or explained.`,
          { taskId: id, date, state: item.state }
        );
      }
      targets.push(item);
    }
  }

  if (targets.length === 0) {
    throw ApiError.conflict(
      'NOTHING_TO_REFLECT_ON',
      `There are no unresolved promises on ${date}. Nothing needs an explanation.`,
      { date, total: day.counts.total, unresolved: day.counts.unresolved }
    );
  }

  const nowIso = time.nowIso(clock);
  const created = transaction(db, () => {
    const out = [];
    for (const item of targets) {
      const existingReflection = get(
        db,
        'SELECT * FROM reflections WHERE task_id = ? AND date = ? ORDER BY id DESC LIMIT 1',
        [item.task.id, date]
      );

      const occurrence = occurrenceService.markExplained(
        db,
        item.task.id,
        date,
        nowIso,
        occurrenceService.contentOf(item.task)
      );

      let reflectionRow = existingReflection;
      if (existingReflection) {
        run(db, 'UPDATE reflections SET reason = ?, occurrence_id = ? WHERE id = ?', [
          reason,
          occurrence.id,
          existingReflection.id,
        ]);
        reflectionRow = get(db, 'SELECT * FROM reflections WHERE id = ?', [existingReflection.id]);
      } else {
        run(
          db,
          `INSERT INTO reflections (occurrence_id, task_id, date, task_name, reason, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [occurrence.id, item.task.id, date, item.displayTask.name, reason, source, nowIso]
        );
        reflectionRow = get(db, 'SELECT * FROM reflections WHERE id = last_insert_rowid()');
      }
      out.push(reflectionRow);
    }
    return out;
  });

  const remaining = dayService.getDayTasks(db, date).counts.unresolved;
  const streak = require('./statsService').currentHonestStreak({ db, clock });

  return {
    date,
    serverToday: today,
    carriedOver: Boolean(carriedOver),
    reflections: created.map(toApiShape),
    explainedTaskIds: targets.map((t) => t.task.id),
    remainingUnresolved: remaining,
    dayResolved: remaining === 0,
    honestDays: streak.current,
    message: 'Reason recorded.',
    note: "You don't need to justify it to us. You just needed to be honest with yourself.",
    nextStep: remaining === 0 ? 'Start today.' : 'You can explain the remaining promises too, or leave them for later.',
  };
}

/** Reflections for a date, or a range. */
function listReflections(db, { from = null, to = null, taskId = null, limit = 500 } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('date >= ?');
    params.push(validate.asDate(from, 'from'));
  }
  if (to) {
    clauses.push('date <= ?');
    params.push(validate.asDate(to, 'to'));
  }
  if (taskId !== null && taskId !== undefined) {
    clauses.push('task_id = ?');
    params.push(validate.asId(taskId, 'taskId'));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Math.max(Number(limit) || 500, 1), 2000));
  const rows = all(
    db,
    `SELECT * FROM reflections ${where} ORDER BY date DESC, id DESC LIMIT ?`,
    params
  );
  return rows.map(toApiShape);
}

/** Raw rows (used by analytics that need `date` in ISO form). */
function listReflectionRows(db, { from = null, to = null, limit = 2000 } = {}) {
  const clauses = [];
  const params = [];
  if (from) {
    clauses.push('date >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('date <= ?');
    params.push(to);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return all(db, `SELECT * FROM reflections ${where} ORDER BY date DESC, id DESC LIMIT ?`, params);
}

module.exports = {
  rowToReflection,
  toApiShape,
  submitReflection,
  listReflections,
  listReflectionRows,
  resolveReflectionDate,
  normalizeReason,
};
