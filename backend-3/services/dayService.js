'use strict';

const { all } = require('../database/helpers');
const time = require('../utils/time');
const validate = require('../utils/validate');
const taskService = require('./taskService');
const occurrenceService = require('./occurrenceService');
const offDayService = require('./offDayService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Daily state = the backend's authoritative answer to "what is today?".
 *
 * It decides today's date, which promises belong to it, which are complete,
 * which were missed and explained, which are still unresolved, whether the
 * previous day is properly closed, and whether a reflection is required before
 * the new day can begin.
 *
 * Nothing here reads the browser clock, and nothing here trusts a client
 * supplied date for anything the backend can derive itself.
 */

const DAY_STATUS = {
  ACTIVE: 'active',
  COMPLETED: 'completed',
  EXPLAINED: 'explained',
  UNRESOLVED: 'unresolved',
  OFF_DAY: 'offday',
  EMPTY: 'empty',
};

/**
 * The promises that belong to a date, merged with their durable occurrence
 * record and the day's off-day state.
 *
 * `cache` (optional Map) avoids recomputing the same day repeatedly inside one
 * request - streak and report calculations walk many days at once.
 */
function getDayTasks(db, date, cache = null) {
  validate.asDate(date, 'date', { required: true });
  if (cache && cache.has(date)) return cache.get(date);

  const runtime = getRuntimeSettings(db);
  const tasks = all(db, 'SELECT * FROM tasks ORDER BY id ASC').map(taskService.rowToTask);

  const scheduled = tasks.filter((task) => taskService.promiseFallsOnDate(task, date));
  const seen = new Set(scheduled.map((t) => t.id));

  // One-time promises answered on this date (even if they were promised for an
  // earlier date) still belong to this day's history.
  const extraRows = all(
    db,
    `SELECT t.* FROM task_occurrences o
       JOIN tasks t ON t.id = o.task_id
      WHERE o.date = ? AND t.repeat_type = 'once' AND o.completed = 1`,
    [date]
  );
  for (const row of extraRows) {
    const task = taskService.rowToTask(row);
    if (!seen.has(task.id)) {
      seen.add(task.id);
      scheduled.push(task);
    }
  }

  const occurrences = new Map();
  for (const occ of occurrenceService.occurrencesForDate(db, date)) occurrences.set(occ.taskId, occ);

  const isOffDay = offDayService.isOffDay(db, date);
  const reflectionCount = all(
    db,
    'SELECT COUNT(*) AS n FROM reflections WHERE date = ?',
    [date]
  )[0].n;

  const items = scheduled
    .map((task) => {
      const occ = occurrences.get(task.id) || null;
      let state;
      if (isOffDay) state = 'off_day';
      else if (occ && occ.completed) state = occurrenceService.STATUS.COMPLETED;
      else if (occ && occ.reflected) state = occurrenceService.STATUS.MISSED_EXPLAINED;
      else if (occ) state = occurrenceService.STATUS.MISSED_UNEXPLAINED;
      else state = 'pending';

      // History first: an occurrence freezes the promise text at answer time.
      const displayTask = occ && occ.taskName
        ? {
            ...task,
            name: occ.taskName,
            minimumCompletion: occ.taskDefinition !== null ? occ.taskDefinition : task.minimumCompletion,
            category: occ.taskCategory || task.category,
          }
        : task;

      const completed = Boolean(occ && occ.completed);
      const explained = Boolean(occ && occ.reflected);
      const unresolved = !isOffDay && !(completed || explained);

      return {
        task,
        displayTask,
        occurrence: occ,
        state,
        completed,
        explained,
        unresolved,
        api: {
          ...taskService.toApiShape(displayTask, { completed, date, state }),
          pending: unresolved,
          accountabilityTime: taskService.effectiveAccountabilityTime(task, runtime),
        },
      };
    })
    .sort((a, b) => a.task.id - b.task.id);

  const completed = items.filter((i) => i.completed).length;
  const explained = items.filter((i) => i.explained).length;
  const unresolved = items.filter((i) => i.unresolved).length;

  const result = {
    date,
    isOffDay,
    offDay: offDayService.getOffDay(db, date),
    reflectionCount,
    hasReflection: reflectionCount > 0,
    items,
    counts: { total: items.length, completed, explained, unresolved, missed: explained + unresolved },
  };
  if (cache) cache.set(date, result);
  return result;
}

/**
 * Status of a day's accountability.
 *  completed  - every promise kept
 *  explained  - some missed, all honestly explained
 *  unresolved - at least one promise still unexplained
 *  offday     - declared off
 *  active     - today, with promises still open
 */
function dayStatus(db, date, { isToday = false, cache = null } = {}) {
  const day = getDayTasks(db, date, cache);
  if (day.isOffDay) return DAY_STATUS.OFF_DAY;
  if (day.counts.total === 0) return DAY_STATUS.EMPTY;
  // The current day is never "finished": it is still in progress, even when
  // every promise so far has been kept.
  if (isToday) return DAY_STATUS.ACTIVE;
  if (day.counts.unresolved > 0) return DAY_STATUS.UNRESOLVED;
  if (day.counts.explained > 0) return DAY_STATUS.EXPLAINED;
  return DAY_STATUS.COMPLETED;
}

/** A day is "closed" when nothing on it is left unexplained. */
function isDayClosed(db, date, cache = null) {
  const day = getDayTasks(db, date, cache);
  if (day.isOffDay) return true;
  return day.counts.unresolved === 0;
}

/**
 * Minutes between a promise's accountability time and the next daily reset.
 * This is the window in which "you still have N unfinished promises" applies:
 * it opens at the accountability time and closes at the reset.
 */
function graceWindowMinutes(runtime, accountabilityTime) {
  const [aH, aM] = String(accountabilityTime).split(':').map(Number);
  const [rH, rM] = String(runtime.dailyReset).split(':').map(Number);
  const acc = aH * 60 + aM;
  const reset = rH * 60 + rM;
  const span = (reset - acc + 1440) % 1440;
  return span === 0 ? 1440 : span;
}

/**
 * Is a promise inside its accountability/grace window at this instant?
 * The promise becomes accountable at its accountability time and stays
 * accountable until the daily reset. The grace period can extend that window,
 * never shorten it.
 */
function isWithinAccountabilityWindow(runtime, accountabilityTime, minutesNow) {
  const [aH, aM] = String(accountabilityTime).split(':').map(Number);
  const acc = aH * 60 + aM;
  const window = Math.max(graceWindowMinutes(runtime, accountabilityTime), runtime.gracePeriod);
  const diff = (minutesNow - acc + 1440) % 1440;
  return diff <= window;
}

/** Has the day's configured accountability moment arrived? */
function accountabilityReached(runtime, minutesNow) {
  return isWithinAccountabilityWindow(runtime, runtime.accountabilityTime, minutesNow);
}

/**
 * Is the carry-over window open for "yesterday"?
 *
 * From the daily reset until the grace period expires, yesterday's unresolved
 * promises can still be finished - which is what makes "15 minutes left. You
 * can still finish them. Or tell yourself why you didn't." honest rather than
 * decorative. After the grace period, yesterday can only be explained.
 */
function carryOverOpen(runtime, minutesNow) {
  return minutesNow <= runtime.gracePeriod;
}

/** Every date before today that still has an unexplained miss. */
function unresolvedBefore(db, today) {
  return occurrenceService.unresolvedDatesBefore(db, today);
}

/**
 * Full daily state - the payload behind GET /api/today and GET /api/day.
 *
 * @param {object} deps { db, clock }
 * @param {string|null} dateInput optional date to inspect (defaults to today)
 * @param {object} extra  { honestDays } injected by callers that already computed it
 */
function buildDayState({ db, clock }, dateInput = null, extra = {}) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const date = dateInput ? validate.asDate(dateInput, 'date') : today;
  const minutesNow = clock.minutesSinceMidnight(runtime.resolvedTimezone);
  const cache = new Map();

  const day = getDayTasks(db, date, cache);
  const status = dayStatus(db, date, { isToday: date === today, cache });

  // ----- Closure of the previous day / reflection requirement --------------
  const previousDate = time.shiftIsoDate(date, -1);
  const previousDay = getDayTasks(db, previousDate, cache);
  const allUnresolved = unresolvedBefore(db, date);
  const previousDayHasUnresolved = previousDay.counts.unresolved > 0;

  // The *new day* is gated by yesterday, because that is the day the user just
  // lived. Older unsettled days are surfaced as a backlog instead: they still
  // cost honest-day credit, but they do not hold today hostage, which is both
  // kinder and the only way "Start again" stays believable.
  const reflectionRequired = date === today && previousDayHasUnresolved;
  const backlogDates = allUnresolved.filter((d) => d < previousDate);
  const reflectionTargetDate = previousDayHasUnresolved ? previousDate : null;

  const carryOpen = date === today && carryOverOpen(runtime, minutesNow);

  const reflectionTargets = reflectionTargetDate
    ? previousDay.items.filter((i) => i.unresolved).map((i) => i.api)
    : [];

  const backlogDay = backlogDates.length > 0 ? getDayTasks(db, backlogDates[backlogDates.length - 1], cache) : null;
  const backlogTasks = backlogDay ? backlogDay.items.filter((i) => i.unresolved).map((i) => i.api) : [];

  // ----- Accountability / night check --------------------------------------
  const unfinishedToday = day.items.filter((i) => i.unresolved);
  const unfinishedTasks = date === today ? unfinishedToday : [];
  const nightCheckWindow = isWithinAccountabilityWindow(runtime, runtime.accountabilityTime, minutesNow);

  // A night check is worth showing when the accountability moment has arrived
  // and something is still outstanding: today's promises, or - inside the grace
  // period - yesterday's still unfinished ones.
  const nightCheckActive =
    date === today &&
    runtime.notifications !== false &&
    (nightCheckWindow || carryOpen) &&
    (unfinishedTasks.length > 0 || previousDayHasUnresolved);

  const accountableNow = unfinishedTasks.filter((i) =>
    isWithinAccountabilityWindow(runtime, taskService.effectiveAccountabilityTime(i.task, runtime), minutesNow)
  );

  const graceMinutesLeft = carryOpen ? runtime.gracePeriod - minutesNow : null;

  return {
    date,
    today,
    isToday: date === today,
    dateLabel: time.formatLongDate(date),
    status,
    isOffDay: day.isOffDay,
    offDayReason: day.offDay ? day.offDay.reason : null,
    offDay: day.offDay,
    tasks: day.items.map((i) => i.api),
    items: day.items,
    counts: day.counts,
    honestDays: extra.honestDays !== undefined ? extra.honestDays : null,
    accountability: {
      time: runtime.accountabilityTime,
      accountabilityTime: runtime.accountabilityTime,
      gracePeriod: runtime.gracePeriod,
      dailyReset: runtime.dailyReset,
      timezone: runtime.resolvedTimezone,
      timezoneSetting: runtime.timezone,
      localTime: clock.currentHhmm(runtime.resolvedTimezone),
      serverTimeUtc: time.nowIso(clock),
      nightCheckActive,
      accountabilityReached: accountabilityReached(runtime, minutesNow),
      carryOverWindowOpen: carryOpen,
      graceMinutesLeft,
      unfinishedCount: unfinishedTasks.length,
      accountableCount: accountableNow.length,
      windowClosesAt: runtime.dailyReset,
    },
    reflection: {
      required: reflectionRequired,
      hasUnresolvedYesterday: reflectionRequired,
      previousDate,
      targetDate: reflectionTargetDate,
      unresolvedCount: reflectionTargets.length,
      unresolvedDates: allUnresolved,
      targets: reflectionTargets,
      canStillCompleteYesterday: carryOpen && previousDayHasUnresolved,
      backlog: {
        dates: backlogDates,
        count: backlogDates.length,
        oldestDate: backlogDates.length > 0 ? backlogDates[0] : null,
        newestDate: backlogDates.length > 0 ? backlogDates[backlogDates.length - 1] : null,
        tasks: backlogTasks,
      },
    },
    // Compact flags kept for the documented frontend contract.
    nightCheckActive,
    hasUnresolvedYesterday: reflectionRequired,
    unresolvedYesterdayTasks: reflectionTargets,
    canStartNewDay: !reflectionRequired,
    previousDayClosed: !previousDayHasUnresolved,
    olderUnresolvedDates: backlogDates,
  };
}

module.exports = {
  DAY_STATUS,
  getDayTasks,
  dayStatus,
  isDayClosed,
  buildDayState,
  unresolvedBefore,
  carryOverOpen,
  isWithinAccountabilityWindow,
  accountabilityReached,
  graceWindowMinutes,
};
