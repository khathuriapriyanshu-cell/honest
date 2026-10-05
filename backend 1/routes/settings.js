'use strict';

const express = require('express');
const { ok, wrap } = require('../utils/respond');
const settingsService = require('../services/settingsService');

function flatSettings(s) {
  return {
    accountabilityTime: s.accountabilityTime,
    dailyReset: s.dailyResetTime,
    gracePeriod: s.gracePeriodMinutes,
    weekStart: s.weekStarts,
    notifications: s.notificationsEnabled,
    theme: s.theme,
    timezone: s.timezone,
    timezoneEffective: s.timezoneEffective,
  };
}

module.exports = function settingsRoutes(ctx) {
  const router = express.Router();

  router.get(
    '/',
    wrap(async (req, res) => {
      const s = settingsService.getSettings(ctx.db);
      ok(res, s, flatSettings(s));
    })
  );

  const update = wrap(async (req, res) => {
    const s = settingsService.updateSettings(ctx.db, req.body);
    ok(res, { settings: s }, { settings: flatSettings(s), ...flatSettings(s) });
  });
  router.put('/', update);
  router.patch('/', update);

  return router;
};
