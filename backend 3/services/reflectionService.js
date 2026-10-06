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
 * Validates a list of promise *names* supplied by a client.
 * Names are matched case-insensitively, ignoring surrounding whitespace, so a
 * mobile client can send the labels it displayed without knowing the ids.
 */
function asTaskNameList(value, field = 'missedTasks') {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) {
    validate.fail('INVALID_FIELD', `"${field}" must be an array of promise names.`);
  }
  const names = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      validate.fail('INVALID_FIELD', `"${field}" may only contain promise names (strings).`);
    }
    const clean = entry.trim();
    if (clean.length === 0) {
      validate.fail('INVALID_FIELD', `"${field}" may not contain an empty name.`);
    }
    names.push(clean);
  }
  return names;
}

function normalizeName(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A promise can only be explained while it is still unresolved. */
function requireUnresolved(item, date) {
  if (!item.unresolved) {
    throw ApiError.conflict(
      'TASK_ALREADY_RESOLVED',
      `"${item.displayTask.name}" on ${date} is already completed or explained.`,
      { taskId: item.task.id, date, state: item.state }
    );
  }
}

/**
 * Finds the promise an entry in `missedTasks` refers to.
 * Accepts either a promise name ("30 min Workout") or a numeric id ("3"), so
 * both clients can send what they naturally hold.
 */
function findItemByNameOrId(items, entry) {
  const byId = /^\d+$/.test(String(entry).trim()) ? Number(String(entry).trim()) : null;
  if (byId !== null) {
    const byIdMatch = items.find((item) => item.task.id === byId);
    if (byIdMatch) return byIdMatch;
  }
  const wanted = normalizeName(entry);
  const exact = items.find((item) => normalizeName(item.displayTask.name) === wanted);
  if (exact) return exact;
  // Fall back to the live name in case an occurrence froze an older wording.
  return items.find((item) => normalizeName(item.task.name) === wanted) || null;
}

/**
 * Submits an honest reflection for one or more missed promises.
 *
 * @param {object} deps { db, clock }
 * @param {object} input { reason, date?, taskIds?, missedTasks?, source? }
 */
function submitReflection({ db, clock }, input) {
  validate.requireObject(input, 'body');
  const reason = validate.asReflectionReason(input.reason ?? input.reflection, 'reason');
  const explicitIds = validate.asIdList(input.taskIds ?? input.task_ids, 'taskIds');
  const explicitNames = asTaskNameList(
    input.missedTasks ?? input.missed_tasks ?? input.tasks ?? null,
    'missedTasks'
  );
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
      requireUnresolved(item, date);
      targets.push(item);
    }
  } else if (explicitNames && explicitNames.length > 0) {
    targets = [];
    for (const name of explicitNames) {
      const item = findItemByNameOrId(day.items, name);
      if (!item) {
        throw ApiError.badRequest(
          'TASK_NOT_ON_DATE',
          `"${name}" is not part of ${date}, so it cannot be explained for that day.`,
          { missedTask: name, date, available: day.items.map((i) => i.displayTask.name) }
        );
      }
      requireUnresolved(item, date);
      if (!targets.includes(item)) targets.push(item);
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

/** Reflections for a date, or a range. Newest day first. */
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
  return groupByDay(rows);
}

/**
 * Groups reflection rows into one entry per day.
 *
 * One honest reason can cover several missed promises, so the day is the unit a
 * history view cares about: `{ date, reason, missedTasks: [...] }`. When a day
 * carries more than one reason they are joined, and every promise name is kept.
 */
function groupByDay(rows) {
  const days = new Map();
  for (const row of rows) {
    const shape = toApiShape(row);
    if (!days.has(shape.isoDate)) {
      days.set(shape.isoDate, {
        date: shape.isoDate,
        dateLabel: shape.date,
        reasons: [],
        tasks: [],
        reflectionIds: [],
        sources: [],
        createdAt: shape.createdAt,
      });
    }
    const day = days.get(shape.isoDate);
    if (shape.taskName && !day.tasks.some((entry) => entry.name === shape.taskName)) {
      day.tasks.push({ name: shape.taskName, taskId: shape.taskId });
    }
    day.reflectionIds.push(shape.id);
    if (!day.sources.includes(shape.source)) day.sources.push(shape.source);

    // Several promises can be explained with the same words (one submission) or
    // with different words (separate submissions). Store the distinct reasons so
    // a repeated sentence is never duplicated in the output.
    if (!day.reasons.includes(shape.reason)) day.reasons.push(shape.reason);
  }

  return (
    [...days.values()]
      .map((day) => {
        // Order the missed promises the way the day displayed them (id order)
        // so the same data always produces the same array.
        const orderedTasks = day.tasks
          .slice()
          .sort((a, b) => Number(a.taskId || 0) - Number(b.taskId || 0));

        return {
          date: day.date,
          isoDate: day.date,
          dateLabel: day.dateLabel,
          reason: day.reasons.join(' | '),
          missedTasks: orderedTasks.map((entry) => entry.name),
          missedTaskIds: orderedTasks.map((entry) => entry.taskId),
          reflectionIds: day.reflectionIds,
          reflectionCount: day.reflectionIds.length,
          sources: day.sources,
          createdAt: day.createdAt,
        };
      })
      // Newest day first, as the history view expects.
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  );
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
