'use strict';

const express = require('express');
const { ok, created } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const taskService = require('../services/taskService');
const occurrenceService = require('../services/occurrenceService');
const dayService = require('../services/dayService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Promise (task) routes.
 *
 * GET    /api/tasks                  list promises
 * POST   /api/tasks                  create a promise
 * GET    /api/tasks/:id              one promise + today's state for it
 * PUT    /api/tasks/:id              update a promise
 * PATCH  /api/tasks/:id              partial update (same handler)
 * DELETE /api/tasks/:id              deactivate (default) or delete (?hard=true)
 * PUT    /api/tasks/:id/complete     "I actually did this"
 * PUT    /api/tasks/:id/uncomplete   undo today's completion
 */

function stateForTask(deps, task) {
  const { db, clock } = deps;
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  if (!taskService.promiseFallsOnDate(task, today)) return null;
  const day = dayService.getDayTasks(db, today);
  const item = day.items.find((i) => i.task.id === task.id);
  return item ? item.api : null;
}

function createTaskRoutes(deps) {
  const router = express.Router();

  router.get('/tasks', (req, res) => {
    const status = queryValue(req, 'status') || 'all';
    const repeat = queryValue(req, 'repeat');
    const category = queryValue(req, 'category');
    const tasks = taskService.listTasks(deps, { status, repeat, category });
    return ok(res, { count: tasks.length, tasks });
  });

  router.post('/tasks', (req, res) => {
    const task = taskService.createTask(deps, req.body);
    return created(res, { task });
  });

  router.get('/tasks/:id', (req, res) => {
    const task = taskService.getTask(deps.db, req.params.id);
    return ok(res, { task, today: stateForTask(deps, task) });
  });

  const update = (req, res) => {
    const task = taskService.updateTask(deps, req.params.id, req.body);
    return ok(res, { task, today: stateForTask(deps, task) });
  };

  router.put('/tasks/:id', update);
  router.patch('/tasks/:id', update);

  router.delete('/tasks/:id', (req, res) => {
    const hard = queryValue(req, 'hard') === 'true';
    const result = taskService.deactivateTask(deps, req.params.id, { hard });
    return ok(res, result);
  });

  const complete = (req, res) => {
    const date = queryValue(req, 'date') || (req.body ? req.body.date : null);
    const result = occurrenceService.completeTask(deps, req.params.id, { date });
    return ok(res, {
      task: result.task,
      occurrence: result.occurrence,
      date: result.date,
      state: result.occurrence.status,
      message: `"${result.task.title}" is marked done for ${result.date}.`,
    });
  };

  router.put('/tasks/:id/complete', complete);
  router.post('/tasks/:id/complete', complete);

  const uncomplete = (req, res) => {
    const date = queryValue(req, 'date') || (req.body ? req.body.date : null);
    const result = occurrenceService.uncompleteTask(deps, req.params.id, { date });
    return ok(res, {
      task: result.task,
      occurrence: result.occurrence,
      date: result.date,
      state: result.occurrence.status,
      message: `"${result.task.title}" is no longer marked done for ${result.date}.`,
    });
  };

  router.put('/tasks/:id/uncomplete', uncomplete);
  router.post('/tasks/:id/uncomplete', uncomplete);

  return router;
}

module.exports = { createTaskRoutes };
