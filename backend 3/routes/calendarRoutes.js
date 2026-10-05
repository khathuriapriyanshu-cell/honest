'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const historyService = require('../services/historyService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Calendar / history routes.
 *
 * GET /api/calendar?month=&year=   month overview with per-day status
 * GET /api/calendar/day/:date      detailed breakdown of a single day
 * GET /api/history?from=&to=       flat range history (used by reports/exports)
 */

function createCalendarRoutes(deps) {
  const router = express.Router();

  router.get('/calendar', (req, res) => {
    const data = historyService.monthHistory(deps, {
      month: queryValue(req, 'month'),
      year: queryValue(req, 'year'),
    });
    return ok(res, data);
  });

  router.get('/calendar/day/:date', (req, res) => {
    const data = historyService.dayDetail(deps, req.params.date);
    return ok(res, data);
  });

  router.get('/history', (req, res) => {
    const runtime = getRuntimeSettings(deps.db);
    const today = deps.clock.today(runtime.resolvedTimezone);
    const data = historyService.rangeHistory(deps, {
      from: queryValue(req, 'from') || today,
      to: queryValue(req, 'to') || today,
    });
    return ok(res, data);
  });

  return router;
}

module.exports = { createCalendarRoutes };
