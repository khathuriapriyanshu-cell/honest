'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { publicSettings } = require('./helpers');
const settingsService = require('../services/settingsService');

/**
 * Settings routes.
 *
 * GET /api/settings  current configuration (plus the resolved timezone and the
 *                    server's own view of the date/time)
 * PUT /api/settings  partial or complete update
 */

function createSettingsRoutes(deps) {
  const router = express.Router();

  router.get('/settings', (req, res) => {
    return ok(res, publicSettings(deps));
  });

  const update = (req, res) => {
    settingsService.updateSettings(deps.db, req.body);
    const settings = publicSettings(deps);
    return ok(res, { settings }, 200, { settings });
  };

  router.put('/settings', update);
  router.patch('/settings', update);

  return router;
}

module.exports = { createSettingsRoutes };
