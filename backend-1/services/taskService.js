'use strict';

/**
 * Task (promise) management.
 *
 * Business rules:
 * - A task's repeat definition lives in `task_schedules` rows. Editing the
 *   repeat rule closes the current row (inclusive end date) and opens a new
 *   one effective from today (or a later explicit effectiveFrom). History
 *   before the effective date is immutable — later edits never rewrite which
 *   tasks belonged to a past date, and past completions always remain.
 * - Tasks cannot start in the past (that would fabricate history).
 * - DELETE = soft-deactivate: schedules close from today onward, history and
 *   completions are preserved. (A completed occurrence still shows for today.)
 * - Input accepts canonical keys (name/repeatType/reminderTime) and the
 *   bundled frontend's keys (title/repeat/definition/reminder).
 */

const { badRequest, notFound } = require('../utils/errors');
const { addDays } = require('../utils/dates');
const {
  fail,
  assertBodyObject,
  assertOnlyKeys,
  vString,
  vNumber,
  vDate,
  vTime,
  vIntArray,
  vEnum,
} = require('../utils/validate');

const REPEAT_TYPES = ['one_time', 'daily', 'selected_days'];

const TASK_INPUT_KEYS = [
  'name', 'title',
  'category',
  'repeatType', 'repeat',
  'selectedDays',
  'startDate', 'endDate', 'effectiveFrom',
  'reminderTime', 'reminder',
  'accountabilityTime',
  'minimumCompletion', 'definition',
];

/** Map frontend-friendly repeat labels onto canonical values. */
function normalizeRepeatType(raw, field) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const key = String(raw).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const map = {
    one_time: 'one_time', once: 'one_time', onetime: 'one_time',
    daily: 'daily',
    selected_days: 'selected_days', selected: 'selected_days',
  };
  const mapped = map[key];
  if (!mapped) throw fail(field, 'must be one of: one_time (once), daily, selected_days (selected).');
  return mapped;
}

function parseSelectedDays(json) {
  if (!json) return null;
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function validateSelectedDays(value, repeatType) {
  if (repeatType !== 'selected_days') {
    if (value !== undefined && value !== null) {
      throw fail('selectedDays', 'can only be set when the repeat type is "selected_days".');
    }
    return null;
  }
  const arr = vIntArray(value, 'selectedDays', { required: true, min: 0, max: 6, maxItems: 7 });
  if (!arr || arr.length === 0) {
    throw fail('selectedDays', 'must contain at least one weekday (0 = Sunday ... 6 = Saturday).');
  }
  return [...new Set(arr)].sort((a, b) => a - b);
}

function validateMinimumCompletion(mc, definitionFallback) {
  let obj = mc;
  if ((obj === undefined || obj === null) && definitionFallback !== undefined && definitionFallback !== null) {
    if (typeof definitionFallback !== 'string') throw fail('definition', 'must be a string.');
    obj = { text: definitionFallback };
  }
  if (obj === undefined || obj === null) return null;
  if (typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail('minimumCompletion', 'must be an object with optional text, value and unit.');
  }
  assertOnlyKeys(obj, ['text', 'value', 'unit'], 'minimumCompletion');
  const text = vString(obj.text, 'minimumCompletion.text', { max: 200 });
  const value = vNumber(obj.value, 'minimumCompletion.value', { min: 0, max: 100000 });
  const unit = vString(obj.unit, 'minimumCompletion.unit', { max: 30 });
  if (text === undefined && value === undefined) {
    throw fail('minimumCompletion', 'must include at least a text or a value.');
  }
  if (value !== undefined && value <= 0) throw fail('minimumCompletion.value', 'must be greater than 0.');
  return { text: text ?? null, value: value ?? null, unit: unit ?? null };
}

function minimumCompletionFromRow(row) {
  if (!row.minimum_completion_text && row.minimum_completion_value == null) return null;
  return {
    text: row.minimum_completion_text ?? null,
    value: row.minimum_completion_value ?? null,
    unit: row.minimum_completion_unit ?? null,
  };
}

function getTaskRow(db, id) {
  const row = db.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!row) throw notFound('TASK_NOT_FOUND', `Task ${id} does not exist.`);
  return row;
}

function getSchedules(db, taskId) {
  return db.all('SELECT * FROM task_schedules WHERE task_id = ? ORDER BY start_date, id', taskId);
}

function openSchedule(schedules) {
  return schedules.find((s) => !s.end_date) || schedules[schedules.length - 1] || null;
}

/** Close open schedules so they end the day before `effectiveFrom`; drop rows that would become empty. */
function closeSchedulesBefore(db, taskId, effectiveFrom) {
  const cutoff = addDays(effectiveFrom, -1);
  db.run(
    'UPDATE task_schedules SET end_date = ? WHERE task_id = ? AND (end_date IS NULL OR end_date > ?)',
    cutoff,
    taskId,
    cutoff
  );
  db.run('DELETE FROM task_schedules WHERE task_id = ? AND end_date < start_date', taskId);
}

function schedulePublic(s) {
  return {
    id: s.id,
    repeatType: s.repeat_type,
    selectedDays: parseSelectedDays(s.selected_days),
    startDate: s.start_date,
    endDate: s.end_date ?? null,
    createdAt: s.created_at,
  };
}

function taskPublic(row, schedules) {
  const open = openSchedule(schedules || []);
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    repeatType: open ? open.repeat_type : row.repeat_type,
    selectedDays: parseSelectedDays(open ? open.selected_days : row.selected_days),
    startDate: open ? open.start_date : null,
    endDate: open ? open.end_date ?? null : null,
    reminderTime: row.reminder_time ?? null,
    accountabilityTime: row.accountability_time ?? null,
    minimumCompletion: minimumCompletionFromRow(row),
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getTaskDetail(db, id) {
  const row = getTaskRow(db, id);
  const schedules = getSchedules(db, id);
  const completions = db.all(
    'SELECT * FROM completions WHERE task_id = ? ORDER BY date DESC, id DESC LIMIT 50',
    id
  );
  return {
    ...taskPublic(row, schedules),
    schedules: schedules.map(schedulePublic),
    recentCompletions: completions.map((c) => ({
      id: c.id,
      date: c.date,
      completedAt: c.completed_at,
      minutesSpent: c.minutes_spent ?? null,
      note: c.note ?? null,
    })),
  };
}

function listTasks(db, { includeInactive = false } = {}) {
  const rows = db.all('SELECT * FROM tasks ORDER BY created_at, id');
  const result = [];
  for (const row of rows) {
    if (!includeInactive && row.is_active !== 1) continue;
    result.push(taskPublic(row, getSchedules(db, row.id)));
  }
  return result;
}

function createTask(db, body, { clock }) {
  const input = assertBodyObject(body);
  assertOnlyKeys(input, TASK_INPUT_KEYS);

  const name = vString(input.name !== undefined ? input.name : input.title, 'name', {
    required: true,
    max: 100,
  });
  const category = vString(input.category, 'category', { max: 40, defaultValue: 'general' });
  const repeatType = normalizeRepeatType(
    input.repeatType !== undefined ? input.repeatType : input.repeat,
    'repeatType'
  );
  if (!repeatType) throw fail('repeatType', 'is required.');
  const selectedDays = validateSelectedDays(input.selectedDays, repeatType);
  const startDate = vDate(input.startDate, 'startDate', { defaultValue: clock.todayDate });
  if (startDate < clock.todayDate) {
    throw badRequest('DATE_IN_PAST', 'Tasks cannot start in the past — history stays honest.', [
      { field: 'startDate', message: `must be on or after today (${clock.todayDate}).` },
    ]);
  }
  const endDate = vDate(input.endDate, 'endDate');
  if (endDate && endDate < startDate) throw fail('endDate', 'must be on or after the start date.');
  const reminderTime = vTime(
    input.reminderTime !== undefined ? input.reminderTime : input.reminder,
    'reminderTime',
    { allowNull: true }
  );
  const accountabilityTime = vTime(input.accountabilityTime, 'accountabilityTime', { allowNull: true });
  const mc = validateMinimumCompletion(input.minimumCompletion, input.definition);

  const nowIso = clock.now.toISOString();
  const daysJson = selectedDays ? JSON.stringify(selectedDays) : null;
  const ins = db.run(
    `INSERT INTO tasks
       (name, category, repeat_type, selected_days, reminder_time, accountability_time,
        minimum_completion_text, minimum_completion_value, minimum_completion_unit,
        is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
    name,
    category,
    repeatType,
    daysJson,
    reminderTime ?? null,
    accountabilityTime ?? null,
    mc ? mc.text : null,
    mc ? mc.value : null,
    mc ? mc.unit : null,
    nowIso,
    nowIso
  );
  db.run(
    'INSERT INTO task_schedules (task_id, repeat_type, selected_days, start_date, end_date, created_at) VALUES (?,?,?,?,?,?)',
    ins.lastInsertRowid,
    repeatType,
    daysJson,
    startDate,
    endDate ?? null,
    nowIso
  );
  return getTaskDetail(db, ins.lastInsertRowid);
}

function updateTask(db, id, body, { clock }) {
  const existing = getTaskRow(db, id);
  const input = assertBodyObject(body);
  assertOnlyKeys(input, TASK_INPUT_KEYS);

  const name = vString(input.name !== undefined ? input.name : input.title, 'name', {
    max: 100,
    defaultValue: existing.name,
  });
  const category = vString(input.category, 'category', { max: 40, defaultValue: existing.category });
  const currentSchedules = getSchedules(db, id);
  const current = openSchedule(currentSchedules);

  const repeatType =
    normalizeRepeatType(
      input.repeatType !== undefined ? input.repeatType : input.repeat,
      'repeatType'
    ) ?? (current ? current.repeat_type : existing.repeat_type);
  let selectedDaysDefault;
  if (input.selectedDays !== undefined) {
    selectedDaysDefault = validateSelectedDays(input.selectedDays, repeatType);
  } else if (repeatType === 'selected_days') {
    selectedDaysDefault = parseSelectedDays(current ? current.selected_days : existing.selected_days) || [];
    if (selectedDaysDefault.length === 0) {
      throw fail('selectedDays', 'must contain at least one weekday (0 = Sunday ... 6 = Saturday).');
    }
  } else {
    selectedDaysDefault = null;
  }

  const startDate = vDate(input.startDate, 'startDate', {
    defaultValue: current ? current.start_date : clock.todayDate,
  });
  const endDate = vDate(input.endDate, 'endDate', { defaultValue: current ? current.end_date ?? undefined : undefined });
  if (endDate && endDate < startDate) throw fail('endDate', 'must be on or after the start date.');

  const effectiveFrom = vDate(input.effectiveFrom, 'effectiveFrom', { defaultValue: clock.todayDate });
  if (effectiveFrom < clock.todayDate) {
    throw badRequest('DATE_IN_PAST', 'Schedule changes cannot rewrite history. Changes apply from today onward.', [
      { field: 'effectiveFrom', message: `must be on or after today (${clock.todayDate}).` },
    ]);
  }

  const reminderTime = vTime(
    input.reminderTime !== undefined ? input.reminderTime : input.reminder,
    'reminderTime',
    { allowNull: true, defaultValue: undefined }
  );
  const accountabilityTime = vTime(input.accountabilityTime, 'accountabilityTime', {
    allowNull: true,
    defaultValue: undefined,
  });
  const mcInput =
    input.minimumCompletion !== undefined || input.definition !== undefined
      ? validateMinimumCompletion(
          input.minimumCompletion,
          input.minimumCompletion !== undefined ? undefined : input.definition
        )
      : undefined;

  const nowIso = clock.now.toISOString();
  const daysJson = selectedDaysDefault ? JSON.stringify(selectedDaysDefault) : null;

  // Detect a repeat-definition change vs the currently open schedule.
  const newDef = JSON.stringify([repeatType, daysJson, startDate, endDate ?? null]);
  const curDef = current
    ? JSON.stringify([
        current.repeat_type,
        current.selected_days ?? null,
        current.start_date,
        current.end_date ?? null,
      ])
    : null;
  if (newDef !== curDef) {
    closeSchedulesBefore(db, id, effectiveFrom > startDate ? effectiveFrom : startDate);
    db.run(
      'INSERT INTO task_schedules (task_id, repeat_type, selected_days, start_date, end_date, created_at) VALUES (?,?,?,?,?,?)',
      id,
      repeatType,
      daysJson,
      startDate > effectiveFrom ? startDate : effectiveFrom,
      endDate ?? null,
      nowIso
    );
  }

  db.run(
    `UPDATE tasks SET name = ?, category = ?, repeat_type = ?, selected_days = ?,
       reminder_time = ?, accountability_time = ?,
       minimum_completion_text = ?, minimum_completion_value = ?, minimum_completion_unit = ?,
       updated_at = ?
     WHERE id = ?`,
    name,
    category,
    repeatType,
    daysJson,
    reminderTime !== undefined ? reminderTime : existing.reminder_time ?? null,
    accountabilityTime !== undefined ? accountabilityTime : existing.accountability_time ?? null,
    mcInput !== undefined ? mcInput?.text ?? null : existing.minimum_completion_text ?? null,
    mcInput !== undefined ? mcInput?.value ?? null : existing.minimum_completion_value ?? null,
    mcInput !== undefined ? mcInput?.unit ?? null : existing.minimum_completion_unit ?? null,
    nowIso,
    id
  );
  return getTaskDetail(db, id);
}

/** Soft delete: schedules close yesterday; today onward the task no longer appears. */
function deactivateTask(db, id, { clock }) {
  const existing = getTaskRow(db, id);
  if (existing.is_active === 1) {
    closeSchedulesBefore(db, id, clock.todayDate);
    db.run('UPDATE tasks SET is_active = 0, updated_at = ? WHERE id = ?', clock.now.toISOString(), id);
  }
  return getTaskDetail(db, id);
}

function restoreTask(db, id, { clock }) {
  const existing = getTaskRow(db, id);
  if (existing.is_active !== 1) {
    db.run('UPDATE tasks SET is_active = 1, updated_at = ? WHERE id = ?', clock.now.toISOString(), id);
    const open = openSchedule(getSchedules(db, id));
    if (!open) {
      db.run(
        'INSERT INTO task_schedules (task_id, repeat_type, selected_days, start_date, end_date, created_at) VALUES (?,?,?,?,NULL,?)',
        id,
        existing.repeat_type,
        existing.selected_days,
        clock.todayDate,
        clock.now.toISOString()
      );
    }
  }
  return getTaskDetail(db, id);
}

module.exports = {
  REPEAT_TYPES,
  normalizeRepeatType,
  parseSelectedDays,
  getTaskRow,
  getSchedules,
  listTasks,
  getTaskDetail,
  createTask,
  updateTask,
  deactivateTask,
  restoreTask,
};
