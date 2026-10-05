'use strict';

/**
 * Day computation — the heart of the accountability model.
 *
 * For any local date we can reconstruct, from persisted data alone:
 *   - which promises existed that day (schedule rows covering the date, plus
 *     completion records as historical proof),
 *   - each promise's state: completed / missed_explained / missed_unexplained
 *     / incomplete (today) / excused (off day),
 *   - the day's status:
 *       green       all promises completed
 *       yellow      misses exist but every one is honestly explained
 *       red         at least one unexplained miss (day unresolved)
 *       off         off day (no promises owed)
 *       no_promises nothing scheduled
 *       pending     today while still open
 *       future      after today
 *
 * The completed / explained / unexplained distinction is fundamental to this
 * product and is never collapsed anywhere downstream.
 */

const { badRequest } = require('../utils/errors');
const { isValidDateString, weekdayOf, addDays } = require('../utils/dates');
const { parseSelectedDays } = require('./taskService');

const MAX_RANGE_DAYS = 366;

/** Does this schedule row put the task on dateStr? (inclusive [start, end]) */
function scheduleMatchesDay(schedule, dateStr) {
  if (schedule.start_date > dateStr) return false;
  if (schedule.end_date && dateStr > schedule.end_date) return false;
  if (schedule.repeat_type === 'daily') return true;
  if (schedule.repeat_type === 'one_time') return schedule.start_date === dateStr;
  if (schedule.repeat_type === 'selected_days') {
    const days = parseSelectedDays(schedule.selected_days) || [];
    return days.includes(weekdayOf(dateStr));
  }
  return false;
}

function isTaskScheduledOn(db, taskId, dateStr) {
  // A completion record is historical proof the promise existed that day,
  // even if the schedule was edited afterwards.
  const completion = db.get('SELECT id FROM completions WHERE task_id = ? AND date = ?', taskId, dateStr);
  if (completion) return true;
  const schedules = db.all('SELECT * FROM task_schedules WHERE task_id = ?', taskId);
  return schedules.some((s) => scheduleMatchesDay(s, dateStr));
}

function getEarliestDataDate(db) {
  const row = db.get('SELECT MIN(start_date) AS earliest FROM task_schedules');
  return row && row.earliest ? row.earliest : null;
}

function minimumCompletionFromTaskRow(task) {
  if (!task.minimum_completion_text && task.minimum_completion_value == null) return null;
  return {
    text: task.minimum_completion_text ?? null,
    value: task.minimum_completion_value ?? null,
    unit: task.minimum_completion_unit ?? null,
  };
}

function buildOccurrence(task, status, completion, reflection) {
  return {
    taskId: task.id,
    name: task.name,
    category: task.category,
    repeatType: task.repeat_type,
    minimumCompletion: minimumCompletionFromTaskRow(task),
    reminderTime: task.reminder_time ?? null,
    accountabilityTime: task.accountability_time ?? null,
    status,
    completedAt: completion ? completion.completed_at : null,
    minutesSpent: completion ? completion.minutes_spent ?? null : null,
    note: completion ? completion.note ?? null : null,
    reflection: reflection
      ? { id: reflection.id, reason: reflection.reason, createdAt: reflection.created_at }
      : null,
  };
}

function computeOccurrences(dateStr, { tasks, schedules, completions, reflections, offDay }, { clock }) {
  const compByTask = new Map(completions.map((c) => [c.task_id, c]));
  const reflByTask = new Map(
    reflections.filter((r) => r.task_id !== null && r.task_id !== undefined).map((r) => [r.task_id, r])
  );
  const schedByTask = new Map();
  for (const s of schedules) {
    if (!schedByTask.has(s.task_id)) schedByTask.set(s.task_id, []);
    schedByTask.get(s.task_id).push(s);
  }

  const list = [];
  for (const task of tasks) {
    const completion = compByTask.get(task.id) || null;
    const scheduled = (schedByTask.get(task.id) || []).some((s) => scheduleMatchesDay(s, dateStr));
    if (!scheduled && !completion) continue;
    const reflection = reflByTask.get(task.id) || null;

    let status;
    if (offDay) status = completion ? 'completed' : 'excused';
    else if (completion) status = 'completed';
    else if (dateStr < clock.todayDate) status = reflection ? 'missed_explained' : 'missed_unexplained';
    else status = 'incomplete'; // today, day still open

    list.push(buildOccurrence(task, status, completion, reflection));
  }
  return list.sort((a, b) => a.taskId - b.taskId);
}

function summarizeOccurrences(dateStr, occurrences, offDay, { clock }) {
  const promised = occurrences.filter((o) => o.status !== 'excused');
  const completed = promised.filter((o) => o.status === 'completed').length;
  const missedExplained = promised.filter((o) => o.status === 'missed_explained').length;
  const missedUnexplained = promised.filter((o) => o.status === 'missed_unexplained').length;
  const incomplete = promised.filter((o) => o.status === 'incomplete').length;

  let status;
  if (offDay) status = 'off';
  else if (promised.length === 0) status = 'no_promises';
  else if (completed === promised.length) status = 'green';
  else if (dateStr === clock.todayDate) status = 'pending';
  else if (missedUnexplained === 0) status = 'yellow';
  else status = 'red';

  return {
    status,
    counts: {
      promised: promised.length,
      completed,
      missed: missedExplained + missedUnexplained,
      explained: missedExplained,
      unexplained: missedUnexplained,
      incomplete,
      excused: occurrences.length - promised.length,
    },
  };
}

function offDayPublic(row) {
  return {
    id: row.id,
    date: row.date,
    reason: row.reason,
    note: row.note ?? null,
    activatedAt: row.activated_at,
  };
}

/** Compact day summary reused by many endpoints. */
function daySummary(detail) {
  return {
    date: detail.date,
    status: detail.status,
    resolved: detail.resolved,
    honestDay: detail.honestDay,
    counts: detail.counts,
  };
}

function loadDayData(db, dateStr) {
  return {
    tasks: db.all('SELECT * FROM tasks ORDER BY id'),
    schedules: db.all('SELECT * FROM task_schedules'),
    completions: db.all('SELECT * FROM completions WHERE date = ?', dateStr),
    reflections: db.all('SELECT * FROM reflections WHERE date = ?', dateStr),
    offDay: db.get('SELECT * FROM off_days WHERE date = ?', dateStr) || null,
  };
}

function getDayDetail(db, dateStr, { clock }) {
  if (!isValidDateString(dateStr)) {
    throw badRequest('INVALID_DATE', 'Invalid date. Use YYYY-MM-DD.');
  }
  const data = loadDayData(db, dateStr);
  const offDay = data.offDay ? offDayPublic(data.offDay) : null;

  if (dateStr > clock.todayDate) {
    return {
      date: dateStr,
      status: 'future',
      isFuture: true,
      resolved: null,
      honestDay: null,
      offDay,
      dayReflection: null,
      tasks: [],
      counts: { promised: 0, completed: 0, missed: 0, explained: 0, unexplained: 0, incomplete: 0, excused: 0 },
    };
  }

  const occurrences = computeOccurrences(dateStr, data, { clock });
  const { status, counts } = summarizeOccurrences(dateStr, occurrences, data.offDay, { clock });
  const dayReflectionRow = data.reflections.find((r) => r.task_id === null || r.task_id === undefined) || null;

  return {
    date: dateStr,
    status,
    isFuture: false,
    offDay,
    dayReflection: dayReflectionRow
      ? { id: dayReflectionRow.id, reason: dayReflectionRow.reason, createdAt: dayReflectionRow.created_at }
      : null,
    tasks: occurrences,
    counts,
    resolved: status === 'pending' ? null : status !== 'red',
    honestDay: status === 'green' || status === 'yellow' ? true : status === 'red' ? false : null,
  };
}

/** Summaries for a date range (single batch of queries, computed in memory). */
function getDaysRange(db, from, to, { clock }) {
  if (!isValidDateString(from) || !isValidDateString(to)) {
    throw badRequest('INVALID_DATE', 'Invalid date range. Use YYYY-MM-DD.');
  }
  if (from > to) throw badRequest('INVALID_DATE', '"from" must not be after "to".');
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
  if (span > MAX_RANGE_DAYS) {
    throw badRequest('RANGE_TOO_LARGE', `Date range must be at most ${MAX_RANGE_DAYS} days.`);
  }

  const tasks = db.all('SELECT * FROM tasks ORDER BY id');
  const schedules = db.all('SELECT * FROM task_schedules');
  const completions = db.all('SELECT * FROM completions WHERE date BETWEEN ? AND ?', from, to);
  const reflections = db.all('SELECT * FROM reflections WHERE date BETWEEN ? AND ?', from, to);
  const offDays = db.all('SELECT * FROM off_days WHERE date BETWEEN ? AND ?', from, to);
  const offByDate = new Map(offDays.map((o) => [o.date, o]));
  const compByDate = new Map();
  for (const c of completions) {
    if (!compByDate.has(c.date)) compByDate.set(c.date, []);
    compByDate.get(c.date).push(c);
  }
  const reflByDate = new Map();
  for (const r of reflections) {
    if (!reflByDate.has(r.date)) reflByDate.set(r.date, []);
    reflByDate.get(r.date).push(r);
  }

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (d > clock.todayDate) {
      days.push({
        date: d,
        status: 'future',
        resolved: null,
        honestDay: null,
        counts: { promised: 0, completed: 0, missed: 0, explained: 0, unexplained: 0, incomplete: 0, excused: 0 },
        offDay: offByDate.has(d),
      });
      continue;
    }
    const dayData = {
      tasks,
      schedules,
      completions: compByDate.get(d) || [],
      reflections: reflByDate.get(d) || [],
      offDay: offByDate.get(d) || null,
    };
    const occurrences = computeOccurrences(d, dayData, { clock });
    const { status, counts } = summarizeOccurrences(d, occurrences, dayData.offDay, { clock });
    days.push({
      date: d,
      status,
      resolved: status === 'pending' ? null : status !== 'red',
      honestDay: status === 'green' || status === 'yellow' ? true : status === 'red' ? false : null,
      counts,
      offDay: !!dayData.offDay,
    });
  }
  return days;
}

module.exports = {
  MAX_RANGE_DAYS,
  scheduleMatchesDay,
  isTaskScheduledOn,
  getEarliestDataDate,
  getDayDetail,
  getDaysRange,
  daySummary,
  offDayPublic,
};
