'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { vDate } = require('../utils/validate');
const reportService = require('../services/reportService');
const honestyService = require('../services/honestyService');
const { getClockContext } = require('../services/settingsService');
const { formatMonthHuman, formatDateLong, addDays, localDateInTz } = require('../utils/dates');

/** Insight text derived ONLY from the week's real numbers (no canned lines). */
function buildWeeklyInsight(report) {
  const { totals, mostSkipped, mostCommonReason } = report;
  if (totals.promised === 0) return null;
  if (totals.unexplained > 0) {
    return `You have ${totals.unexplained} unexplained miss${totals.unexplained === 1 ? '' : 'es'} this week. Recording the reason keeps your record honest.`;
  }
  if (mostSkipped && mostSkipped.missed > 0) {
    return `"${mostSkipped.name}" was skipped ${mostSkipped.missed} of ${mostSkipped.scheduled} scheduled days this week. A smaller version of it might stick better.`;
  }
  if (mostCommonReason) {
    return `Your most common reason this week was "${mostCommonReason.reason}". Noticing the pattern is already progress.`;
  }
  if (totals.missed === 0 && totals.completed === totals.promised) {
    return 'Every promise this week was kept. Whatever you are doing, keep doing it.';
  }
  return null;
}

function flatWeekly(report) {
  const rate = report.totals.completionRate;
  return {
    completedCount: report.totals.completed,
    totalCount: report.totals.promised,
    completionRate: rate !== null ? Math.round(rate * 1000) / 10 : null,
    mostConsistent: report.mostConsistent
      ? `${report.mostConsistent.name} (${Math.round(report.mostConsistent.rate * 100)}%)`
      : null,
    mostSkipped: report.mostSkipped
      ? `${report.mostSkipped.name} (${Math.round(report.mostSkipped.rate * 100)}%)`
      : null,
    commonReason: report.mostCommonReason ? report.mostCommonReason.reason : null,
    insight: buildWeeklyInsight(report),
    weekStart: report.week.start,
    weekEnd: report.week.end,
  };
}

module.exports = function reportRoutes(ctx) {
  const router = express.Router();

  const weeklyHandler = wrap(async (req, res) => {
    const clock = getClockContext(ctx.db, ctx.now());
    const dateRef = vDate(req.query.date, 'date');
    const report = reportService.getWeeklyReport(ctx.db, { clock, dateRef });
    ok(res, report, flatWeekly(report));
  });
  router.get('/weekly', weeklyHandler); // canonical: /api/reports/weekly

  return router;
};

/** Router mounted at /api/report (frontend alias: /api/report/weekly). */
module.exports.reportAliasRouter = function reportAliasRoutes(ctx2) {
  const router = express.Router();
  router.get(
    '/weekly',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx2.db, ctx2.now());
      const dateRef = vDate(req.query.date, 'date');
      const report = reportService.getWeeklyReport(ctx2.db, { clock, dateRef });
      ok(res, report, flatWeekly(report));
    })
  );
  return router;
};

/** Router mounted at /api/stats (frontend: GET /api/stats/score). */
module.exports.statsRouter = function statsRoutes(ctx3) {
  const router = express.Router();
  router.get(
    '/score',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx3.db, ctx3.now());
      const result = honestyService.getHonestScore(ctx3.db, { clock, window: 'month' });
      ok(
        res,
        result,
        {
          honestyScore: result.score,
          month: formatMonthHuman(clock.todayDate.slice(0, 7)),
          promisesMade: result.breakdown.promisesMade,
          completed: result.breakdown.completed,
          missed: result.breakdown.missed,
          explained: result.breakdown.explained,
          unexplained: result.breakdown.unexplained,
        }
      );
    })
  );
  return router;
};

/** Router mounted at /api/insights. */
module.exports.insightsRouter = function insightsRoutes(ctx4) {
  const router = express.Router();
  router.get(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx4.db, ctx4.now());
      const result = reportService.getInsights(ctx4.db, { clock });
      ok(res, result, { patterns: result.patterns });
    })
  );
  return router;
};

/** Router mounted at /api/archive — searchable honest history. */
module.exports.archiveRouter = function archiveRoutes(ctx5) {
  const router = express.Router();
  router.get(
    '/',
    wrap(async (req, res) => {
      const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
      let rows = ctx5.db.all(
        `SELECT r.*, t.name AS task_name FROM reflections r
           LEFT JOIN tasks t ON t.id = r.task_id
          ORDER BY r.date DESC, r.id DESC LIMIT 500`
      );
      if (q) {
        const needle = q.toLowerCase();
        rows = rows.filter(
          (r) => r.reason.toLowerCase().includes(needle) || (r.task_name || '').toLowerCase().includes(needle)
        );
      }

      // Pattern notice from recent (31-day) reflections, only when a reason repeats.
      const clock = getClockContext(ctx5.db, ctx5.now());
      const since = addDays(clock.todayDate, -31);
      const recent = ctx5.db.all(
        'SELECT reason, COUNT(*) AS n FROM reflections WHERE date >= ? GROUP BY reason ORDER BY n DESC, reason ASC LIMIT 1',
        since
      );
      const patternNotice =
        recent.length > 0 && recent[0].n >= 2
          ? `Your most common reason recently: "${recent[0].reason}" (${recent[0].n} times).`
          : null;

      ok(res, { patternNotice, reflections: rows.map(reflectionFlat) }, {
        patternNotice,
        reflections: rows.map(reflectionFlat),
      });
    })
  );
  return router;
};

function reflectionFlat(r) {
  return {
    id: r.id,
    date: r.date,
    dateLabel: formatDateLong(r.date),
    taskName: r.task_name ?? null,
    reason: r.reason,
    createdAt: r.created_at,
  };
}
