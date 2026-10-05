'use strict';

const notificationService = require('../services/notificationService');
const { getRuntimeSettings } = require('../services/settingsService');

/**
 * Accountability scheduler.
 *
 * Design: the notification rules are *pure functions of the current instant*
 * (see `notificationService.computeEvents`). The scheduler therefore does not
 * need a job queue, cron expressions or any third-party dependency - it simply
 * re-evaluates "what should be true right now?" on a short interval, and the
 * UNIQUE `dedupe_key` in `notification_log` guarantees each event is delivered
 * exactly once per day.
 *
 * Two ways to run it
 * ------------------
 *   timer       an in-process `setInterval` (default; ideal for a VPS, Render,
 *               Railway, Fly.io, or local development)
 *   on_demand   no timer at all; an external scheduler calls GET /api/cron/tick
 *               (required on serverless platforms such as Vercel, where timers
 *               sleep whenever the function is not executing)
 *
 * Either mode is safe to combine with the other, and both are idempotent, so
 * enabling both cannot produce duplicate notifications.
 *
 * Consequences for both modes:
 *   - restart safe: state lives in SQLite, not in memory;
 *   - no missed events while the process is down: the first tick after start
 *     (and every read of GET /api/notifications or /api/today) catches up;
 *   - no drift: the check uses the user's timezone, not the host's;
 *   - cheap: a handful of indexed queries per tick.
 */

const DEFAULT_INTERVAL_MS = 30000;

/**
 * Shared state and behaviour for both modes.
 * The returned object is what `deps.scheduler` exposes to routes.
 */
function createSchedulerFacade({ db, clock, mode, intervalMs = null, onError = null }) {
  const state = {
    mode,
    intervalMs,
    running: false,
    ticks: 0,
    lastRun: null,
    lastResult: null,
    lastError: null,
    startedAt: null,
  };

  /**
   * Performs one tick and records it. Safe to call at any time, from any number
   * of callers, as often as you like.
   */
  function runNow() {
    try {
      const runtime = getRuntimeSettings(db);
      if (!runtime.notifications) {
        state.ticks += 1;
        state.lastRun = new Date().toISOString();
        state.lastResult = { ran: true, created: 0, evaluated: 0, notificationsEnabled: false };
        return state.lastResult;
      }
      const result = notificationService.runSchedulerTick({ db, clock });
      state.ticks += 1;
      state.lastRun = new Date().toISOString();
      state.lastResult = {
        ran: true,
        created: result.created || 0,
        evaluated: result.evaluated || 0,
        notificationsEnabled: true,
      };
      return state.lastResult;
    } catch (err) {
      state.lastError = err && err.message ? err.message : String(err);
      if (typeof onError === 'function') onError(err);
      else console.error('[honest] scheduler tick failed:', state.lastError);
      state.lastRun = new Date().toISOString();
      state.lastResult = { ran: false, error: state.lastError };
      return state.lastResult;
    }
  }

  return {
    mode,
    runNow,
    /** Starts the timer (timer mode only). No-op otherwise. */
    start() {},
    stop() {
      state.running = false;
    },
    status() {
      return {
        mode: state.mode,
        running: state.running,
        intervalMs: state.intervalMs,
        ticks: state.ticks,
        lastRun: state.lastRun,
        lastResult: state.lastResult,
        lastError: state.lastError,
        startedAt: state.startedAt,
      };
    },
    /** Test seam: inspect the internal counters. */
    _state: state,
  };
}

/**
 * Timer mode: an in-process interval. The timer is unref'd so it never keeps a
 * scripted run alive.
 */
function startScheduler(deps, { intervalMs = DEFAULT_INTERVAL_MS, onError = null } = {}) {
  const facade = createSchedulerFacade({ db: deps.db, clock: deps.clock, mode: 'timer', intervalMs, onError });
  const state = facade._state;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    facade.runNow();
  };

  // First tick immediately so a freshly started server is already truthful.
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  state.running = true;
  state.startedAt = new Date().toISOString();

  return {
    mode: 'timer',
    runNow: () => facade.runNow(),
    start() {
      // A timer scheduler is already running once created; kept for symmetry
      // with the on-demand facade so callers do not need to branch.
    },
    stop() {
      stopped = true;
      state.running = false;
      clearInterval(timer);
    },
    status: () => ({ ...facade.status(), mode: 'timer', running: !stopped }),
  };
}

/**
 * On-demand mode: no timer. The returned object is API-compatible with the
 * timer scheduler so routes and tests do not care which mode is active.
 */
function createServerlessScheduler(deps, { onError = null } = {}) {
  const facade = createSchedulerFacade({ db: deps.db, clock: deps.clock, mode: 'on_demand', intervalMs: null, onError });
  facade._state.startedAt = new Date().toISOString();
  return facade;
}

module.exports = { startScheduler, createServerlessScheduler, createSchedulerFacade, DEFAULT_INTERVAL_MS };
