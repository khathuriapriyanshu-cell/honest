'use strict';

const { all, get, run } = require('../database/helpers');
const time = require('../utils/time');
const validate = require('../utils/validate');
const dayService = require('./dayService');
const offDayService = require('./offDayService');
const taskService = require('./taskService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Notification / accountability engine.
 *
 * The backend owns the schedule. On every tick (and on every read) it decides
 * which accountability events *should* exist for the current instant, then
 * persists the ones that are new. `dedupe_key` is a UNIQUE column, so an event
 * fires exactly once per day even across restarts, and a restart can never
 * spam the user with yesterday's reminders.
 *
 * Events
 * ------
 *  reminder:<task>:<date>          a promise's own reminder time has arrived
 *  accountability:<date>           "Be honest with yourself. You still have N..."
 *  grace_warning:<date>            "N minutes left. You can still finish them..."
 *  yesterday_unresolved:<date>     "Yesterday is waiting for an explanation."
 *  carry_over:<date>               inside the grace window, yesterday can still
 *                                  be finished (honest, not punitive)
 *
 * Messages are never shaming: they state facts and leave the choice open.
 */

const EVENTS = {
  REMINDER: 'reminder',
  ACCOUNTABILITY: 'accountability',
  GRACE_WARNING: 'grace_warning',
  YESTERDAY_UNRESOLVED: 'yesterday_unresolved',
  CARRY_OVER: 'carry_over',
};

function plural(count, singular, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
}

function minutesLabel(minutes) {
  if (minutes <= 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hourLabel = `${hours} ${plural(hours, 'hour')}`;
  return rest === 0 ? hourLabel : `${hourLabel} ${rest} ${plural(rest, 'minute')}`;
}

/** Pending accountability notifications as they would fire right now. */
function computeEvents({ db, clock }) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const minutesNow = clock.minutesSinceMidnight(runtime.resolvedTimezone);
  const nowIso = time.nowIso(clock);
  const events = [];

  const day = dayService.getDayTasks(db, today);
  const unfinished = day.items.filter((item) => item.unresolved);

  // Grace period ends at the daily reset; `gracePeriod` is measured backwards
  // from that reset, which is what makes "15 minutes left" exact.
  const graceEndsAt = hhmmToMinutes(runtime.dailyReset);
  const graceStartsAt = (graceEndsAt - runtime.gracePeriod + 1440) % 1440;

  // --- per-promise reminders ------------------------------------------------
  for (const item of day.items) {
    const reminder = item.task.reminder;
    if (!reminder || item.completed || item.explained || day.isOffDay) continue;
    // A reminder fires once its own time of day has arrived, and stays in the
    // 24h window afterwards. If the promise is answered later, the event is
    // already stored - the notification list only ever describes the past
    // honestly rather than being silently rewritten.
    const reminderAt = hhmmToMinutes(reminder);
    if (minutesNow >= reminderAt) {
      events.push({
        kind: EVENTS.REMINDER,
        dedupeKey: `reminder:${item.task.id}:${today}`,
        date: today,
        message: `"${item.displayTask.name}" is still waiting for you today.`,
        payload: { taskId: item.task.id, reminder },
      });
    }
  }

  if (day.isOffDay) {
    // Off day: promises are suspended, no accountability pressure at all.
    return { events, runtime, today, unfinished, day };
  }

  const accountabilityAt = hhmmToMinutes(runtime.accountabilityTime);
  const countyUnfinished = unfinished.length;

  // --- the accountability check --------------------------------------------
  if (countyUnfinished > 0) {
    const reached = dayService.accountabilityReached(runtime, minutesNow);
    if (reached) {
      events.push({
        kind: EVENTS.ACCOUNTABILITY,
        dedupeKey: `accountability:${today}`,
        date: today,
        message: `Be honest with yourself. You still have ${countyUnfinished} unfinished ${plural(
          countyUnfinished,
          'promise'
        )} today.`,
        payload: { unfinishedCount: countyUnfinished, accountabilityTime: runtime.accountabilityTime },
      });
    }

  // --- "N minutes left" before the reset -----------------------------------
    // The message belongs to the final stretch of the day, so it is only honest
    // once the accountability moment (or, for a late accountability time, the
    // grace window itself) is actually under way.
    const inGrace =
      runtime.gracePeriod > 0 &&
      (graceStartsAt <= graceEndsAt
        ? minutesNow >= graceStartsAt && minutesNow <= graceEndsAt
        : minutesNow >= graceStartsAt || minutesNow <= graceEndsAt);

    if (inGrace && dayService.accountabilityReached(runtime, minutesNow)) {
      const minutesLeft = Math.max(0, (graceEndsAt - minutesNow + 1440) % 1440);
      events.push({
        kind: EVENTS.GRACE_WARNING,
        dedupeKey: `grace_warning:${today}`,
        date: today,
        message: `${minutesLabel(minutesLeft)} left. You can still finish ${plural(
          countyUnfinished,
          'it'
        )}. Or tell yourself why you didn't.`,
        payload: { minutesLeft, unfinishedCount: countyUnfinished },
      });
    }
  }

  // --- yesterday is waiting for an explanation ------------------------------
  const previousDate = time.shiftIsoDate(today, -1);
  const previousDay = dayService.getDayTasks(db, previousDate);
  const unresolvedPrevious = previousDay.items.filter((item) => item.unresolved);

  if (unresolvedPrevious.length > 0) {
    const count = unresolvedPrevious.length;
    events.push({
      kind: EVENTS.YESTERDAY_UNRESOLVED,
      dedupeKey: `yesterday_unresolved:${today}`,
      date: previousDate,
      message: `Yesterday is waiting for an explanation. ${count} ${plural(
        count,
        'promise'
      )} went unanswered.`,
      payload: { unresolvedCount: count, date: previousDate, tasks: unresolvedPrevious.map((t) => t.displayTask.name) },
    });

    // Inside the grace window yesterday can still be *finished*, not only
    // explained. Say so - that is the honest version of a deadline.
    const carryOpen = dayService.carryOverOpen(runtime, minutesNow);
    if (carryOpen) {
      events.push({
        kind: EVENTS.CARRY_OVER,
        dedupeKey: `carry_over:${today}`,
        date: previousDate,
        message: `You are still inside today's grace window: yesterday's promises can still be completed, or explained honestly.`,
        payload: { graceMinutesLeft: Math.max(0, runtime.gracePeriod - minutesNow), date: previousDate },
      });
    }
  }

  return { events, runtime, today, unfinished, day, nowIso };
}

/**
 * Persists any new events for the current instant.
 * Safe to call as often as you like: the UNIQUE dedupe_key makes it idempotent.
 */
function runSchedulerTick({ db, clock }) {
  const runtime = getRuntimeSettings(db);
  if (!runtime.notifications) {
    return { notificationsEnabled: false, created: 0 };
  }

  const { events, nowIso } = computeEvents({ db, clock });
  let created = 0;
  const insert = db.prepare(
    `INSERT INTO notification_log (dedupe_key, kind, date, message, payload, fired_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO NOTHING`
  );

  for (const event of events) {
    const result = insert.run(
      event.dedupeKey,
      event.kind,
      event.date || null,
      event.message,
      event.payload ? JSON.stringify(event.payload) : null,
      nowIso
    );
    if (result.changes > 0) created += 1;
  }

  return { notificationsEnabled: true, created, evaluated: events.length };
}

function rowToNotification(row) {
  return {
    id: String(row.id),
    notificationId: row.id,
    kind: row.kind,
    date: row.date,
    message: row.message,
    payload: row.payload ? taskService.safeJson(row.payload) : null,
    firedAt: row.fired_at,
    acknowledged: Boolean(row.acknowledged),
  };
}

/**
 * Active notifications: everything unacknowledged that fired within the last
 * 24 hours, newest first. A first scheduler tick is run before reading so a
 * freshly started server reports the events that are true right now.
 */
function activeNotifications({ db, clock }, { limit = 5 } = {}) {
  runSchedulerTick({ db, clock });

  const since = new Date(clock.now().getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');

  const rows = all(
    db,
    `SELECT * FROM notification_log
      WHERE acknowledged = 0 AND fired_at >= ?
      ORDER BY fired_at DESC, id DESC
      LIMIT ?`,
    [since, Math.min(Math.max(Number(limit) || 5, 1), 50)]
  );
  return rows.map(rowToNotification);
}

function acknowledge(db, id) {
  const numId = validate.asId(id, 'id');
  const row = get(db, 'SELECT * FROM notification_log WHERE id = ?', [numId]);
  if (!row) {
    const { ApiError } = require('../utils/errors');
    throw ApiError.notFound('NOTIFICATION_NOT_FOUND', `No notification exists with id ${numId}.`);
  }
  run(db, 'UPDATE notification_log SET acknowledged = 1, acknowledged_at = ? WHERE id = ?', [
    new Date().toISOString(),
    numId,
  ]);
  return { id: numId, acknowledged: true };
}

function acknowledgeAll(db) {
  const result = run(db, 'UPDATE notification_log SET acknowledged = 1, acknowledged_at = ? WHERE acknowledged = 0', [
    new Date().toISOString(),
  ]);
  return { acknowledged: result.changes };
}

/** History of events (useful for debugging the accountability timeline). */
function notificationHistory(db, { limit = 50 } = {}) {
  return all(db, 'SELECT * FROM notification_log ORDER BY fired_at DESC, id DESC LIMIT ?', [limit]).map(
    rowToNotification
  );
}

module.exports = {
  EVENTS,
  computeEvents,
  runSchedulerTick,
  activeNotifications,
  acknowledge,
  acknowledgeAll,
  notificationHistory,
  rowToNotification,
  minutesLabel,
};
