'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { getClockContext } = require('../services/settingsService');
const { getAccountabilityState, getActiveNotifications } = require('../services/accountabilityService');
const eventService = require('../services/eventService');

module.exports = function accountabilityRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/state',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      ok(res, getAccountabilityState(ctx.db, { clock }));
    })
  );

  router.get(
    '/events',
    wrap(async (req, res) => {
      const limit = req.query.limit;
      ok(res, { events: eventService.listEvents(ctx.db, { limit }) });
    })
  );

  return router;
};

/** Router mounted at /api/notifications (frontend contract). */
module.exports.notificationsRouter = function notificationsRoutes(ctx2) {
  const router = express.Router();
  router.get(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx2.db, ctx2.now());
      const notifications = getActiveNotifications(ctx2.db, { clock });
      ok(res, { notifications, now: clock.now.toISOString(), timezone: clock.timezone }, { notifications });
    })
  );
  return router;
};
