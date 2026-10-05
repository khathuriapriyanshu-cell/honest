'use strict';

const { all } = require('../database/helpers');
const { ApiError } = require('../utils/errors');
const time = require('../utils/time');
const validate = require('../utils/validate');
const dayService = require('./dayService');
const reflectionService = require('./reflectionService');
const statsService = require('./statsService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Calendar history.
 *
 * Each day carries a status derived from real occurrence rows:
 *    completed   all promises kept
 *    explained   misses, all honestly explained
 *    unresolved  at least one promise left unexplained
 *    offday      day declared off
 *    active      today, with promises still open
 *    empty       nothing was promised that day
 *    future      the day has not happened yet
 *
 * Nothing is cached: history is recomputed from the database every time, so an
 * edit, a reflection or an off day is reflected immediately.
 */

function statusForDate(db, date, today) {
  if (date > today) return 'future';
  const status = dayService.dayStatus(db, date, { isToday: date === today });
  if (status === dayService.DAY_STATUS.ACTIVE) return 'active';
  return status;
}

/**
 * Month overview - the payload behind GET /api/calendar?month=&year=
 * Days with nothing recorded are omitted rather than invented.
 */
function monthHistory({ db, clock }, { month, year }) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const nowParts = today.split('-').map(Number);

  const targetYear = year === undefined || year === null || year === '' ? nowParts[0] : validate.asInt(year, 'year', { min: 1970, max: 2200 });
  const targetMonth = month === undefined || month === null || month === '' ? nowParts[1] : validate.asInt(month, 'month', { min: 1, max: 12 });

  const first = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const last = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(
    time.daysInMonth(targetYear, targetMonth)
  ).padStart(2, '0')}`;

  const cache = new Map();
  const history = {};

  for (const date of time.enumerateDates(first, last)) {
    if (date > today) continue;
    const day = dayService.getDayTasks(db, date, cache);
    const status = statusForDate(db, date, today);
    if (status === 'empty') continue;

    const entry = {
      status,
      completed: day.counts.completed,
      total: day.counts.total,
      missed: day.counts.missed,
      explained: day.counts.explained,
      unresolved: day.counts.unresolved,
    };
    if (day.isOffDay) entry.offDayReason = day.offDay ? day.offDay.reason : null;

    const reflections = all(
      db,
      'SELECT reason FROM reflections WHERE date = ? ORDER BY id ASC LIMIT 1',
      [date]
    );
    if (reflections.length > 0) entry.reflection = reflections[0].reason;

    history[date] = entry;
  }

  const monthStats = statsService.countHonestDays(db, first, last > today ? today : last);

  // Counted from the map that is actually returned, so the summary can never
  // disagree with the per-day entries the frontend renders.
  const statuses = Object.values(history);
  const emptyDays = statuses.filter((h) => h.status === 'empty').length;

  return {
    month: time.formatMonthLabel(targetYear, targetMonth),
    monthNumber: targetMonth,
    year: targetYear,
    monthStart: first,
    monthEnd: last,
    today,
    timezone: runtime.resolvedTimezone,
    history,
    summary: {
      // Days with promises recorded, excluding off days (nothing was promised).
      daysTracked: monthStats.trackedDays - statuses.filter((h) => h.status === 'offday').length,
      honestDays: monthStats.honestDays,
      completedDays: statuses.filter((h) => h.status === 'completed').length,
      explainedDays: statuses.filter((h) => h.status === 'explained').length,
      unresolvedDays: statuses.filter((h) => h.status === 'unresolved').length,
      activeDays: statuses.filter((h) => h.status === 'active').length,
      offDays: statuses.filter((h) => h.status === 'offday').length,
      emptyDays,
    },
  };
}

/** Detailed breakdown of one day - the payload behind GET /api/calendar/day/:date */
function dayDetail({ db, clock }, dateInput) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const date = validate.asDate(dateInput, 'date');

  if (date > today) {
    throw ApiError.badRequest('DATE_IN_FUTURE', `${date} has not happened yet, so there is no history for it.`, {
      date,
      serverToday: today,
    });
  }

  const day = dayService.getDayTasks(db, date);

  const tasks = day.items.map((item) => ({
    id: String(item.task.id),
    taskId: item.task.id,
    title: item.displayTask.name,
    name: item.displayTask.name,
    category: item.displayTask.category,
    definition: item.displayTask.minimumCompletion || null,
    completed: item.completed,
    explained: item.explained,
    unresolved: item.unresolved,
    state: item.state,
    completedAt: item.occurrence ? item.occurrence.completedAt : null,
    reflectedAt: item.occurrence ? item.occurrence.reflectedAt : null,
  }));

  const reflections = all(db, 'SELECT * FROM reflections WHERE date = ? ORDER BY id ASC', [date]).map(
    reflectionService.toApiShape
  );

  const offDay = day.isOffDay
    ? { reason: day.offDay.reason, activatedAt: day.offDay.activatedAt }
    : null;

  return {
    date,
    dateLabel: time.formatLongDate(date),
    status: statusForDate(db, date, today),
    completed: day.counts.completed,
    total: day.counts.total,
    missed: day.counts.missed,
    explained: day.counts.explained,
    unresolved: day.counts.unresolved,
    tasks,
    reflection: reflections.length > 0 ? reflections.map((r) => r.reason).join(' | ') : null,
    reflections,
    isOffDay: day.isOffDay,
    offDay,
    isHonestDay: statsService.isHonestDay(db, date),
    timezone: runtime.resolvedTimezone,
  };
}

/** History for a range (used by reports / exports). */
function rangeHistory({ db, clock }, { from, to }) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const fromDate = validate.asDate(from, 'from');
  const toDate = validate.asDate(to, 'to');
  if (fromDate > toDate) throw ApiError.badRequest('INVALID_RANGE', '"from" must not be after "to".');

  const cache = new Map();
  const days = [];
  for (const date of time.enumerateDates(fromDate, toDate)) {
    const day = dayService.getDayTasks(db, date, cache);
    days.push({
      date,
      status: statusForDate(db, date, today),
      completed: day.counts.completed,
      total: day.counts.total,
      missed: day.counts.missed,
      explained: day.counts.explained,
      unresolved: day.counts.unresolved,
      isOffDay: day.isOffDay,
      isHonestDay: statsService.isHonestDay(db, date, cache),
    });
  }
  return { from: fromDate, to: toDate, timezone: runtime.resolvedTimezone, days };
}

module.exports = { monthHistory, dayDetail, rangeHistory, statusForDate };
