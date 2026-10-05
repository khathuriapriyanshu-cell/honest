'use strict';

/**
 * Weekly honesty report + derived insights — every number is computed from
 * persisted data (no hardcoded statistics anywhere).
 */

const { weekdayOf } = require('../utils/dates');
const { getDaysRange, getDayDetail } = require('./dayService');

function weekRange(dateRef, weekStarts) {
  const wd = weekdayOf(dateRef); // 0 = Sunday
  const offset = weekStarts === 'monday' ? (wd === 0 ? 6 : wd - 1) : wd;
  const start = shiftDate(dateRef, -offset);
  return { start, end: shiftDate(start, 6) };
}

function shiftDate(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function pct1(n) {
  return Math.round(n * 1000) / 10;
}

function getWeeklyReport(db, { clock, dateRef }) {
  const ref = dateRef || clock.todayDate;
  const { start, end } = weekRange(ref, clock.weekStarts);
  const days = getDaysRange(db, start, end, { clock });

  const totals = { promised: 0, completed: 0, missed: 0, explained: 0, unexplained: 0, honestDays: 0 };
  const perTask = new Map();

  for (const day of days) {
    if (day.status === 'future' || day.status === 'off') continue;
    if (['green', 'yellow'].includes(day.status)) totals.honestDays += 1;
    totals.promised += day.counts.promised;
    totals.completed += day.counts.completed;
    totals.missed += day.counts.missed;
    totals.explained += day.counts.explained;
    totals.unexplained += day.counts.unexplained;
  }

  // Per-task detail needs occurrences; fetch day details for non-off days.
  for (const day of days) {
    if (day.status === 'future' || day.status === 'off' || day.counts.promised === 0) continue;
    const detail = getDayDetail(db, day.date, { clock });
    for (const occ of detail.tasks) {
      if (occ.status === 'excused') continue;
      if (!perTask.has(occ.taskId)) {
        perTask.set(occ.taskId, {
          taskId: occ.taskId,
          name: occ.name,
          category: occ.category,
          scheduled: 0,
          completed: 0,
          missed: 0,
        });
      }
      const row = perTask.get(occ.taskId);
      row.scheduled += 1;
      if (occ.status === 'completed') row.completed += 1;
      else if (occ.status === 'missed_explained' || occ.status === 'missed_unexplained') row.missed += 1;
    }
  }

  const tasks = [...perTask.values()]
    .map((t) => ({ ...t, rate: t.scheduled > 0 ? Math.round((t.completed / t.scheduled) * 10000) / 10000 : null }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // mostConsistent / mostSkipped need at least 2 scheduled days to be meaningful.
  const eligible = tasks.filter((t) => t.scheduled >= 2);
  const mostConsistent =
    eligible.length > 0
      ? [...eligible].sort(
          (a, b) => (b.rate - a.rate) || (b.scheduled - a.scheduled) || a.name.localeCompare(b.name)
        )[0]
      : null;
  const mostSkipped =
    eligible.length > 0
      ? [...eligible].sort(
          (a, b) => (a.rate - b.rate) || (b.scheduled - a.scheduled) || a.name.localeCompare(b.name)
        )[0]
      : null;

  const reflections = db.all('SELECT reason FROM reflections WHERE date BETWEEN ? AND ?', start, end);
  const reasonGroups = new Map();
  for (const r of reflections) {
    const key = r.reason.trim();
    reasonGroups.set(key, (reasonGroups.get(key) || 0) + 1);
  }
  let mostCommonReason = null;
  if (reasonGroups.size > 0) {
    const [reason, count] = [...reasonGroups.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0];
    mostCommonReason = { reason, count };
  }

  return {
    week: { start, end, weekStarts: clock.weekStarts },
    totals: {
      ...totals,
      completionRate: totals.promised > 0 ? Math.round((totals.completed / totals.promised) * 10000) / 10000 : null,
    },
    days: days.map((d) => ({ date: d.date, status: d.status, counts: d.counts, offDay: d.offDay })),
    tasks,
    mostConsistent,
    mostSkipped,
    mostCommonReason,
  };
}

/**
 * Behavioral insights computed from real history. An insight is only emitted
 * when the data actually supports it; with little data the list is honestly
 * short (possibly empty).
 */
function getInsights(db, { clock }) {
  const earliest = require('./dayService').getEarliestDataDate(db);
  const patterns = [];
  if (!earliest) return { patterns };

  const days = getDaysRange(db, earliest, clock.todayDate, { clock });

  // 1) Day-of-week pattern: only when a weekday clearly stands out.
  const byWeekday = new Map(); // 0..6 -> { promised, missed }
  for (const day of days) {
    if (!['green', 'yellow', 'red'].includes(day.status)) continue;
    const wd = weekdayOf(day.date);
    if (!byWeekday.has(wd)) byWeekday.set(wd, { promised: 0, missed: 0 });
    const agg = byWeekday.get(wd);
    agg.promised += day.counts.promised;
    agg.missed += day.counts.missed;
  }
  const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
  let worstWd = null;
  for (const [wd, agg] of byWeekday) {
    if (agg.promised >= 4 && agg.missed / agg.promised >= 0.5) {
      if (!worstWd || agg.missed / agg.promised > worstWd.ratio) {
        worstWd = { wd, ratio: agg.missed / agg.promised, agg };
      }
    }
  }
  if (worstWd) {
    patterns.push({
      lead: 'Day-of-week pattern',
      content: `You miss promises on ${names[worstWd.wd]} more often than usual (${worstWd.agg.missed} of ${worstWd.agg.promised} missed). A lighter plan for that day might help.`,
    });
  }

  // 2) Most-skipped task overall.
  const perTask = new Map();
  for (const day of days) {
    if (day.status === 'future' || day.status === 'off' || day.counts.promised === 0) continue;
    const detail = getDayDetail(db, day.date, { clock });
    for (const occ of detail.tasks) {
      if (occ.status === 'excused') continue;
      if (!perTask.has(occ.taskId)) perTask.set(occ.taskId, { name: occ.name, scheduled: 0, missed: 0 });
      const t = perTask.get(occ.taskId);
      t.scheduled += 1;
      if (occ.status === 'missed_explained' || occ.status === 'missed_unexplained') t.missed += 1;
    }
  }
  const skipped = [...perTask.values()].filter((t) => t.scheduled >= 3 && t.missed > 0);
  if (skipped.length > 0) {
    const worst = skipped.sort((a, b) => b.missed / b.scheduled - a.missed / a.scheduled)[0];
    patterns.push({
      lead: 'Most-skipped promise',
      content: `"${worst.name}" is your most skipped promise (${worst.missed} of ${worst.scheduled} days missed). Consider resizing it or moving its time.`,
    });
  }

  // 3) Most common reason.
  const reasons = db.all(
    'SELECT reason, COUNT(*) AS n FROM reflections GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 1'
  );
  if (reasons.length > 0 && reasons[0].n >= 2) {
    patterns.push({
      lead: 'Recurring reason',
      content: `Your most common reason is "${reasons[0].reason}" (${reasons[0].n} times). Noticing it is already progress.`,
    });
  }

  return { patterns };
}

module.exports = { getWeeklyReport, getInsights };
