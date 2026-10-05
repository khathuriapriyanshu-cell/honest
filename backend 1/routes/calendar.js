'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const { getClockContext } = require('../services/settingsService');
const { getDayDetail, getDaysRange } = require('../services/dayService');
const { formatMonthHuman, formatDateLong, addDays } = require('../utils/dates');
const { vDate, assertBodyObject } = require('../utils/validate');
const { badRequest } = require('../utils/errors');

/** Canonical day status -> frontend calendar status. */
const FRONTEND_STATUS = {
  green: 'completed',
  yellow: 'explained',
  red: 'unresolved',
  pending: 'active',
  off: 'off',
  no_promises: 'none',
  future: 'future',
};

function flatDay(detail) {
  const reflection =
    detail.dayReflection ||
    (detail.tasks.find((t) => t.reflection) ? detail.tasks.find((t) => t.reflection).reflection : null);
  return {
    date: detail.date,
    completed: detail.counts.completed,
    total: detail.counts.promised,
    status: FRONTEND_STATUS[detail.status] || detail.status,
    reflection: reflection ? reflection.reason : null,
    tasks: detail.tasks.map((t) => ({
      id: t.taskId,
      title: t.name,
      completed: t.status === 'completed',
      status: t.status,
      reflection: t.reflection ? t.reflection.reason : null,
    })),
  };
}

module.exports = function calendarRoutes(ctx) {
  const router = express.Router();

  // Month mode (frontend): GET /api/calendar?month=10&year=2026
  // Range mode (canonical): GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD
  router.get(
    '/',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const { month, year, from, to } = req.query;

      if (month !== undefined || year !== undefined) {
        const m = Number(month);
        const y = Number(year);
        if (!Number.isInteger(m) || m < 1 || m > 12 || !Number.isInteger(y) || y < 1970 || y > 2999) {
          throw badRequest('VALIDATION_ERROR', 'month must be 1-12 and year a valid number.');
        }
        const monthStr = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
        const start = `${monthStr}-01`;
        const endDate = new Date(Date.UTC(y, m, 0));
        const end = `${endDate.getUTCFullYear()}-${String(endDate.getUTCMonth() + 1).padStart(2, '0')}-${String(endDate.getUTCDate()).padStart(2, '0')}`;
        const days = getDaysRange(ctx.db, start, end, { clock });
        const reflections = ctx.db.all('SELECT * FROM reflections WHERE date BETWEEN ? AND ?', start, end);
        const reflByDate = new Map();
        for (const r of reflections) {
          if (!reflByDate.has(r.date)) reflByDate.set(r.date, r.reason);
        }
        const history = {};
        for (const d of days) {
          history[d.date] = {
            status: FRONTEND_STATUS[d.status] || d.status,
            completed: d.counts.completed,
            total: d.counts.promised,
            reflection: d.status === 'yellow' || d.status === 'red' ? reflByDate.get(d.date) ?? null : null,
            offDay: d.offDay,
          };
        }
        ok(res, { month: monthStr, from: start, to: end, days }, { month: formatMonthHuman(monthStr), history });
        return;
      }

      const fromDate = vDate(from, 'from', { defaultValue: addDays(clock.todayDate, -29) });
      const toDate = vDate(to, 'to', { defaultValue: clock.todayDate });
      const days = getDaysRange(ctx.db, fromDate, toDate, { clock });
      ok(res, { from: fromDate, to: toDate, days });
    })
  );

  // Frontend day detail: GET /api/calendar/day/:date
  router.get(
    '/day/:date',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const date = vDate(req.params.date, 'date', { required: true });
      const detail = getDayDetail(ctx.db, date, { clock });
      ok(res, detail, {
        date: detail.date,
        dateLabel: formatDateLong(detail.date),
        completed: detail.counts.completed,
        total: detail.counts.promised,
        status: FRONTEND_STATUS[detail.status] || detail.status,
        reflection:
          detail.dayReflection?.reason ||
          (detail.tasks.find((t) => t.reflection)?.reflection?.reason ?? null),
        offDay: detail.offDay ? detail.offDay.reason : null,
        tasks: detail.tasks.map((t) => ({
          id: t.taskId,
          title: t.name,
          name: t.name,
          completed: t.status === 'completed',
          status: t.status,
          reflection: t.reflection ? t.reflection.reason : null,
        })),
      });
    })
  );

  // Canonical day detail: GET /api/calendar/:date (same data, rich shape)
  router.get(
    '/:date',
    wrap(async (req, res) => {
      const clock = getClockContext(ctx.db, ctx.now());
      const date = vDate(req.params.date, 'date', { required: true });
      ok(res, getDayDetail(ctx.db, date, { clock }));
    })
  );

  return router;
};
