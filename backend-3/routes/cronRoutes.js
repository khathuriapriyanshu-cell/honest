'use strict';

const express = require('express');
const { ok, fail } = require('../middleware/respond');
const { authorizeCron } = require('../utils/cronAuth');
const notificationService = require('../services/notificationService');
const dayService = require('../services/dayService');
const statsService = require('../services/statsService');
const occurrenceService = require('../services/occurrenceService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Serverless scheduler endpoint.
 *
 * On a platform like Vercel the process does not live long enough for a
 * `setInterval` timer to be trustworthy: it sleeps between invocations. This
 * endpoint lets an external scheduler (Vercel Cron, GitHub Actions, an uptime
 * monitor) drive the same logic on a fixed cadence.
 *
 *   GET  /api/cron/tick[?secret=...]
 *   POST /api/cron/tick[?secret=...]   (also protected by the same secret)
 *
 * It is *additive*. Every read endpoint already computes the current
 * accountability state on demand, so the product remains correct even if the
 * cron never runs - the cron exists to make notifications appear on time.
 *
 * The response doubles as an audit log: it reports what fired, what is still
 * waiting for an explanation, and any integrity problem it noticed.
 */

function createCronRoutes(deps) {
  const router = express.Router();

  const handle = (req, res) => {
    const started = Date.now();
    const auth = authorizeCron(req, deps.cronSecret);

    if (!auth.allowed) {
      return fail(
        res,
        401,
        'CRON_UNAUTHORIZED',
        'The scheduler endpoint requires a valid CRON_SECRET (x-cron-secret header, Authorization: Bearer, or ?secret=).',
        { reason: auth.reason }
      );
    }

    const { db, clock } = deps;
    const runtime = getRuntimeSettings(db);
    const today = clock.today(runtime.resolvedTimezone);

    // 1. Fire anything that is due (idempotent: dedupe keys prevent repeats).
    const tick = notificationService.runSchedulerTick({ db, clock });

    // The scheduler facade records the run for /api/health, so the response can
    // report when the cadence last ran and which mode the process is using.
    const schedulerStatus =
      deps.scheduler && typeof deps.scheduler.runNow === 'function'
        ? deps.scheduler.runNow()
        : { ran: false, reason: 'scheduler_not_available' };
    const schedulerMode = deps.scheduler && deps.scheduler.mode ? deps.scheduler.mode : null;

    // 2. Summarise the current accountability state for the audit log.
    const state = dayService.buildDayState(deps, null, { honestDays: statsService.currentHonestStreak(deps).current });
    const unresolvedBefore = occurrenceService.unresolvedDatesBefore(db, today);

    // 3. Look for integrity problems worth surfacing to an operator.
    const issues = [];
    if (!runtime.notifications) {
      issues.push({ code: 'NOTIFICATIONS_DISABLED', detail: 'Settings have notifications switched off; no events will fire.' });
    }
    if (unresolvedBefore.length > 0) {
      issues.push({
        code: 'UNEXPLAINED_PAST_DAYS',
        detail: `${unresolvedBefore.length} past day(s) still have an unexplained promise.`,
        dates: unresolvedBefore.slice(-10),
      });
    }
    if (deps.databaseIsEphemeral) {
      issues.push({
        code: 'EPHEMERAL_DATABASE',
        detail:
          'The database is not persistent on this platform. Set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (or HONEST_DB on a persistent volume) or data will be lost on redeploy.',
      });
    }
    if (auth.required === false) {
      issues.push({
        code: 'CRON_SECRET_NOT_SET',
        detail: 'CRON_SECRET is not configured, so this endpoint is publicly callable. Set it in production.',
      });
    }

    const pendingNotifications = notificationService.activeNotifications(deps, { limit: 5 });

    return ok(res, {
      tick: {
        ranAt: new Date().toISOString(),
        serverDate: today,
        serverTime: clock.currentHhmm(runtime.resolvedTimezone),
        timezone: runtime.resolvedTimezone,
        durationMs: Date.now() - started,
      },
      authorized: { required: auth.required, via: auth.from },
      scheduler: { mode: schedulerMode, ...schedulerStatus },
      events: {
        evaluated: tick.evaluated || 0,
        created: tick.created || 0,
        notificationsEnabled: tick.notificationsEnabled !== false,
      },
      accountability: {
        isoDate: state.date,
        status: state.status,
        isOffDay: state.isOffDay,
        counts: state.counts,
        nightCheckActive: state.nightCheckActive,
        hasUnresolvedYesterday: state.hasUnresolvedYesterday,
        canStartNewDay: state.canStartNewDay,
        honestDays: state.honestDays,
      },
      pendingNotifications: pendingNotifications.map((n) => ({ id: n.id, kind: n.kind, message: n.message })),
      issues,
    });
  };

  router.get('/cron/tick', handle);
  router.post('/cron/tick', handle);

  return router;
}

module.exports = { createCronRoutes };
