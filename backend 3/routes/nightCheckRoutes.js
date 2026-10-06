'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const dayService = require('../services/dayService');
const reflectionService = require('../services/reflectionService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Night check & reflection routes.
 *
 * GET  /api/night-check          live accountability state for the evening check
 * POST /api/night-check/reflect  record an honest reason for missed promises
 * POST /api/reflections          same submission, resource-style alias
 * GET  /api/reflections          all reasons (newest first), filterable
 */

function createNightCheckRoutes(deps) {
  const router = express.Router();

  router.get('/night-check', (req, res) => {
    const { db, clock } = deps;
    const runtime = getRuntimeSettings(db);
    const date = queryValue(req, 'date');
    const state = dayService.buildDayState(deps, date);
    const minutesNow = clock.minutesSinceMidnight(runtime.resolvedTimezone);

    // Only promises that are still open count as "unfinished today".
    const open = state.items
      .filter((item) => item.unresolved)
      .map((item) => ({
        id: String(item.task.id),
        taskId: item.task.id,
        title: item.displayTask.name,
        name: item.displayTask.name,
        definition: item.displayTask.minimumCompletion || null,
        category: item.displayTask.category,
        accountabilityTime: item.api.accountabilityTime,
        // Has this promise reached its own accountability time yet?
        accountableNow: dayService.isWithinAccountabilityWindow(
          runtime,
          item.api.accountabilityTime,
          minutesNow
        ),
        pending: true,
      }));
    const overdue = open.filter((t) => t.accountableNow).map((t) => t.id);

    return ok(res, {
      active: state.nightCheckActive,
      date: state.date,
      accountabilityTime: runtime.accountabilityTime,
      gracePeriod: runtime.gracePeriod,
      dailyReset: runtime.dailyReset,
      minutesUntilReset: state.accountability.graceMinutesLeft,
      carryOverWindowOpen: state.accountability.carryOverWindowOpen,
      unfinishedTasks: open,
      unfinishedCount: open.length,
      overdueTaskIds: overdue,
      overdueCount: overdue.length,
      // The exact sentence the frontend displays, composed by the backend.
      message: `Be honest with yourself. You still have ${open.length} unfinished ${
        open.length === 1 ? 'promise' : 'promises'
      } today.`,
      reflection: state.reflection,
      canStillCompleteToday: open.length > 0 && state.accountability.carryOverWindowOpen !== false,
      serverTime: state.accountability.localTime,
      timezone: state.accountability.timezone,
    });
  });

  const reflect = (req, res) => {
    const body = req.body || {};
    const date = queryValue(req, 'date') || body.date || null;
    const result = reflectionService.submitReflection(deps, {
      reason: body.reason ?? body.reflection,
      date,
      // Accepts promise ids (web client) or promise names (mobile client).
      taskIds: body.taskIds ?? body.task_ids,
      missedTasks: body.missedTasks ?? body.missed_tasks ?? body.tasks,
      source: body.source,
    });
    return ok(res, result, 200, { message: result.message });
  };

  router.post('/night-check/reflect', reflect);
  router.post('/reflections', reflect);

  /**
   * GET /api/reflections
   *
   * Every recorded reason, newest day first, grouped by day:
   *
   *   data: [ { date, reason, missedTasks: [...] } ]
   *
   * A reason can cover several promises, so the day is the unit a history view
   * cares about. `data` is the array itself (as the mobile client expects) while
   * `reflections` mirrors it for clients written against the older key.
   */
  router.get('/reflections', (req, res) => {
    const days = reflectionService.listReflections(deps.db, {
      from: queryValue(req, 'from'),
      to: queryValue(req, 'to'),
      taskId: queryValue(req, 'taskId'),
      limit: queryValue(req, 'limit') || 200,
    });

    // Optional filters that only make sense per item, applied after grouping.
    const query = queryValue(req, 'q') || queryValue(req, 'query');
    const term = query ? query.toLowerCase() : null;
    const filtered = term
      ? days.filter(
          (day) =>
            day.reason.toLowerCase().includes(term) ||
            day.missedTasks.some((name) => name.toLowerCase().includes(term))
        )
      : days;

    return ok(
      res,
      { reflections: filtered, total: filtered.length, count: filtered.length },
      200,
      { data: filtered }
    );
  });

  return router;
}

module.exports = { createNightCheckRoutes };
