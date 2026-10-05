'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { vIdParam, vDate } = require('../utils/validate');
const offDayService = require('../services/offDayService');
const { getClockContext } = require('../services/settingsService');

module.exports = function offDayRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const from = vDate(req.query.from, 'from');
      const to = vDate(req.query.to, 'to');
      ok(res, { offDays: offDayService.listOffDays(ctx.db, { from, to }) });
    })
  );

  // Canonical: explicit date required.
  router.post(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const result = offDayService.activateOffDay(ctx.db, req.body, { clock });
      ok(res, result, { offDay: result.offDay, day: result.day }, 201);
    })
  );

  router.delete(
    '/:id',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      ok(res, offDayService.deleteOffDay(ctx.db, vIdParam(req.params.id, 'off day id'), { clock }));
    })
  );

  return router;
};

/** Frontend alias: POST /api/off-day { reason } -> activates for TODAY. */
module.exports.offDayAliasRouter = function offDayAliasRoutes(ctx2) {
  const router = express.Router();

  const handler = wrap(async (req, res) => {
    const clock = getClockContext(ctx2.db, ctx2.now());
    const body = { ...(req.body || {}) };
    if (!body.date) body.date = clock.todayDate;
    const result = offDayService.activateOffDay(ctx2.db, body, { clock });
    ok(res, result, { reason: result.offDay.reason, date: result.offDay.date, day: result.day }, 201);
  });
  router.post('/', handler);
  router.delete('/', handler);

  return router;
};
