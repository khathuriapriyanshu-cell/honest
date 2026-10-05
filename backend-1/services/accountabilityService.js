'use strict';

/**
 * Daily accountability state — the backend's answer to "what is happening
 * right now, honestly?".
 *
 * Phases within an accountability day (all instants computed from settings +
 * server clock in the user's timezone):
 *   open            before the accountability time
 *   accountability  at/after the accountability time (the honest check-in)
 *   grace_ended     the grace window has closed; finishing is still possible
 *                   until the daily reset, but unresolved misses now owe a
 *                   reflection
 *   final_warning   the last `grace period` minutes before the daily reset
 *
 * The backend also decides whether yesterday is properly closed: if yesterday
 * has unexplained misses, `canStartToday` is false and a kind banner asks for
 * the reasons first. All messages are factual and never shaming.
 */

const {
  addDays,
  zonedTimeToInstant,
  parseTimeToMinutes,
  formatHHMM,
  localTimeInTz,
  formatDateHuman,
} = require('../utils/dates');
const { getDayDetail, daySummary } = require('./dayService');
const { offDayDeadlineFor } = require('./settingsService');
const { getHonestDays } = require('./honestyService');

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function buildMessages({ phase, counts, offDay, yesterday, clock }) {
  const messages = {};
  if (offDay) {
    messages.phase = {
      title: 'Rest day.',
      body: 'Today is an off day. No promises are owed — take care of yourself.',
    };
  } else if (counts.promised === 0) {
    messages.phase = {
      title: 'A clean slate.',
      body: 'No promises made for today yet. Add one when you are ready.',
    };
  } else if (counts.incomplete === 0) {
    messages.phase = {
      title: 'All promises kept today.',
      body: 'Everything you promised today is done. Be proud of that.',
    };
  } else if (phase === 'open') {
    messages.phase = {
      title: 'Keep going.',
      body: `${counts.completed} of ${counts.promised} promises kept so far. The day is still yours.`,
    };
  } else if (phase === 'accountability') {
    messages.phase = {
      title: 'Be honest with yourself.',
      body: `You still have ${plural(counts.incomplete, 'unfinished promise')} today.`,
      action: "Finish them — or tell yourself why you didn't.",
    };
  } else if (phase === 'grace_ended') {
    messages.phase = {
      title: 'The day is almost over.',
      body: `${plural(counts.incomplete, 'promise')} still unfinished. If you can finish them, do. If not, be ready to tell yourself why.`,
    };
  } else if (phase === 'final_warning') {
    const minutesLeft = Math.max(1, Math.round((clock.resetAt.getTime() - clock.now.getTime()) / 60000));
    messages.phase = {
      title: `${plural(minutesLeft, 'minute')} left.`,
      body: "You can still finish them. Or tell yourself why you didn't.",
    };
  }
  if (yesterday && yesterday.resolved === false) {
    messages.yesterday = {
      title: 'Yesterday is waiting for an explanation.',
      body: "Record your reasons for yesterday's missed promises, then start today fresh.",
    };
  }
  return messages;
}

function getTodayState(db, { clock }) {
  const todayDetail = getDayDetail(db, clock.todayDate, { clock });
  const yesterdayDate = addDays(clock.todayDate, -1);
  const yesterdayDetail = getDayDetail(db, yesterdayDate, { clock });

  const tasks = todayDetail.tasks.map((t) => {
    const effAccMin =
      t.accountabilityTime && parseTimeToMinutes(t.accountabilityTime) !== null
        ? parseTimeToMinutes(t.accountabilityTime)
        : clock.accountabilityMinutes;
    const effInstant = zonedTimeToInstant(clock.todayDate, effAccMin, clock.timezone);
    return {
      ...t,
      effectiveAccountabilityTime: formatHHMM(effAccMin),
      overdue: t.status === 'incomplete' && clock.now.getTime() >= effInstant.getTime(),
    };
  });

  const offDay = todayDetail.offDay;
  const unfinished = tasks.filter((t) => t.status === 'incomplete');
  const unexplainedYesterday = yesterdayDetail.tasks
    .filter((t) => t.status === 'missed_unexplained')
    .map((t) => ({ taskId: t.taskId, name: t.name, category: t.category, minimumCompletion: t.minimumCompletion }));

  const yesterday = {
    date: yesterdayDate,
    status: yesterdayDetail.status,
    resolved: yesterdayDetail.resolved,
    reflectionRequired: yesterdayDetail.resolved === false,
    counts: yesterdayDetail.counts,
    unexplainedTasks: unexplainedYesterday,
  };

  const deadline = offDayDeadlineFor(clock, clock.todayDate);
  const honesty = getHonestDays(db, { clock });

  return {
    now: clock.now.toISOString(),
    timezone: clock.timezone,
    timezoneSetting: clock.timezoneSetting,
    todayDate: clock.todayDate,
    localTime: localTimeInTz(clock.now, clock.timezone),
    phase: clock.phase,
    deadlines: {
      accountabilityAt: clock.accountabilityAt.toISOString(),
      graceEndAt: clock.graceEndAt.toISOString(),
      finalWarningAt: clock.finalWarningAt.toISOString(),
      resetAt: clock.resetAt.toISOString(),
    },
    notificationsEnabled: clock.notificationsEnabled,
    settings: {
      dailyResetTime: clock.settings.dailyResetTime,
      accountabilityTime: clock.settings.accountabilityTime,
      gracePeriodMinutes: clock.graceMinutes,
    },
    offDay,
    offDayWindow: {
      canActivateToday: !offDay && clock.now.getTime() < deadline.getTime(),
      deadlineAt: deadline.toISOString(),
    },
    counts: { ...todayDetail.counts, unfinishedPromises: unfinished.length },
    tasks,
    yesterday,
    canStartToday: yesterdayDetail.resolved !== false,
    todayProvisional:
      todayDetail.status === 'green'
        ? 'green_so_far'
        : todayDetail.status === 'pending'
          ? 'pending'
          : todayDetail.status === 'off'
            ? 'off'
            : 'none',
    honestDays: honesty.current,
    honestDaySoFar: todayDetail.honestDay,
    messages: buildMessages({ phase: clock.phase, counts: todayDetail.counts, offDay, yesterday, clock }),
  };
}

/** Focused subset for the accountability/notification state endpoints. */
function getAccountabilityState(db, { clock }) {
  const state = getTodayState(db, { clock });
  const order = { open: 0, accountability: 1, grace_ended: 2, final_warning: 3 };
  return {
    now: state.now,
    timezone: state.timezone,
    todayDate: state.todayDate,
    localTime: state.localTime,
    phase: state.phase,
    phaseLevel: order[state.phase],
    deadlines: state.deadlines,
    notificationsEnabled: state.notificationsEnabled,
    offDay: !!state.offDay,
    nightCheckActive: order[state.phase] >= 1 && !state.offDay,
    counts: {
      promised: state.counts.promised,
      completed: state.counts.completed,
      incomplete: state.counts.incomplete,
      unfinishedPromises: state.counts.unfinishedPromises,
    },
    unfinishedPromises: state.tasks
      .filter((t) => t.status === 'incomplete')
      .map((t) => ({ taskId: t.taskId, name: t.name, overdue: t.overdue })),
    yesterday: state.yesterday,
    canStartToday: state.canStartToday,
    messages: state.messages,
  };
}

/**
 * Time-based notification messages for the frontend. Derived entirely from
 * real state — the backend is the scheduler/authority; the frontend only
 * displays what applies right now.
 */
function getActiveNotifications(db, { clock }) {
  const state = getTodayState(db, { clock });
  if (!state.notificationsEnabled) return [];

  const notifications = [];
  if (state.yesterday.resolved === false) {
    notifications.push({
      id: 'yesterday-reflection',
      message: 'Yesterday is waiting for an explanation.',
    });
  }
  const order = { open: 0, accountability: 1, grace_ended: 2, final_warning: 3 };
  if (!state.offDay && order[state.phase] >= 1 && state.counts.unfinishedPromises > 0) {
    notifications.push({
      id: 'accountability-check',
      message: `Be honest with yourself. You still have ${plural(state.counts.unfinishedPromises, 'unfinished promise')} today.`,
    });
    if (state.phase === 'final_warning') {
      const minutesLeft = Math.max(1, Math.round((clock.resetAt.getTime() - clock.now.getTime()) / 60000));
      notifications.push({
        id: 'final-warning',
        message: `${plural(minutesLeft, 'minute')} left. You can still finish them. Or tell yourself why you didn't.`,
      });
    }
  }
  return notifications;
}

module.exports = { getTodayState, getAccountabilityState, getActiveNotifications };
