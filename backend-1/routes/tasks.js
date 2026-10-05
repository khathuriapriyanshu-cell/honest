'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { vIdParam } = require('../utils/validate');
const taskService = require('../services/taskService');
const completionService = require('../services/completionService');
const { getClockContext } = require('../services/settingsService');

/** Frontend-compatible flat projection of a created task. */
function flatTask(detail) {
  return {
    id: detail.id,
    title: detail.name,
    name: detail.name,
    definition: detail.minimumCompletion ? detail.minimumCompletion.text : null,
    category: detail.category,
    repeat: detail.repeatType,
    selectedDays: detail.selectedDays,
    reminder: detail.reminderTime,
    accountabilityTime: detail.accountabilityTime,
    completed: false,
    isActive: detail.isActive,
  };
}

module.exports = function tasksRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const includeInactive = req.query.includeInactive === 'true';
      ok(res, { tasks: taskService.listTasks(ctx.db, { includeInactive }) });
    })
  );

  router.post(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const task = taskService.createTask(ctx.db, req.body, { clock });
      ok(res, { task }, { task: flatTask(task) }, 201);
    })
  );

  router.get(
    '/:id',
    wrap(async (req, res) => {
      const id = vIdParam(req.params.id, 'task id');
      ok(res, { task: taskService.getTaskDetail(ctx.db, id) });
    })
  );

  router.patch(
    '/:id',
    wrap(async (req, res) => {
      const id = vIdParam(req.params.id, 'task id');
      const clock = getClockContext(ctx.db, ctx.now());
      const task = taskService.updateTask(ctx.db, id, req.body, { clock });
      ok(res, { task }, { task: flatTask(task) });
    })
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const id = vIdParam(req.params.id, 'task id');
      const clock = getClockContext(ctx.db, ctx.now());
      const task = taskService.deactivateTask(ctx.db, id, { clock });
      ok(res, { task, deactivated: true });
    })
  );

  router.post(
    '/:id/restore',
    wrap(async (req, res) => {
      const id = vIdParam(req.params.id, 'task id');
      const clock = getClockContext(ctx.db, ctx.now());
      const task = taskService.restoreTask(ctx.db, id, { clock });
      ok(res, { task });
    })
  );

  const complete = wrap(async (req, res) => {
    const id = vIdParam(req.params.id, 'task id');
    const clock = getClockContext(ctx.db, ctx.now());
    const result = completionService.completeTask(ctx.db, id, req.body, { clock });
    ok(res, result, {
      task: { id, completed: true, date: result.date, status: result.task ? result.task.status : 'completed' },
    });
  });
  router.put('/:id/complete', complete);
  router.post('/:id/complete', complete);

  const uncomplete = wrap(async (req, res) => {
    const id = vIdParam(req.params.id, 'task id');
    const clock = getClockContext(ctx.db, ctx.now());
    const result = completionService.uncompleteTask(ctx.db, id, req.body, { clock });
    ok(res, result, { task: { id, completed: false, date: result.date } });
  });
  router.put('/:id/uncomplete', uncomplete);
  router.post('/:id/uncomplete', uncomplete);

  return router;
};
