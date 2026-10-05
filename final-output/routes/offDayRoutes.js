'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const offDayService = require('../services/offDayService');
const dayService = require('../services/dayService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Off day routes.
 *
 * POST   /api/off-day          activate an off day (deadline enforced here)
 * GET    /api/off-day          current status (+ whether today can still be marked)
 * GET    /api/off-days         list off days
 * DELETE /api/off-day/:date    revoke a future off day
 *
 * The non-retroactive rule is enforced by the service, from the server clock
 * and the configured timezone. A client cannot talk its way past it.
 */

function createOffDayRoutes(deps) {
  const router = express.Router();

  router.get('/off-day', (req, res) => {
    const runtime = getRuntimeSettings(deps.db);
    const today = deps.clock.today(runtime.resolvedTimezone);
    const date = queryValue(req, 'date') || today;
    const status = offDayService.canActivateOffDay(deps, date);
    const current = offDayService.getOffDay(deps.db, today);
    return ok(res, {
      today,
      date,
      isOffDay: Boolean(current) && date === today,
      offDayReason: current && date === today ? current.reason : null,
      offDay: date === today ? current : offDayService.getOffDay(deps.db, date),
      canActivateToday: status.allowed,
      deadline: {
        localTime: status.deadlineLocalTime,
        instantUtc: status.deadlineAt,
        rule: 'An off day cannot be activated retroactively after its deadline.',
      },
      requestedDate: status,
      allowedReasons: require('../utils/validate').OFF_DAY_REASONS,
    });
  });

  router.post('/off-day', (req, res) => {
    const body = req.body || {};
    const result = offDayService.activateOffDay(deps, { reason: body.reason, date: body.date || null });
    const runtime = getRuntimeSettings(deps.db);
    const today = deps.clock.today(runtime.resolvedTimezone);
    const state = dayService.buildDayState(deps, result.activatedFor);
    return ok(res, {
      reason: result.offDay.reason,
      offDay: result.offDay,
      date: result.activatedFor,
      deadlineAt: result.deadlineAt,
      isOffDay: result.activatedFor === today,
      suspendedPromises: state.counts.total,
      message: `${result.activatedFor} is an off day: ${result.offDay.reason}. Promises for that day are suspended without penalty.`,
    });
  });

  router.get('/off-days', (req, res) => {
    const offDays = offDayService.listOffDays(deps.db, {
      from: queryValue(req, 'from'),
      to: queryValue(req, 'to'),
    });
    return ok(res, { count: offDays.length, offDays });
  });

  router.delete('/off-day/:date', (req, res) => {
    const result = offDayService.revokeOffDay(deps, req.params.date);
    return ok(res, { ...result, message: `The off day on ${result.date} has been revoked.` });
  });

  return router;
}

module.exports = { createOffDayRoutes };
