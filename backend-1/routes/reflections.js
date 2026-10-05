'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { vIdParam, vDate } = require('../utils/validate');
const reflectionService = require('../services/reflectionService');
const { getClockContext } = require('../services/settingsService');
const { getAccountabilityState } = require('../services/accountabilityService');

module.exports = function reflectionRoutes(ctx) {
  const router = express.Router();

  router.post(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const result = reflectionService.submitReflection(ctx.db, req.body, { clock });
      ok(res, result, {
        success: true,
        message: result.message.title,
        day: result.day,
      });
    })
  );

  router.get(
    '/',
    wrap(async (req, res) => {
      const { date, from, to, taskId, limit } = req.query;
      const reflections = reflectionService.listReflections(ctx.db, {
        date: vDate(date, 'date'),
        from: vDate(from, 'from'),
        to: vDate(to, 'to'),
        taskId: taskId !== undefined ? vIdParam(taskId, 'taskId') : undefined,
        limit,
      });
      ok(res, { reflections });
    })
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const id = vIdParam(req.params.id, 'reflection id');
      ok(res, reflectionService.deleteReflection(ctx.db, id));
    })
  );

  return router;
};

/** Separate router mounted at /api/night-check (frontend contract). */
module.exports.nightCheckRouter = function nightCheckRoutes(ctx2) {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx2.db, ctx2.now());
      const state = getAccountabilityState(ctx2.db, { clock });
      const unfinished = state.unfinishedPromises.map((t) => {
        const detail = ctx2.db.get('SELECT * FROM tasks WHERE id = ?', t.taskId);
        return {
          id: t.taskId,
          title: t.name,
          definition:
            detail && (detail.minimum_completion_text || detail.minimum_completion_value != null)
              ? detail.minimum_completion_text
              : null,
          category: detail ? detail.category : null,
          overdue: t.overdue,
        };
      });
      ok(
        res,
        { state },
        {
          active: state.nightCheckActive,
          accountabilityTime: clock.settings.accountabilityTime,
          gracePeriodMinutes: clock.graceMinutes,
          unfinishedTasks: unfinished,
          yesterday: state.yesterday,
        }
      );
    })
  );

  router.post(
    '/reflect',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx2.db, ctx2.now());
      const result = reflectionService.reflectAuto(ctx2.db, req.body, { clock });
      ok(res, result, {
        message: result.message.title,
        day: result.day,
        reflectionsCount: result.reflections.length,
      });
    })
  );

  return router;
};
