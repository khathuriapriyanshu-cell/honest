'use strict';

const { all, get, run, transaction } = require('../database/helpers');
const { ApiError } = require('../utils/errors');
const time = require('../utils/time');
const validate = require('../utils/validate');
const taskService = require('./taskService');
const { getRuntimeSettings } = require('./settingsService');
// Required lazily: dayService also depends on this module for occurrence reads,
// so a top-level require here would create a cycle. Node hands out the fully
// populated exports object on first use at runtime.
function dayService() {
  return require('./dayService');
}

/**
 * Task occurrences: the durable record of what actually happened to a promise
 * on a specific calendar date.
 *
 * Three states exist and are preserved everywhere in the backend:
 *   1. completed          - the promise was kept.
 *   2. missed_explained   - not kept, but honestly explained.
 *   3. missed_unexplained - not kept and still unresolved.
 *
 * (2) and (3) are deliberately different. A day whose misses were all explained
 * is an honest outcome; a day with unexplained misses is not closed.
 *
 * Each occurrence also freezes the promise text (`task_name` /
 * `task_definition` / `task_category`) at the moment it was answered, so editing
 * or deactivating a recurring promise later cannot rewrite past days.
 */

const STATUS = {
  COMPLETED: 'completed',
  MISSED_EXPLAINED: 'missed_explained',
  MISSED_UNEXPLAINED: 'missed_unexplained',
};

function rowToOccurrence(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    date: row.date,
    status: row.status,
    completed: Boolean(row.completed),
    reflected: Boolean(row.reflected),
    waiveReason: row.waive_reason || null,
    taskName: row.task_name || null,
    taskDefinition: row.task_definition || null,
    taskCategory: row.task_category || null,
    completedAt: row.completed_at || null,
    reflectedAt: row.reflected_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getOccurrence(db, taskId, date) {
  return rowToOccurrence(get(db, 'SELECT * FROM task_occurrences WHERE task_id = ? AND date = ?', [taskId, date]));
}

function occurrencesForDate(db, date) {
  return all(db, 'SELECT * FROM task_occurrences WHERE date = ?', [date]).map(rowToOccurrence);
}

function occurrencesForRange(db, from, to) {
  return all(
    db,
    'SELECT * FROM task_occurrences WHERE date >= ? AND date <= ? ORDER BY date ASC',
    [from, to]
  ).map(rowToOccurrence);
}

function deriveStatus(completed, reflected) {
  if (completed) return STATUS.COMPLETED;
  return reflected ? STATUS.MISSED_EXPLAINED : STATUS.MISSED_UNEXPLAINED;
}

/** Content of a promise, captured so history can be frozen. */
function contentOf(task) {
  return { name: task.name, definition: task.minimumCompletion, category: task.category };
}

/**
 * Creates or updates the occurrence row for (task, date).
 *
 * `completed` and `reflected` are the source of truth; `status` is always
 * derived from them so it can never drift out of sync.
 */
function upsertOccurrence(db, taskId, date, options, nowIso) {
  const { completed, reflected, waiveReason } = options;
  const timestamp = nowIso || new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const existing = get(db, 'SELECT * FROM task_occurrences WHERE task_id = ? AND date = ?', [taskId, date]);
  const nextCompleted = completed === undefined ? Boolean(existing && existing.completed) : Boolean(completed);
  const nextReflected = reflected === undefined ? Boolean(existing && existing.reflected) : Boolean(reflected);
  const status = deriveStatus(nextCompleted, nextReflected);

  const completedAt = nextCompleted ? (existing && existing.completed_at) || timestamp : null;
  const reflectedAt = nextReflected ? (existing && existing.reflected_at) || timestamp : null;

  // Frozen content: captured the first time this day is answered and kept.
  const frozen = options.content || null;
  const taskName = (existing && existing.task_name) || (frozen && frozen.name) || null;
  const taskDefinition = (existing && existing.task_definition) || (frozen && frozen.definition) || null;
  const taskCategory = (existing && existing.task_category) || (frozen && frozen.category) || null;

  if (existing) {
    run(
      db,
      `UPDATE task_occurrences
          SET status = ?, completed = ?, reflected = ?, waive_reason = ?,
              task_name = COALESCE(task_name, ?),
              task_definition = COALESCE(task_definition, ?),
              task_category = COALESCE(task_category, ?),
              completed_at = ?, reflected_at = ?, updated_at = ?
        WHERE id = ?`,
      [
        status,
        nextCompleted ? 1 : 0,
        nextReflected ? 1 : 0,
        waiveReason === undefined ? existing.waive_reason : waiveReason,
        taskName,
        taskDefinition,
        taskCategory,
        completedAt,
        reflectedAt,
        timestamp,
        existing.id,
      ]
    );
    return getOccurrence(db, taskId, date);
  }

  run(
    db,
    `INSERT INTO task_occurrences
       (task_id, date, status, completed, reflected, waive_reason,
        task_name, task_definition, task_category,
        completed_at, reflected_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      taskId,
      date,
      status,
      nextCompleted ? 1 : 0,
      nextReflected ? 1 : 0,
      waiveReason === undefined ? null : waiveReason,
      taskName,
      taskDefinition,
      taskCategory,
      completedAt,
      reflectedAt,
      timestamp,
      timestamp,
    ]
  );
  return getOccurrence(db, taskId, date);
}

/**
 * Which date does a completion belong to?
 *
 * - recurring promises: the day the backend currently considers active. Inside
 *   the grace window that follows the daily reset, the day the user is still
 *   working on is yesterday's (it is 00:05 and the promise was due last night),
 *   so an unqualified completion is attributed there;
 * - one-time promises: their scheduled date, unless that day has already passed
 *   and the promise is only being honoured now (then: today).
 */
function resolveCompletionDate(task, today, { carryOverOpen = false } = {}) {
  if (task.repeat === 'once') return task.startDate >= today ? task.startDate : today;
  return carryOverOpen ? time.shiftIsoDate(today, -1) : today;
}

/**
 * Can a completion for `date` be accepted at all for this promise?
 *
 * `withinGraceOfBoundary` is true while the user is still inside the grace
 * window that follows the daily reset. In that window a promise that belonged
 * to the previous day is still the one the user is working on (it is 00:05 and
 * the day only just turned over), so the previous day's date is accepted.
 * Outside that window the backend refuses to complete a past recurring day -
 * the honest way to close it then is a reflection, not a retcon.
 */
function completionDateAllowed(task, date, today, { withinGraceOfBoundary = false } = {}) {
  if (date > today) return { allowed: false, reason: 'future' };

  if (task.repeat === 'once') {
    // A one-time promise is answered on its date, or later if it was missed.
    return date >= task.startDate ? { allowed: true } : { allowed: false, reason: 'before_start' };
  }

  // --- recurring promises ---------------------------------------------------
  // The day the promise is being answered must be the day it was due.
  if (date === today) {
    return taskService.promiseFallsOnDate(task, date)
      ? { allowed: true }
      : { allowed: false, reason: 'not_scheduled' };
  }

  // Just past the daily reset, yesterday is still the day being worked on, so
  // yesterday's promise can still be honoured.
  if (withinGraceOfBoundary && date === time.shiftIsoDate(today, -1)) {
    return { allowed: true, graceBoundary: true };
  }

  // Anything older is history. A recurring promise is never back-filled: the
  // honest way to close a past day is a reflection, not a retcon.
  return {
    allowed: false,
    reason: 'closed',
    message:
      'That day is closed. A recurring promise can only be completed on the day it belongs to. An honest reflection is how a past day gets closed now.',
  };
}

/** Marks a promise complete for a date. */
function completeTask({ db, clock }, id, { date = null } = {}) {
  const taskId = validate.asId(id, 'id');
  const row = taskService.getTaskRow(db, taskId);
  if (!row) throw ApiError.notFound('TASK_NOT_FOUND', `No promise exists with id ${taskId}.`);
  const task = taskService.rowToTask(row);

  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const withinGraceOfBoundary = dayService().carryOverOpen(
    runtime,
    clock.minutesSinceMidnight(runtime.resolvedTimezone)
  );
  const targetDate = date
    ? validate.asDate(date, 'date')
    : resolveCompletionDate(task, today, { carryOverOpen: withinGraceOfBoundary });
  const nowIso = time.nowIso(clock);

  const check = completionDateAllowed(task, targetDate, today, { withinGraceOfBoundary });
  if (!check.allowed) {
    if (check.reason === 'future') {
      throw ApiError.badRequest(
        'COMPLETION_IN_FUTURE',
        'A promise cannot be marked complete for a date that has not happened yet.',
        { date: targetDate, serverToday: today }
      );
    }
    if (check.reason === 'closed') {
      throw ApiError.forbidden('DAY_CLOSED', check.message, { date: targetDate, serverToday: today });
    }
    throw ApiError.badRequest('TASK_NOT_SCHEDULED', `"${task.name}" is not scheduled for ${targetDate}.`, {
      taskId,
      date: targetDate,
      repeat: task.repeat,
      repeatDays: task.repeatDays,
    });
  }

  if (task.status !== 'active' && task.repeat !== 'once') {
    throw ApiError.conflict(
      'TASK_INACTIVE',
      'This promise is no longer active, so it cannot be completed. Reactivate it first.',
      { taskId }
    );
  }

  // Once the promise no longer exists as an active commitment, only that same
  // day may be answered - the past is not editable.
  if (task.repeat === 'once' && task.completedAt && targetDate !== task.startDate) {
    const already = getOccurrence(db, taskId, targetDate);
    if (!already) {
      throw ApiError.conflict('TASK_ALREADY_RESOLVED', 'This one-time promise has already been resolved.', {
        taskId,
        completedAt: task.completedAt,
      });
    }
  }

  const content = contentOf(task);

  const occurrence = transaction(db, () => {
    const occ = upsertOccurrence(db, taskId, targetDate, { completed: true, reflected: false, content }, nowIso);
    if (task.repeat === 'once') {
      run(
        db,
        "UPDATE tasks SET completed_at = ?, snapshot = ?, status = 'inactive', updated_at = ? WHERE id = ?",
        [nowIso, JSON.stringify(content), nowIso, taskId]
      );
    }
    return occ;
  });

  return {
    task: taskService.toApiShape(task, { completed: true, date: targetDate, state: STATUS.COMPLETED }),
    occurrence,
    date: targetDate,
  };
}

/** Undo a completion. Only allowed on the day the completion belongs to. */
function uncompleteTask({ db, clock }, id, { date = null } = {}) {
  const taskId = validate.asId(id, 'id');
  const row = taskService.getTaskRow(db, taskId);
  if (!row) throw ApiError.notFound('TASK_NOT_FOUND', `No promise exists with id ${taskId}.`);
  const task = taskService.rowToTask(row);

  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);

  let targetDate = date ? validate.asDate(date, 'date') : null;
  if (!targetDate) {
    const latest = get(
      db,
      'SELECT date FROM task_occurrences WHERE task_id = ? AND completed = 1 ORDER BY date DESC LIMIT 1',
      [taskId]
    );
    targetDate = latest ? latest.date : resolveCompletionDate(task, today);
  }

  const occurrence = getOccurrence(db, taskId, targetDate);
  if (!occurrence || !occurrence.completed) {
    throw ApiError.conflict('NOT_COMPLETED', `"${task.name}" is not marked complete for ${targetDate}.`, {
      taskId,
      date: targetDate,
    });
  }

  if (occurrence.reflected) {
    throw ApiError.conflict(
      'OCCURRENCE_HAS_REFLECTION',
      'This day already has a recorded reflection, so its completion state is locked. History stays honest once it is written.',
      { taskId, date: targetDate, occurrenceId: occurrence.id }
    );
  }

  // History is not editable: a completion can only be undone on the day it was
  // recorded.
  if (targetDate < today) {
    throw ApiError.forbidden(
      'UNDO_WINDOW_CLOSED',
      'A completion can only be undone on the day it was recorded. Past days are history.',
      { date: targetDate, serverToday: today }
    );
  }

  const nowIso = time.nowIso(clock);
  const result = transaction(db, () => {
    const occ = upsertOccurrence(db, taskId, targetDate, { completed: false, reflected: false }, nowIso);
    if (task.repeat === 'once') {
      // The promise is open again and will be offered as an overdue commitment
      // until it is answered.
      run(
        db,
        "UPDATE tasks SET completed_at = NULL, status = 'active', inactive_from = NULL, updated_at = ? WHERE id = ?",
        [nowIso, taskId]
      );
    }
    return occ;
  });

  return {
    task: taskService.toApiShape(task, { completed: false, date: targetDate, state: result.status }),
    occurrence: result,
    date: targetDate,
  };
}

/** Marks a promise on a date as honestly explained (used by reflection). */
function markExplained(db, taskId, date, nowIso, content) {
  return upsertOccurrence(db, taskId, date, { completed: false, reflected: true, content }, nowIso);
}

/**
 * Every date before `beforeDate` that still has an unexplained promise.
 *
 * The date list is the union of two sources, because a promise can be missed in
 * two very different ways:
 *   1. it was opened and left unanswered  -> an occurrence row says so;
 *   2. it was never opened at all         -> there is no row, and only the
 *      recurrence rule can tell us the promise was even due.
 *
 * Missing (2) would mean a silently skipped day never asked for a reflection,
 * which would gut the whole product. So past days are also reconstructed from
 * the schedule, bounded by `lookbackDays`.
 */
function unresolvedOccurrenceDatesBefore(db, beforeDate) {
  return all(
    db,
    `SELECT DISTINCT date FROM task_occurrences
      WHERE status = 'missed_unexplained' AND date < ?
      ORDER BY date ASC`,
    [beforeDate]
  ).map((r) => r.date);
}

/** Dates (before `beforeDate`) that have any recorded occurrence at all. */
function recordedDatesBefore(db, beforeDate) {
  return all(
    db,
    'SELECT DISTINCT date FROM task_occurrences WHERE date < ? ORDER BY date ASC',
    [beforeDate]
  ).map((r) => r.date);
}

/**
 * Union of "recorded as unresolved" and "was due but never answered".
 * Returns dates in ascending order.
 */
function unresolvedDatesBefore(db, beforeDate, { lookbackDays = 120 } = {}) {
  // Lazy require: dayService depends on this module for occurrence reads.
  const dayService = require('./dayService');

  const unresolved = new Set(unresolvedOccurrenceDatesBefore(db, beforeDate));
  const recorded = new Set(recordedDatesBefore(db, beforeDate));

  const earliest = all(db, 'SELECT MIN(start_date) AS d FROM tasks')[0];
  const firstDate = earliest && earliest.d ? earliest.d : null;

  // Only look as far back as there is anything to look at.
  const windowStart = time.shiftIsoDate(beforeDate, -Math.max(1, Math.min(Number(lookbackDays) || 120, 400)));
  const start = firstDate && firstDate > windowStart ? firstDate : windowStart;

  const cache = new Map();
  for (const date of time.enumerateDates(start, time.shiftIsoDate(beforeDate, -1))) {
    if (unresolved.has(date)) continue;
    const day = dayService.getDayTasks(db, date, cache);
    if (day.isOffDay || day.counts.total === 0) continue;
    if (day.counts.unresolved > 0) unresolved.add(date);
  }

  return [...unresolved].sort();
}

function unresolvedDates(db) {
  return all(
    db,
    `SELECT DISTINCT date FROM task_occurrences
      WHERE status = 'missed_unexplained'
      ORDER BY date ASC`
  ).map((r) => r.date);
}

/** Aggregate counts for a date range, optionally ignoring certain promises. */
function statsForRange(db, from, to, { excludeTaskIds = null } = {}) {
  const rows = all(
    db,
    `SELECT o.*, t.name AS live_name, t.category AS live_category
       FROM task_occurrences o
       JOIN tasks t ON t.id = o.task_id
      WHERE o.date >= ? AND o.date <= ?
      ORDER BY o.date ASC`,
    [from, to]
  ).filter((row) => !excludeTaskIds || !excludeTaskIds.has(row.task_id));

  let completed = 0;
  let explained = 0;
  let unexplained = 0;
  for (const row of rows) {
    if (row.status === STATUS.COMPLETED) completed += 1;
    else if (row.status === STATUS.MISSED_EXPLAINED) explained += 1;
    else unexplained += 1;
  }
  return { rows, completed, explained, unexplained, total: rows.length };
}

module.exports = {
  STATUS,
  rowToOccurrence,
  getOccurrence,
  occurrencesForDate,
  occurrencesForRange,
  upsertOccurrence,
  completeTask,
  uncompleteTask,
  markExplained,
  resolveCompletionDate,
  completionDateAllowed,
  deriveStatus,
  statsForRange,
  unresolvedDates,
  unresolvedDatesBefore,
  unresolvedOccurrenceDatesBefore,
  recordedDatesBefore,
  contentOf,
};
