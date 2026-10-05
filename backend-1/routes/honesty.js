'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { vDate } = require('../utils/validate');
const honestyService = require('../services/honestyService');
const { getClockContext } = require('../services/settingsService');

module.exports = function honestyRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/score',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const windowParam = req.query.window === undefined ? '30d' : String(req.query.window);
      ok(res, honestyService.getHonestScore(ctx.db, { clock, window: windowParam }));
    })
  );

  router.get(
    '/days',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const month = req.query.month !== undefined ? String(req.query.month) : undefined;
      const from = vDate(req.query.from, 'from');
      const to = vDate(req.query.to, 'to');
      if ((from && !to) || (!from && to)) {
        res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'Provide both "from" and "to", or neither.' },
          message: 'Provide both "from" and "to", or neither.',
        });
        return;
      }
      ok(res, honestyService.getHonestDays(ctx.db, { clock, month, from, to }));
    })
  );

  return router;
};
