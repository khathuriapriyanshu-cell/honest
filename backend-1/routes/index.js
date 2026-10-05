'use strict';

/**
 * API surface. Two kinds of endpoints live side by side:
 *  - canonical endpoints (/api/tasks, /api/today, /api/honesty/..., etc.)
 *    designed for this backend's contract (documented in API.md);
 *  - alias endpoints matching the bundled frontend's expectations
 *    (/api/night-check, /api/off-day, /api/report/weekly, /api/stats/score,
 *    /api/archive, /api/insights, /api/notifications) — same business logic,
 *    flat response projections.
 */

const express = require('express');
const { ok } = require('../utils/respond');
const { localTimeInTz } = require('../utils/dates');

const tasksRoutes = require('./tasks');
const todayRoutes = require('./today');
const calendarRoutes = require('./calendar');
const reflectionRoutes = require('./reflections');
const { nightCheckRouter } = require('./reflections');
const offDayRoutes = require('./offdays');
const { offDayAliasRouter } = require('./offdays');
const reportRoutes = require('./reports');
const { reportAliasRouter, statsRouter, insightsRouter, archiveRouter } = require('./reports');
const honestyRoutes = require('./honesty');
const settingsRoutes = require('./settings');
const accountabilityRoutes = require('./accountability');
const { notificationsRouter } = require('./accountability');

module.exports = function buildApi(ctx) {
  const api = express.Router();

  api.get('/health', (req, res) => {
    const clock = require('../services/settingsService').getClockContext(ctx.db, ctx.now());
    ok(res, {
      status: 'ok',
      version: require('../package.json').version,
      serverTime: clock.now.toISOString(),
      timezone: clock.timezone,
      todayDate: clock.todayDate,
      localTime: localTimeInTz(clock.now, clock.timezone),
    });
  });

  api.get('/time', (req, res) => {
    const clock = require('../services/settingsService').getClockContext(ctx.db, ctx.now());
    ok(res, {
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
    });
  });

  api.use('/tasks', tasksRoutes(ctx));
  api.use('/today', todayRoutes(ctx));
  api.use('/calendar', calendarRoutes(ctx));
  api.use('/reflections', reflectionRoutes(ctx));
  api.use('/night-check', nightCheckRouter(ctx));
  api.use('/off-days', offDayRoutes(ctx));
  api.use('/off-day', offDayAliasRouter(ctx));
  api.use('/reports', reportRoutes(ctx));
  api.use('/report', reportAliasRouter(ctx));
  api.use('/stats', statsRouter(ctx));
  api.use('/insights', insightsRouter(ctx));
  api.use('/archive', archiveRouter(ctx));
  api.use('/honesty', honestyRoutes(ctx));
  api.use('/settings', settingsRoutes(ctx));
  api.use('/accountability', accountabilityRoutes(ctx));
  api.use('/notifications', notificationsRouter(ctx));

  return api;
};
