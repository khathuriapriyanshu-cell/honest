'use strict';

/**
 * Honest Days + Honest Score.
 *
 * Honest Day definition (NOT a plain completion streak):
 *   a day is honest when all its promises were completed (green)
 *   OR every missed promise was honestly explained through a reflection
 *   (yellow). Off days and days with no promises neither count as honest nor
 *   break a streak — only unexplained misses (red) break it.
 *
 * Honest Score (deterministic, documented, easy to retune):
 *
 *   score = round( 100 * ( W.completion   * completionRate
 *                        + W.explanation  * explanationRate
 *                        + W.consistency  * consistencyRate ) )
 *
 *   completionRate   = completed / promised            (window)
 *   explanationRate  = explained / missed              (missed = 0 -> 1)
 *   consistencyRate  = honest days / countable days    (green|yellow|red days)
 *   W = HONESTY_WEIGHTS below.
 *
 * All inputs come from persisted data only. With no promises in the window
 * the score is null (an honest empty state, never a fabricated number).
 */

const { addDays } = require('../utils/dates');
const { badRequest } = require('../utils/errors');
const { getDaysRange, getEarliestDataDate } = require('./dayService');

const HONESTY_WEIGHTS = { completion: 0.5, explanation: 0.3, consistency: 0.2 };
const HONESTY_FORMULA =
  'score = round(100 * (0.5 * completionRate + 0.3 * explanationRate + 0.2 * consistencyRate))';
const STREAK_LOOKBACK_LIMIT_DAYS = 730; // safety bound for the streak walk

const HONEST = new Set(['green', 'yellow']);
const SKIPPABLE = new Set(['off', 'no_promises']);

function monthStartOf(monthStr) {
  return `${monthStr}-01`;
}

function monthEndOf(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m, 0)); // last day of month
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function buildStatusMap(db, clock) {
  const earliest = getEarliestDataDate(db);
  if (!earliest) return { map: new Map(), earliest: null };
  // Cover at least the recent ~2 months so monthly tallies correctly see
  // pre-task days as no_promises (and off days recorded before the first task).
  const from = minDate(earliest, addDays(clock.todayDate, -62));
  const boundedFrom = maxDate(from, addDays(clock.todayDate, -STREAK_LOOKBACK_LIMIT_DAYS));
  const days = getDaysRange(db, boundedFrom, clock.todayDate, { clock });
  return { map: new Map(days.map((d) => [d.date, d])), earliest };
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function currentStreak(map, todayDate) {
  let count = 0;
  const today = map.get(todayDate);
  if (today && today.status === 'green') count += 1; // today can't be yellow/red yet
  for (let d = addDays(todayDate, -1); ; d = addDays(d, -1)) {
    const day = map.get(d);
    if (!day) break;
    if (HONEST.has(day.status)) count += 1;
    else if (SKIPPABLE.has(day.status)) continue; // off / no promises: skip, don't break
    else if (day.status === 'pending') continue; // unreachable for past days; safety
    else break; // red
  }
  return count;
}

function bestStreak(map, todayDate) {
  let best = 0;
  let run = 0;
  for (const [, day] of map) {
    if (day.date >= todayDate) continue;
    if (HONEST.has(day.status)) {
      run += 1;
      if (run > best) best = run;
    } else if (day.status === 'red') {
      run = 0;
    } // off / no_promises: keep the run alive
  }
  return best;
}

function monthlySummary(map, monthStr, todayDate) {
  const start = monthStartOf(monthStr);
  const end = minDate(monthEndOf(monthStr), todayDate);
  const tally = { month: monthStr, honestDays: 0, greenDays: 0, yellowDays: 0, offDays: 0, redDays: 0, noPromiseDays: 0 };
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const day = map.get(d);
    if (!day) continue;
    if (day.status === 'green') { tally.greenDays += 1; tally.honestDays += 1; }
    else if (day.status === 'yellow') { tally.yellowDays += 1; tally.honestDays += 1; }
    else if (day.status === 'off') tally.offDays += 1;
    else if (day.status === 'red') tally.redDays += 1;
    else if (day.status === 'no_promises') tally.noPromiseDays += 1;
  }
  return tally;
}

function minDate(a, b) {
  return a < b ? a : b;
}

function isValidMonth(s) {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

function getHonestDays(db, { clock, month, from, to }) {
  const { map, earliest } = buildStatusMap(db, clock);
  const currentMonth = clock.todayDate.slice(0, 7);
  if (month !== undefined && !isValidMonth(month)) {
    throw badRequest('VALIDATION_ERROR', 'Invalid month. Use YYYY-MM.');
  }
  if (!earliest) {
    return {
      current: 0,
      best: 0,
      today: 'none',
      monthly: monthlySummary(new Map(), month || currentMonth, clock.todayDate),
      history: [],
    };
  }

  const current = currentStreak(map, clock.todayDate);
  const best = bestStreak(map, clock.todayDate);

  const historyRange =
    from && to
      ? { start: from, end: to }
      : (() => {
          const m = month || currentMonth;
          return { start: monthStartOf(m), end: minDate(monthEndOf(m), clock.todayDate) };
        })();

  const history = [];
  for (let d = historyRange.start; d <= historyRange.end; d = addDays(d, 1)) {
    const day = map.get(d);
    if (!day) continue;
    history.push({ date: day.date, status: day.status, honest: HONEST.has(day.status) });
  }

  const todayStatus = map.get(clock.todayDate);
  return {
    current,
    best,
    today: todayStatus
      ? todayStatus.status === 'green'
        ? 'green_so_far'
        : todayStatus.status === 'pending'
          ? 'pending'
          : todayStatus.status === 'off'
            ? 'off'
            : 'none'
      : 'none',
    monthly: monthlySummary(map, month || currentMonth, clock.todayDate),
    history,
  };
}

/**
 * Honest Score over a window. Windows: '30d' (default), 'month', 'all'.
 * Analysis covers CLOSED days only (from window start through yesterday) so
 * the score is stable within a day; today's live progress is visible via
 * /api/today instead.
 */
function getHonestScore(db, { clock, window = '30d' }) {
  if (!['30d', 'month', 'all'].includes(window)) {
    throw badRequest('VALIDATION_ERROR', "window must be one of: 30d, month, all.");
  }
  const earliest = getEarliestDataDate(db);
  let from;
  if (window === '30d') from = addDays(clock.todayDate, -29);
  else if (window === 'month') from = monthStartOf(clock.todayDate.slice(0, 7));
  else from = earliest || clock.todayDate;
  const to = addDays(clock.todayDate, -1); // closed days only

  const totals = {
    promises: 0,
    completed: 0,
    missed: 0,
    explained: 0,
    unexplained: 0,
    countableDays: 0,
    honestDays: 0,
  };

  if (earliest && from <= to) {
    const days = getDaysRange(db, from, to, { clock });
    for (const day of days) {
      if (!['green', 'yellow', 'red'].includes(day.status)) continue;
      totals.countableDays += 1;
      totals.promises += day.counts.promised;
      totals.completed += day.counts.completed;
      totals.missed += day.counts.missed;
      totals.explained += day.counts.explained;
      totals.unexplained += day.counts.unexplained;
      if (HONEST.has(day.status)) totals.honestDays += 1;
    }
  }

  const completionRate = totals.promises > 0 ? totals.completed / totals.promises : null;
  const explanationRate = totals.missed > 0 ? totals.explained / totals.missed : 1;
  const consistencyRate = totals.countableDays > 0 ? totals.honestDays / totals.countableDays : null;

  const score =
    completionRate !== null && consistencyRate !== null
      ? Math.round(
          100 *
            (HONESTY_WEIGHTS.completion * completionRate +
              HONESTY_WEIGHTS.explanation * explanationRate +
              HONESTY_WEIGHTS.consistency * consistencyRate)
        )
      : null;

  return {
    score,
    window: { type: window, from: from <= to ? from : null, to: from <= to ? to : null },
    breakdown: {
      promisesMade: totals.promises,
      completed: totals.completed,
      missed: totals.missed,
      explained: totals.explained,
      unexplained: totals.unexplained,
      countableDays: totals.countableDays,
      honestDays: totals.honestDays,
      completionRate: completionRate !== null ? round4(completionRate) : null,
      explanationRate: round4(explanationRate),
      consistencyRate: consistencyRate !== null ? round4(consistencyRate) : null,
    },
    weights: HONESTY_WEIGHTS,
    formula: HONESTY_FORMULA,
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

module.exports = { getHonestDays, getHonestScore, HONESTY_WEIGHTS, HONESTY_FORMULA };
