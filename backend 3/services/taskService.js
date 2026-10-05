'use strict';

const { all, get, run } = require('../database/helpers');
const { ApiError } = require('../utils/errors');
const time = require('../utils/time');
const validate = require('../utils/validate');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Tasks == promises.
 *
 * A promise stores what was promised, how often it repeats, the minimum
 * definition of "done", and when accountability happens. The backend - not the
 * frontend - decides which promises belong to a given date (see
 * `promiseFallsOnDate`), which keeps recurrence logic in exactly one place.
 *
 * History safety: the promise row holds a `snapshot` of its content. When a
 * promise is completed (or explained) the snapshot is frozen onto the
 * occurrence/reflection, so editing a recurring promise later never rewrites
 * what past days actually said.
 */

const MAX_NAME = 200;
const MAX_DEFINITION = 500;
const MAX_CATEGORY = 60;

function parseDays(json, taskId) {
  try {
    const parsed = JSON.parse(json || '[]');
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
      .sort((a, b) => a - b);
  } catch (err) {
    throw new Error(`Task ${taskId} has a corrupt repeat_days value; database integrity was violated.`);
  }
}

function rowToTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    repeat: row.repeat_type,
    repeatDays: parseDays(row.repeat_days, row.id),
    reminder: row.reminder || null,
    accountabilityTime: row.accountability_time || null,
    minimumCompletion: row.minimum_completion || null,
    minimumCompletionSpec: row.minimum_completion_spec ? safeJson(row.minimum_completion_spec) : null,
    startDate: row.start_date,
    endDate: row.end_date || null,
    status: row.status,
    inactiveFrom: row.inactive_from || null,
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch (err) {
    return null;
  }
}

/** Frontend-facing shape for a promise on a specific date. */
function toApiShape(task, { completed = false, date = null, state = null, reflectionId = null } = {}) {
  return {
    id: String(task.id),
    taskId: task.id,
    title: task.name,
    name: task.name,
    definition: task.minimumCompletion || 'Complete as intended',
    minimumCompletion: task.minimumCompletion || null,
    category: task.category,
    repeat: task.repeat,
    repeatDays: task.repeatDays,
    reminder: task.reminder,
    accountabilityTime: task.accountabilityTime,
    completed: Boolean(completed),
    state,
    date,
    startDate: task.startDate,
    endDate: task.endDate,
    status: task.status,
    reflectionId,
    historical: null,
  };
}

function getTaskRow(db, id) {
  return get(db, 'SELECT * FROM tasks WHERE id = ?', [id]);
}

function getTask(db, id) {
  const numId = validate.asId(id, 'id');
  const row = getTaskRow(db, numId);
  if (!row) throw ApiError.notFound('TASK_NOT_FOUND', `No promise exists with id ${numId}.`);
  return rowToTask(row);
}

/** Does a promise occur on this calendar date? */
function promiseFallsOnDate(task, isoDate) {
  if (!time.isValidIsoDate(isoDate)) return false;
  if (isoDate < task.startDate) return false;
  if (task.inactiveFrom && isoDate >= task.inactiveFrom) return false;

  if (task.repeat === 'once') {
    // One-time promises are anchored to their scheduled date. They stay visible
    // until they are answered: either completed, or honestly explained.
    return isoDate === task.startDate;
  }

  if (task.endDate && isoDate > task.endDate) return false;

  const weekday = time.isoWeekdayFromDate(isoDate);
  if (task.repeat === 'daily') return true;
  if (task.repeat === 'selected') {
    const days = task.repeatDays.length > 0 ? task.repeatDays : [1, 2, 3, 4, 5, 6, 7];
    return days.includes(weekday);
  }
  return false;
}

/** Effective accountability time for a promise on a date (falls back to settings). */
function effectiveAccountabilityTime(task, runtime) {
  return task.accountabilityTime || runtime.accountabilityTime;
}

/**
 * Creates a promise.
 * Accepts `title` (frontend) or `name` (internal) for the promise text.
 */
function createTask({ db, clock }, input) {
  validate.requireObject(input, 'body');
  const runtime = getRuntimeSettings(db);

  const name = validate.asString(input.title ?? input.name, 'title', { min: 1, max: MAX_NAME });
  const minimumCompletion =
    input.definition === undefined && input.minimumCompletion === undefined
      ? null
      : validate.asString(input.definition ?? input.minimumCompletion, 'definition', {
          required: false,
          max: MAX_DEFINITION,
        });
  const category = validate.asString(input.category, 'category', {
    required: false,
    max: MAX_CATEGORY,
  }) || 'General';
  const repeat = validate.asRepeatType(input.repeat ?? 'daily', 'repeat', { required: false }) || 'daily';
  let repeatDays = validate.asWeekdayList(input.selectedDays ?? input.repeatDays ?? [], 'selectedDays', {
    required: false,
  });
  if (repeat !== 'selected') repeatDays = [];
  if (repeat === 'selected' && repeatDays.length === 0) {
    throw ApiError.badRequest(
      'REPEAT_DAYS_REQUIRED',
      'A promise with repeat "selected" needs at least one weekday in "selectedDays" (1 = Monday .. 7 = Sunday).'
    );
  }
  const reminder = validate.asTime(input.reminder, 'reminder', { required: false, fallback: null });
  const accountabilityTime = validate.asTime(input.accountabilityTime, 'accountabilityTime', {
    required: false,
    fallback: null,
  });

  const today = clock.today(runtime.resolvedTimezone);
  const startDate = input.startDate ? validate.asDate(input.startDate, 'startDate') : today;

  // A one-time promise lives on exactly one date. Recurring promises may also
  // carry an end date, which is how a whole period (a semester, a challenge)
  // gets promised and then stops cleanly without deleting the history.
  const endDate =
    repeat === 'once'
      ? validate.asDate(input.endDate, 'endDate', { required: false }) || startDate
      : validate.asDate(input.endDate, 'endDate', { required: false });

  if (endDate && endDate < startDate) {
    throw ApiError.badRequest('INVALID_DATE_RANGE', '"endDate" must not be before "startDate".', {
      startDate,
      endDate,
    });
  }

  const nowIso = time.nowIso(clock);
  const result = run(
    db,
    `INSERT INTO tasks
       (name, category, repeat_type, repeat_days, reminder, accountability_time,
        minimum_completion, minimum_completion_spec, start_date, end_date,
        created_at, updated_at, status, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 'user')
     RETURNING id`,
    [
      name,
      category,
      repeat,
      JSON.stringify(repeatDays),
      reminder,
      accountabilityTime,
      minimumCompletion,
      input.minimumCompletionSpec ? JSON.stringify(input.minimumCompletionSpec) : null,
      startDate,
      endDate,
      nowIso,
      nowIso,
    ]
  );

  const task = rowToTask(getTaskRow(db, Number(result.lastInsertRowid)));
  return toApiShape(task, { date: startDate });
}

/** Partial update. Recurrence edits never touch stored history. */
function updateTask({ db, clock }, id, patch) {
  validate.requireObject(patch, 'body');
  const taskId = validate.asId(id, 'id');
  const existingRow = getTaskRow(db, taskId);
  if (!existingRow) throw ApiError.notFound('TASK_NOT_FOUND', `No promise exists with id ${taskId}.`);
  const existing = rowToTask(existingRow);

  const fields = [];
  const params = [];

  if (patch.title !== undefined || patch.name !== undefined) {
    fields.push('name = ?');
    params.push(validate.asString(patch.title ?? patch.name, 'title', { min: 1, max: MAX_NAME }));
  }
  if (patch.definition !== undefined || patch.minimumCompletion !== undefined) {
    fields.push('minimum_completion = ?');
    params.push(
      validate.asString(patch.definition ?? patch.minimumCompletion, 'definition', {
        required: false,
        max: MAX_DEFINITION,
      })
    );
  }
  if (patch.category !== undefined) {
    fields.push('category = ?');
    params.push(
      validate.asString(patch.category, 'category', { required: false, max: MAX_CATEGORY }) || 'General'
    );
  }
  if (patch.repeat !== undefined) {
    const repeat = validate.asRepeatType(patch.repeat, 'repeat');
    fields.push('repeat_type = ?');
    params.push(repeat);
    if (repeat !== 'selected') {
      fields.push('repeat_days = ?');
      params.push('[]');
      if (repeat !== 'once') {
        fields.push('end_date = NULL');
      }
    }
  }
  if (patch.selectedDays !== undefined || patch.repeatDays !== undefined) {
    const days = validate.asWeekdayList(patch.selectedDays ?? patch.repeatDays, 'selectedDays', { required: false });
    const repeatAfter = patch.repeat !== undefined ? validate.asRepeatType(patch.repeat, 'repeat') : existing.repeat;
    if (repeatAfter === 'selected' && days.length === 0) {
      throw ApiError.badRequest('REPEAT_DAYS_REQUIRED', 'A "selected" repetition needs at least one weekday.');
    }
    fields.push('repeat_days = ?');
    params.push(JSON.stringify(days));
  }
  if (patch.reminder !== undefined) {
    fields.push('reminder = ?');
    params.push(validate.asTime(patch.reminder, 'reminder', { required: false, fallback: null }));
  }
  if (patch.accountabilityTime !== undefined) {
    fields.push('accountability_time = ?');
    params.push(validate.asTime(patch.accountabilityTime, 'accountabilityTime', { required: false, fallback: null }));
  }
  if (patch.status !== undefined) {
    const status = validate.asEnum(patch.status, 'status', ['active', 'inactive'], { normalise: (v) => v.toLowerCase() });
    fields.push('status = ?');
    params.push(status);
    if (status === 'inactive') {
      // Remember when it stopped, so recurrence halts without erasing history.
      const today = clock.today(getRuntimeSettings(db).resolvedTimezone);
      fields.push('inactive_from = ?');
      params.push(existing.inactiveFrom || time.shiftIsoDate(today, 1));
    } else {
      fields.push('inactive_from = NULL');
    }
  }

  if (fields.length === 0) {
    throw ApiError.badRequest('NO_UPDATES', 'No valid fields were supplied to update.');
  }

  fields.push('updated_at = ?');
  params.push(time.nowIso(clock));
  params.push(taskId);
  run(db, `UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, params);

  return toApiShape(rowToTask(getTaskRow(db, taskId)));
}

/**
 * Deactivates a promise (soft delete by default).
 *
 * History is preserved: occurrences and reflections stay in the database and
 * remain visible in the calendar. Use `hard: true` only to remove a promise
 * that was created by mistake - and even then the caller must confirm.
 */
function deactivateTask({ db, clock }, id, { hard = false } = {}) {
  const taskId = validate.asId(id, 'id');
  const row = getTaskRow(db, taskId);
  if (!row) throw ApiError.notFound('TASK_NOT_FOUND', `No promise exists with id ${taskId}.`);
  const task = rowToTask(row);

  const occurrenceCount = get(db, 'SELECT COUNT(*) AS n FROM task_occurrences WHERE task_id = ?', [taskId]).n;
  const reflectionCount = get(db, 'SELECT COUNT(*) AS n FROM reflections WHERE task_id = ?', [taskId]).n;

  if (hard) {
    if (occurrenceCount > 0 || reflectionCount > 0) {
      throw ApiError.conflict(
        'TASK_HAS_HISTORY',
        'This promise already has recorded history, so it cannot be erased. Deactivate it instead - the record stays honest.',
        { occurrences: occurrenceCount, reflections: reflectionCount }
      );
    }
    run(db, 'DELETE FROM tasks WHERE id = ?', [taskId]);
    return { id: taskId, deleted: true, mode: 'hard' };
  }

  const today = clock.today(getRuntimeSettings(db).resolvedTimezone);
  // Recurrence stops the day *after* deactivation, so the day on which the user
  // deactivated the promise is still part of the record: it keeps its calendar
  // entry, its completion state and its chance to be answered honestly.
  const stopFrom = time.shiftIsoDate(today, 1);
  run(db, "UPDATE tasks SET status = 'inactive', inactive_from = ?, updated_at = ? WHERE id = ?", [
    stopFrom,
    time.nowIso(clock),
    taskId,
  ]);
  return { id: taskId, deleted: true, mode: 'deactivated', inactiveFrom: stopFrom };
}

/** Lists promises with optional filters. */
function listTasks({ db }, { status = 'all', repeat = null, category = null } = {}) {
  const clauses = [];
  const params = [];
  if (status === 'active' || status === 'inactive') {
    clauses.push('status = ?');
    params.push(status);
  }
  if (repeat) {
    clauses.push('repeat_type = ?');
    params.push(validate.asRepeatType(repeat, 'repeat'));
  }
  if (category) {
    clauses.push('category = ?');
    params.push(validate.asString(category, 'category', { max: MAX_CATEGORY }));
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = all(db, `SELECT * FROM tasks ${where} ORDER BY status ASC, id DESC`, params);
  return rows.map((row) => toApiShape(rowToTask(row)));
}

module.exports = {
  createTask,
  updateTask,
  deactivateTask,
  listTasks,
  getTask,
  getTaskRow,
  rowToTask,
  toApiShape,
  promiseFallsOnDate,
  effectiveAccountabilityTime,
  safeJson,
};
