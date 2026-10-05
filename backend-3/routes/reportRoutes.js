'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const statsService = require('../services/statsService');
const insightService = require('../services/insightService');

/**
 * Reports & analytics routes.
 *
 * GET /api/report/weekly   weekly honesty report (7 days, per weekStart setting)
 * GET /api/stats/score     monthly Honest Score with its breakdown
 * GET /api/stats/honest-days  honest days: current streak, month, lifetime
 * GET /api/archive?q=      reflections archive + recurring-reason notice
 * GET /api/insights        deterministic behavioural patterns
 */

function createReportRoutes(deps) {
  const router = express.Router();

  router.get('/report/weekly', (req, res) => {
    const report = statsService.weeklyReport(deps, { date: queryValue(req, 'date') });
    return ok(res, report);
  });

  router.get('/stats/score', (req, res) => {
    return ok(
      res,
      statsService.monthlyScore(deps, {
        from: queryValue(req, 'from'),
        to: queryValue(req, 'to'),
      })
    );
  });

  router.get('/stats/honest-days', (req, res) => {
    return ok(res, statsService.honestDaysSummary(deps));
  });

  router.get('/archive', (req, res) => {
    const data = insightService.archive(deps, {
      q: queryValue(req, 'q') || queryValue(req, 'query'),
      from: queryValue(req, 'from'),
      to: queryValue(req, 'to'),
      limit: queryValue(req, 'limit'),
    });
    return ok(res, data);
  });

  router.get('/insights', (req, res) => {
    const data = insightService.insights(deps, { lookbackDays: queryValue(req, 'days') || 90 });
    return ok(res, data);
  });

  return router;
}

module.exports = { createReportRoutes };
