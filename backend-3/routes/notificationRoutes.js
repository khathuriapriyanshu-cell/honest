'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { queryValue } = require('./helpers');
const notificationService = require('../services/notificationService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Accountability notification routes.
 *
 * GET  /api/notifications              active backend-scheduled messages
 * GET  /api/notifications/history      every event the scheduler has fired
 * POST /api/notifications/:id/ack      acknowledge one message
 * POST /api/notifications/ack-all      acknowledge everything unread
 *
 * The frontend is never the scheduler: these messages exist because the backend
 * computed them from the configured accountability time, grace period and the
 * real state of the day.
 */

function createNotificationRoutes(deps) {
  const router = express.Router();

  router.get('/notifications', (req, res) => {
    const notifications = notificationService.activeNotifications(deps, { limit: queryValue(req, 'limit') || 5 });
    const runtime = getRuntimeSettings(deps.db);
    return ok(res, {
      notifications,
      count: notifications.length,
      enabled: runtime.notifications,
      accountabilityTime: runtime.accountabilityTime,
      gracePeriod: runtime.gracePeriod,
      schedule: [
        {
          at: runtime.accountabilityTime,
          kind: notificationService.EVENTS.ACCOUNTABILITY,
          template: 'Be honest with yourself. You still have {n} unfinished promise(s) today.',
        },
        {
          at: offsetFromReset(runtime.dailyReset, runtime.gracePeriod),
          kind: notificationService.EVENTS.GRACE_WARNING,
          template: '{n} minutes left. You can still finish them. Or tell yourself why you did not.',
        },
        {
          at: runtime.dailyReset,
          kind: notificationService.EVENTS.YESTERDAY_UNRESOLVED,
          template: 'Yesterday is waiting for an explanation.',
        },
      ],
      serverTime: deps.clock.currentHhmm(runtime.resolvedTimezone),
      timezone: runtime.resolvedTimezone,
    });
  });

  router.get('/notifications/history', (req, res) => {
    const history = notificationService.notificationHistory(deps.db, { limit: queryValue(req, 'limit') || 50 });
    return ok(res, { count: history.length, history });
  });

  router.post('/notifications/ack-all', (req, res) => {
    return ok(res, notificationService.acknowledgeAll(deps.db));
  });

  router.post('/notifications/:id/ack', (req, res) => {
    return ok(res, notificationService.acknowledge(deps.db, req.params.id));
  });

  return router;
}

/** "23:45" for a reset of 00:00 and a 15 minute grace period. */
function offsetFromReset(dailyReset, gracePeriod) {
  const [h, m] = String(dailyReset).split(':').map(Number);
  const total = (h * 60 + m - Number(gracePeriod) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

module.exports = { createNotificationRoutes };
