'use strict';

const { all, get } = require('../database/helpers');
const time = require('../utils/time');
const validate = require('../utils/validate');
const occurrenceService = require('./occurrenceService');
const reflectionService = require('./reflectionService');
const { getRuntimeSettings } = require('./settingsService');

/**
 * Honest archive + behavioural insights.
 *
 * Both are computed from real persisted data. When there is not enough data to
 * support a claim, the claim is not made: `patterns` comes back empty and the
 * frontend shows its own empty state rather than a fabricated observation.
 */

const MIN_BUCKET_SAMPLE = 3; // per side of a comparison
const MIN_DAY_SAMPLE = 8; // occurrences before a weekday claim is allowed
const MIN_REASON_REPEATS = 3;

function truncated(text, max = 60) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/**
 * GET /api/archive?q=
 * Historical reflections, optionally filtered by a keyword, plus an honest
 * pattern notice when one reason keeps recurring this month.
 */
function archive({ db, clock }, { q = null, from = null, to = null, limit = 200 } = {}) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = `${today.slice(0, 7)}-${String(time.daysInMonth(Number(today.slice(0, 4)), Number(today.slice(5, 7)))).padStart(2, '0')}`;

  const fromDate = from ? validate.asDate(from, 'from') : null;
  const toDate = to ? validate.asDate(to, 'to') : null;
  const term = q === null || q === undefined || String(q).trim() === '' ? null : String(q).trim().toLowerCase();

  const rows = reflectionService.listReflectionRows(db, {
    from: fromDate,
    to: toDate,
    limit: 2000,
  });

  const keyword = term
    ? rows.filter(
        (row) => row.reason.toLowerCase().includes(term) || String(row.task_name).toLowerCase().includes(term)
      )
    : rows;

  const reflections = keyword.slice(0, Math.min(Math.max(Number(limit) || 200, 1), 500)).map(reflectionService.toApiShape);

  // Pattern notice: the most repeated reason *in the current month*, counted on
  // normalised text so "Too tired." and "too tired" are the same reason.
  const monthRows = rows.filter((row) => row.date >= monthStart && row.date <= monthEnd);
  const counts = new Map();
  for (const row of monthRows) {
    const key = reflectionService.normalizeReason(row.reason);
    if (!key) continue;
    if (!counts.has(key)) counts.set(key, { label: truncated(row.reason), count: 0 });
    counts.get(key).count += 1;
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const top = ranked.length > 0 ? ranked[0] : null;

  let patternNotice = null;
  if (top && top.count >= 2) {
    patternNotice = `You've used "${top.label}" ${top.count} times this month.`;
  }

  return {
    query: term,
    count: reflections.length,
    totalMatching: keyword.length,
    total: rows.length,
    reflections,
    patternNotice,
    pattern: top && top.count >= 2 ? { reason: top.label, count: top.count } : null,
    timezone: runtime.resolvedTimezone,
    empty: reflections.length === 0,
    emptyMessage:
      reflections.length === 0
        ? term
          ? `No reflection matches "${q}".`
          : 'No reflections recorded yet. Reasons you record will appear here.'
        : null,
  };
}

/**
 * GET /api/insights
 * Deterministic behavioural patterns, each backed by counts from the database.
 */
function insights({ db, clock }, { lookbackDays = 90 } = {}) {
  const runtime = getRuntimeSettings(db);
  const today = clock.today(runtime.resolvedTimezone);
  const from = time.shiftIsoDate(today, -Math.min(Math.max(Number(lookbackDays) || 90, 7), 365));
  const to = today;

  const rows = all(
    db,
    `SELECT o.*, t.name AS live_name, t.reminder AS task_reminder,
            t.accountability_time AS task_accountability, t.category AS live_category
       FROM task_occurrences o
       JOIN tasks t ON t.id = o.task_id
      WHERE o.date >= ? AND o.date <= ?
      ORDER BY o.date ASC`,
    [from, to]
  );

  const patterns = [];
  const perTask = new Map();
  const earlyLate = { early: { completed: 0, total: 0 }, late: { completed: 0, total: 0 } };

  for (const row of rows) {
    const name = row.task_name || row.live_name;
    const key = row.task_id;
    if (!perTask.has(key)) {
      perTask.set(key, {
        taskId: row.task_id,
        name,
        completed: 0,
        total: 0,
        beforeEvening: { completed: 0, total: 0 },
        afterEvening: { completed: 0, total: 0 },
      });
    }
    const bucket = perTask.get(key);
    bucket.total += 1;
    const isCompleted = row.status === occurrenceService.STATUS.COMPLETED;
    if (isCompleted) bucket.completed += 1;

    // Time-of-day analysis. A promise's own reminder (or its accountability
    // time, or the global default as a last resort) is the best available
    // signal for when it was meant to happen.
    const scheduled = row.task_reminder || row.task_accountability || runtime.accountabilityTime;
    const hour = scheduled ? Number(String(scheduled).split(':')[0]) : null;
    if (Number.isFinite(hour)) {
      const bucketName = hour < 19 ? 'early' : 'late';
      earlyLate[bucketName].total += 1;
      if (isCompleted) earlyLate[bucketName].completed += 1;

      const perTaskBucket = hour < 19 ? bucket.beforeEvening : bucket.afterEvening;
      perTaskBucket.total += 1;
      if (isCompleted) perTaskBucket.completed += 1;
    }
  }

  // --- Pattern 1a: time-of-day discrepancy across all promises --------------
  // Comparing *when promises are scheduled* is the honest form of this claim:
  // a single promise usually only ever sits in one time slot.
  {
    const early = earlyLate.early;
    const late = earlyLate.late;
    if (early.total >= MIN_BUCKET_SAMPLE && late.total >= MIN_BUCKET_SAMPLE) {
      const earlyRate = Math.round((100 * early.completed) / early.total);
      const lateRate = Math.round((100 * late.completed) / late.total);
      if (Math.abs(earlyRate - lateRate) >= 25) {
        const earlierBetter = earlyRate >= lateRate;
        patterns.push({
          lead: 'Time-of-day discrepancy',
          content: `You complete promises ${earlierBetter ? earlyRate : lateRate}% of the time when they are scheduled ${
            earlierBetter ? 'before 7 PM' : 'after 7 PM'
          }, but only ${earlierBetter ? lateRate : earlyRate}% when they are scheduled ${
            earlierBetter ? 'in the evening' : 'earlier in the day'
          } (${early.total} early promises, ${late.total} later ones).`,
          data: {
            beforeRate: earlyRate,
            afterRate: lateRate,
            beforeTotal: early.total,
            afterTotal: late.total,
          },
        });
      }
    }
  }

  // --- Pattern 1b: a single promise whose success depends on the time -------
  for (const task of perTask.values()) {
    const before = task.beforeEvening;
    const after = task.afterEvening;
    if (before.total < MIN_BUCKET_SAMPLE || after.total < MIN_BUCKET_SAMPLE) continue;
    const beforeRate = Math.round((100 * before.completed) / before.total);
    const afterRate = Math.round((100 * after.completed) / after.total);
    if (Math.abs(beforeRate - afterRate) < 25) continue;
    const earlierBetter = beforeRate >= afterRate;
    patterns.push({
      lead: 'Time-of-day discrepancy',
      content: `"${task.name}" is completed ${earlierBetter ? beforeRate : afterRate}% of the time when it is scheduled ${
        earlierBetter ? 'before 7 PM' : 'after 7 PM'
      }, but only ${earlierBetter ? afterRate : beforeRate}% when it is scheduled ${
        earlierBetter ? 'after 9 PM' : 'before 7 PM'
      } (${before.total} early occurrences, ${after.total} later ones).`,
      data: { taskId: task.taskId, beforeRate, afterRate, beforeTotal: before.total, afterTotal: after.total },
    });
    if (patterns.length >= 3) break;
  }

  // --- Pattern 2: day-of-week pattern ---------------------------------------
  const weekdayStats = new Map();
  for (const row of rows) {
    const weekday = time.isoWeekdayFromDate(row.date);
    if (!weekdayStats.has(weekday)) weekdayStats.set(weekday, { total: 0, missed: 0 });
    const bucket = weekdayStats.get(weekday);
    bucket.total += 1;
    if (row.status !== occurrenceService.STATUS.COMPLETED) bucket.missed += 1;
  }

  const weekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const weekdayRanked = [...weekdayStats.entries()]
    .filter(([, bucket]) => bucket.total >= MIN_DAY_SAMPLE && bucket.missed >= 3)
    .map(([weekday, bucket]) => ({ weekday, ...bucket, rate: bucket.missed / bucket.total }))
    .sort((a, b) => b.rate - a.rate || b.missed - a.missed);

  if (weekdayRanked.length > 0 && weekdayRanked[0].rate >= 0.5) {
    const worst = weekdayRanked[0];
    const share = Math.round(worst.rate * 100);
    patterns.push({
      lead: 'Day-of-week pattern',
      content: `${weekdayNames[worst.weekday - 1]} is your hardest day: ${worst.missed} of ${worst.total} promises (${share}%) were not completed.`,
      data: { weekday: weekdayNames[worst.weekday - 1], missed: worst.missed, total: worst.total },
    });
  }

  // --- Pattern 3: most common justification ---------------------------------
  const reasonRows = all(
    db,
    'SELECT reason, COUNT(*) AS n FROM reflections WHERE date >= ? AND date <= ? GROUP BY reason',
    [from, to]
  );
  const reasonCounts = new Map();
  for (const row of reasonRows) {
    const key = reflectionService.normalizeReason(row.reason);
    if (!key) continue;
    if (!reasonCounts.has(key)) reasonCounts.set(key, { label: truncated(row.reason), count: 0 });
    reasonCounts.get(key).count += row.n;
  }
  const topReason = [...reasonCounts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0];
  if (topReason && topReason.count >= MIN_REASON_REPEATS) {
    patterns.push({
      lead: 'Primary justification',
      content: `Your most common reason for unfinished promises is "${topReason.label}" (${topReason.count} times in the last ${Math.min(
        Math.max(Number(lookbackDays) || 90, 7),
        365
      )} days).`,
      data: { reason: topReason.label, count: topReason.count },
    });
  }

  // --- Pattern 4: honours the honesty distinction ---------------------------
  const totals = rows.reduce(
    (acc, row) => {
      if (row.status === occurrenceService.STATUS.COMPLETED) acc.completed += 1;
      else if (row.status === occurrenceService.STATUS.MISSED_EXPLAINED) acc.explained += 1;
      else acc.unexplained += 1;
      return acc;
    },
    { completed: 0, explained: 0, unexplained: 0 }
  );
  const grandTotal = totals.completed + totals.explained + totals.unexplained;
  if (grandTotal >= 10 && totals.completed + totals.explained === grandTotal) {
    patterns.push({
      lead: 'Honesty coverage',
      content: `All ${grandTotal} promises in this period are accounted for: ${totals.completed} completed and ${totals.explained} honestly explained. Nothing is left unresolved.`,
      data: { ...totals, total: grandTotal },
    });
  } else if (grandTotal >= 10 && totals.unexplained > 0) {
    patterns.push({
      lead: 'Unresolved promises',
      content: `${totals.unexplained} of ${grandTotal} promises in this period still have no reason recorded.`,
      data: { ...totals, total: grandTotal },
    });
  }

  return {
    patterns,
    empty: patterns.length === 0,
    range: { from, to },
    timezone: runtime.resolvedTimezone,
    emptyMessage:
      patterns.length === 0
        ? 'Not enough recorded promises yet to identify a pattern. Keep logging honestly - patterns need data.'
        : null,
  };
}

module.exports = { archive, insights };
