'use strict';

const { all, get } = require('../database/helpers');
const time = require('../utils/time');
const validate = require('../utils/validate');
const dayService = require('./dayService');
const occurrenceService = require('./occurrenceService');
const offDayService = require('./offDayService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Behavioural analytics.
 *
 * Everything in this file is computed from persisted rows - occurrences,
 * reflections and off days. There are no hardcoded statistics, no sample data
 * and no placeholder values: with an empty database every number is a real zero
 * and every label is an honest "no data yet".
 */

const DEFAULT_INSIGHT =
  'Keep logging your promises. Patterns only appear once there is real data behind them.';

/* ------------------------------------------------------------------ *
 * Honest Days
 * ------------------------------------------------------------------ */

/**
 * An HONEST DAY is not a completion streak.
 *
 * A day is honest when:
 *   - every promise on it was kept, OR
 *   - every promise that was missed received an honest reflection, OR
 *   - the day was declared an off day.
 *
 * A day with no promises at all is neutral, not honest.
 */
function isHonestDay(db, date, cache = null) {
  const day = dayService.getDayTasks(db, date, cache);
  if (day.isOffDay) return true;
  if (day.counts.total === 0) return false;
  return day.counts.unresolved === 0;
}

function hasAnyActivity(db, date, cache = null) {
  const day = dayService.getDayTasks(db, date, cache);
  return day.isOffDay || day.counts.total > 0;
}

/**
 * Counts honest days between two dates (inclusive).
 * Days with no promises and no off day are skipped entirely.
 */
function countHonestDays(db, from, to) {
  const cache = new Map();
  let honest = 0;
  let counted = 0;
  for (const date of time.enumerateDates(from, to)) {
    if (!hasAnyActivity(db, date, cache)) continue;
    counted += 1;
    if (isHonestDay(db, date, cache)) honest += 1;
  }
  return { honestDays: honest, trackedDays: counted, from, to };
}

/**
 * Current honest-day streak, counting backwards from today.
 *
 * The current day is still in progress, so an unfinished promise today does not
 * break the streak yet - only days that are over are judged. An off day keeps
 * the streak alive.
 */
function currentHonestStreak({ db, clock }) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const cache = new Map();

  let streak = 0;
  let cursor = today;
  let guard = 0;

  // Today counts when it is already honest; otherwise it is simply pending.
  const todayDay = dayService.getDayTasks(db, today, cache);
  const todayHonest = isHonestDay(db, today, cache);
  if (todayHonest) streak += 1;

  cursor = time.shiftIsoDate(today, -1);
  let skippedActivityDays = 0;

  while (guard < 3660) {
    guard += 1;
    const day = dayService.getDayTasks(db, cursor, cache);
    if (day.counts.total === 0 && !day.isOffDay) {
      skippedActivityDays += 1;
      // A long run of days with nothing promised ends the search: this is a
      // fresh start, not an unbroken streak.
      if (skippedActivityDays >= 30) break;
      cursor = time.shiftIsoDate(cursor, -1);
      continue;
    }
    skippedActivityDays = 0;
    if (isHonestDay(db, cursor, cache)) {
      streak += 1;
      cursor = time.shiftIsoDate(cursor, -1);
      continue;
    }
    break;
  }

  return {
    current: streak,
    todayHonest,
    todayPending: Boolean(todayDay.counts.unresolved > 0 && !todayHonest),
    asOf: today,
  };
}

/** Honest days for the current month, the best month, and the all-time total. */
function honestDaysSummary({ db, clock }) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const [year, month] = today.split('-').map(Number);

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(time.daysInMonth(year, month)).padStart(2, '0')}`;

  const monthStats = countHonestDays(db, monthStart, monthEnd < today ? monthEnd : today);

  const firstRow = get(db, 'SELECT MIN(date) AS d FROM task_occurrences');
  const firstOffDay = get(db, "SELECT MIN(date) AS d FROM off_days WHERE status = 'active'");
  const firstTask = get(db, 'SELECT MIN(start_date) AS d FROM tasks');
  const candidates = [firstRow && firstRow.d, firstOffDay && firstOffDay.d, firstTask && firstTask.d].filter(Boolean);
  const earliest = candidates.length ? candidates.sort()[0] : today;

  const lifetime = countHonestDays(db, earliest, today);
  const streak = currentHonestStreak({ db, clock });

  return {
    current: streak.current,
    todayHonest: streak.todayHonest,
    todayPending: streak.todayPending,
    month: {
      label: time.formatMonthLabel(year, month),
      honestDays: monthStats.honestDays,
      trackedDays: monthStats.trackedDays,
    },
    lifetime: {
      honestDays: lifetime.honestDays,
      trackedDays: lifetime.trackedDays,
      since: earliest,
    },
    definition:
      'An honest day is a day where every promise was kept, or every missed promise was honestly explained. An off day also counts. This is not a plain completion streak.',
  };
}

/* ------------------------------------------------------------------ *
 * Honest Score
 * ------------------------------------------------------------------ */

/**
 * ============================================================
 *  HONEST SCORE - FORMULA (deterministic, no randomness)
 * ============================================================
 *
 * For a period (a calendar month, or any date range):
 *
 *   made       = promises completed + promises missed
 *   completed  = promises kept
 *   missed     = promises missed  (explained + unexplained)
 *   explained  = missed promises that received an honest reflection
 *   unexplained= missed promises still without a reflection
 *
 *   completionScore   = round(100 * completed  / (completed + missed))
 *   explanationScore  = round(100 * explained  / missed)          [no misses -> 100]
 *   followThrough     = round(100 * explained  / (explained + unexplained))
 *   noUnansweredBonus = 100 when unexplained === 0, else 0
 *
 *   HONEST SCORE = round(
 *       0.55 * completionScore
 *     + 0.30 * explanationScore
 *     + 0.10 * followThrough
 *     + 0.05 * noUnansweredBonus
 *   )
 *
 * Rationale:
 *   - Completion is the largest single term because keeping promises matters.
 *   - Explaining what you missed is worth almost as much as the misses were
 *     worth lost: honesty is a first-class outcome, not a penalty box.
 *   - `followThrough` rewards explaining *everything* rather than most things.
 *   - The small `noUnansweredBonus` breaks the tie at the very top: 100 is
 *     reserved for a period with zero unanswered promises and no misses, or a
 *     period whose misses were all explained AND fully completed otherwise.
 *
 * Properties:
 *   - deterministic: same rows in, same integer out;
 *   - bounded: always 0..100;
 *   - monotonic: completing a promise never lowers the score; explaining a miss
 *     never lowers the score; ignoring a miss never raises it;
 *   - empty period -> score 0 with `hasData: false` (never a fabricated value).
 *
 * To change the weighting, edit SCORE_WEIGHTS below - nothing else needs to change.
 * ============================================================
 */
const SCORE_WEIGHTS = {
  completion: 0.55,
  explanation: 0.3,
  followThrough: 0.1,
  noUnanswered: 0.05,
};

function computeScoreFromCounts(counts) {
  const { completed, explained, unexplained } = counts;
  const missed = explained + unexplained;
  const made = completed + missed;

  if (made === 0) {
    return {
      honestyScore: 0,
      hasData: false,
      completionScore: 0,
      explanationScore: 0,
      followThroughScore: 0,
      noUnansweredBonus: 0,
      made,
      completed,
      missed,
      explained,
      unexplained,
    };
  }

  const completionScore = (100 * completed) / made;
  const explanationScore = missed === 0 ? 100 : (100 * explained) / missed;
  const followThroughScore = missed === 0 ? 100 : (100 * explained) / missed;
  const noUnansweredBonus = unexplained === 0 ? 100 : 0;

  const raw =
    SCORE_WEIGHTS.completion * completionScore +
    SCORE_WEIGHTS.explanation * explanationScore +
    SCORE_WEIGHTS.followThrough * followThroughScore +
    SCORE_WEIGHTS.noUnanswered * noUnansweredBonus;

  return {
    honestyScore: Math.max(0, Math.min(100, Math.round(raw))),
    hasData: true,
    completionScore: Math.round(completionScore),
    explanationScore: Math.round(explanationScore),
    followThroughScore: Math.round(followThroughScore),
    noUnansweredBonus,
    made,
    completed,
    missed,
    explained,
    unexplained,
  };
}

/**
 * Honest Score for a date range, based on real occurrence rows only.
 * Off days contribute nothing: their promises were suspended, not missed.
 */
function scoreForRange(db, from, to) {
  const offDays = new Set(offDayService.listOffDays(db, { from, to }).map((o) => o.date));
  const rows = all(
    db,
    `SELECT status, date FROM task_occurrences WHERE date >= ? AND date <= ?`,
    [from, to]
  ).filter((row) => !offDays.has(row.date));

  let completed = 0;
  let explained = 0;
  let unexplained = 0;
  for (const row of rows) {
    if (row.status === occurrenceService.STATUS.COMPLETED) completed += 1;
    else if (row.status === occurrenceService.STATUS.MISSED_EXPLAINED) explained += 1;
    else unexplained += 1;
  }

  const score = computeScoreFromCounts({ completed, explained, unexplained });
  const made = completed + explained + unexplained;
  return {
    ...score,
    from,
    to,
    completionRate: made === 0 ? 0 : Math.round((1000 * completed) / made) / 10,
    offDaysExcluded: offDays.size,
  };
}

/**
 * Honest Score for a calendar month - the payload behind GET /api/stats/score.
 * An explicit `from`/`to` range may be supplied to score any other period with
 * exactly the same formula.
 */
function monthlyScore({ db, clock }, { from = null, to = null } = {}) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const [year, month] = today.split('-').map(Number);

  const defaultFirst = `${year}-${String(month).padStart(2, '0')}-01`;
  const defaultLast = `${year}-${String(month).padStart(2, '0')}-${String(
    time.daysInMonth(year, month)
  ).padStart(2, '0')}`;

  const first = from || defaultFirst;
  const last = to || defaultLast;
  const stats = scoreForRange(db, first, last);

  const labelParts = first.split('-').map(Number);
  const multiMonth = first.slice(0, 7) !== last.slice(0, 7);

  return {
    honestyScore: stats.honestyScore,
    hasData: stats.hasData,
    month: multiMonth
      ? `${time.formatMonthLabel(labelParts[0], labelParts[1])} - ${time.formatMonthLabel(
          Number(last.slice(0, 4)),
          Number(last.slice(5, 7))
        )}`
      : time.formatMonthLabel(labelParts[0], labelParts[1]),
    monthStart: first,
    monthEnd: last,
    range: { from: first, to: last },
    promisesMade: stats.made,
    completed: stats.completed,
    missed: stats.missed,
    explained: stats.explained,
    unexplained: stats.unexplained,
    completionRate: stats.completionRate,
    breakdown: {
      completionScore: stats.completionScore,
      explanationScore: stats.explanationScore,
      followThroughScore: stats.followThroughScore,
      noUnansweredBonus: stats.noUnansweredBonus,
      weights: SCORE_WEIGHTS,
    },
    offDaysExcluded: stats.offDaysExcluded,
    formula:
      'round(0.55*completion + 0.30*explanation + 0.10*followThrough + 0.05*noUnansweredBonus), all terms 0-100',
  };
}

/* ------------------------------------------------------------------ *
 * Weekly report
 * ------------------------------------------------------------------ */

/** Start (Monday or Sunday) of the week containing `date`. */
function weekStartFor(date, weekStart) {
  const weekday = time.isoWeekdayFromDate(date); // 1 = Monday .. 7 = Sunday
  const offset = weekStart === 'sunday' ? weekday % 7 : weekday - 1;
  return time.shiftIsoDate(date, -offset);
}

/**
 * Weekly Honesty Report.
 *
 * Calculated from occurrences in the current week (per the `weekStart`
 * setting). Off days are excluded from the denominators - a suspended promise
 * is neither kept nor broken.
 */
function weeklyReport({ db, clock }, { date = null } = {}) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const anchor = date ? validate.asDate(date, 'date') : today;
  const weekStart = weekStartFor(anchor, runtime.weekStart);
  const weekEnd = time.shiftIsoDate(weekStart, 6);

  const offDays = new Set(offDayService.listOffDays(db, { from: weekStart, to: weekEnd }).map((o) => o.date));

  const rows = all(
    db,
    `SELECT o.*, t.name AS live_name, t.category AS live_category
       FROM task_occurrences o
       JOIN tasks t ON t.id = o.task_id
      WHERE o.date >= ? AND o.date <= ?
      ORDER BY o.date ASC`,
    [weekStart, weekEnd]
  ).filter((row) => !offDays.has(row.date));

  let completed = 0;
  let explained = 0;
  let unexplained = 0;
  const perTask = new Map();

  for (const row of rows) {
    const name = row.task_name || row.live_name;
    if (!perTask.has(row.task_id)) {
      perTask.set(row.task_id, { taskId: row.task_id, name, category: row.task_category || row.live_category, completed: 0, total: 0 });
    }
    const bucket = perTask.get(row.task_id);
    bucket.total += 1;
    if (row.status === occurrenceService.STATUS.COMPLETED) {
      bucket.completed += 1;
      completed += 1;
    } else if (row.status === occurrenceService.STATUS.MISSED_EXPLAINED) {
      explained += 1;
    } else {
      unexplained += 1;
    }
  }

  const total = completed + explained + unexplained;
  const completionRate = total === 0 ? 0 : Math.round((1000 * completed) / total) / 10;

  const tasks = [...perTask.values()]
    .map((t) => ({ ...t, rate: t.total === 0 ? 0 : Math.round((1000 * t.completed) / t.total) / 10 }))
    .sort((a, b) => b.total - a.total || a.taskId - b.taskId);

  // "Most consistent" needs a real sample; a promise answered once is not a
  // pattern. Same for "most skipped".
  const comparable = tasks.filter((t) => t.total >= 2);
  const mostConsistent = comparable.length
    ? comparable.slice().sort((a, b) => b.rate - a.rate || b.total - a.total || a.taskId - b.taskId)[0]
    : null;
  const skippedCandidates = comparable.filter((t) => t.completed < t.total);
  const mostSkipped = skippedCandidates.length
    ? skippedCandidates.slice().sort((a, b) => a.rate - b.rate || b.total - a.total || a.taskId - b.taskId)[0]
    : null;

  const reasons = all(
    db,
    `SELECT reason, COUNT(*) AS n FROM reflections WHERE date >= ? AND date <= ?
      GROUP BY reason ORDER BY n DESC, reason ASC`,
    [weekStart, weekEnd]
  );
  const commonReason = reasons.length ? { reason: reasons[0].reason, count: reasons[0].n } : null;

  const daysTracked = new Set(rows.map((r) => r.date)).size;

  let insight;
  if (total === 0) {
    insight = DEFAULT_INSIGHT;
  } else if (unexplained > 0) {
    insight = `${unexplained} promise${unexplained === 1 ? '' : 's'} this week are still waiting for an honest reason. Naming what got in the way is worth more than a perfect week.`;
  } else if (explained > 0 && completed > 0) {
    insight = `${completed} of ${total} promises were kept and every miss was explained. Honesty is holding up - the next lever is scheduling, not effort.`;
  } else if (explained > 0) {
    insight = `Nothing was completed this week, but every miss was explained. That is a real starting point: the schedule is the problem, not your honesty.`;
  } else if (mostSkipped && mostSkipped.rate < 70) {
    insight = `"${mostSkipped.name}" was kept ${formatRate(mostSkipped.rate)} of the time this week. Look at when it is scheduled before working harder.`;
  } else if (completionRate >= 90) {
    insight = `${formatRate(completionRate)} of this week's promises were kept. Protect the routine that made that possible.`;
  } else {
    insight = `You don't need more motivation. You may need a better schedule.`;
  }

  return {
    weekStart,
    weekEnd,
    weekStartDay: runtime.weekStart,
    completedCount: completed,
    totalCount: total,
    missedCount: explained + unexplained,
    explainedCount: explained,
    unexplainedCount: unexplained,
    completionRate,
    mostConsistent: mostConsistent ? `${mostConsistent.name} (${formatRate(mostConsistent.rate)})` : 'None yet',
    mostSkipped: mostSkipped ? `${mostSkipped.name} (${formatRate(mostSkipped.rate)})` : 'None yet',
    commonReason: commonReason ? commonReason.reason : null,
    commonReasonCount: commonReason ? commonReason.count : 0,
    reasonCount: reasons.length,
    daysTracked,
    insight,
    empty: total === 0,
  };
}

function formatRate(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}%`;
}

module.exports = {
  isHonestDay,
  countHonestDays,
  currentHonestStreak,
  honestDaysSummary,
  computeScoreFromCounts,
  scoreForRange,
  monthlyScore,
  weeklyReport,
  weekStartFor,
  SCORE_WEIGHTS,
  DEFAULT_INSIGHT,
  formatRate,
};
