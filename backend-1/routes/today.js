'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { getClockContext } = require('../services/settingsService');
const { getTodayState } = require('../services/accountabilityService');
const { getDayDetail } = require('../services/dayService');
const { formatDateHuman } = require('../utils/dates');
const { vDate } = require('../utils/validate');

/** Frontend-compatible flat projection of /api/today. */
function flatToday(state) {
  return {
    date: formatDateHuman(state.todayDate),
    isoDate: state.todayDate,
    honestDays: state.honestDays,
    isOffDay: !!state.offDay,
    offDayReason: state.offDay ? state.offDay.reason : null,
    nightCheckActive: ['accountability', 'grace_ended', 'final_warning'].includes(state.phase) && !state.offDay,
    hasUnresolvedYesterday: state.yesterday.resolved === false,
    unresolvedYesterdayTasks: state.yesterday.unexplainedTasks.map((t) => ({
      id: t.taskId,
      title: t.name,
      definition: t.minimumCompletion ? t.minimumCompletion.text : null,
      category: t.category,
    })),
    tasks: state.tasks.map((t) => ({
      id: t.taskId,
      title: t.name,
      name: t.name,
      definition: t.minimumCompletion ? t.minimumCompletion.text : null,
      category: t.category,
      completed: t.status === 'completed',
      status: t.status,
      overdue: t.overdue,
      accountabilityTime: t.effectiveAccountabilityTime,
      repeat: t.repeatType,
      selectedDays: t.selectedDays,
      reminder: t.reminderTime,
    })),
    phase: state.phase,
    canStartToday: state.canStartToday,
    message: state.messages.phase ? state.messages.phase.title : null,
  };
}

module.exports = function todayRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const state = getTodayState(ctx.db, { clock });
      ok(res, state, flatToday(state));
    })
  );

  router.get(
    '/tasks',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const state = getTodayState(ctx.db, { clock });
      ok(res, { date: state.todayDate, tasks: state.tasks, counts: state.counts });
    })
  );

  router.get(
    '/summary',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const state = getTodayState(ctx.db, { clock });
      ok(res, {
        todayDate: state.todayDate,
        phase: state.phase,
        counts: state.counts,
        yesterday: state.yesterday,
        canStartToday: state.canStartToday,
        honestDays: state.honestDays,
        messages: state.messages,
      });
    })
  );

  return router;
};
