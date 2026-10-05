'use strict';

const express = require('express');
const { ok } = require('../middleware/respond');
const { dayStatePayload, queryValue } = require('./helpers');

/**
 * Daily state routes.
 *
 * GET /api/today  - the authoritative "what is today?" payload
 * GET /api/day    - the same payload for any date (defaults to today)
 */

function createDayRoutes(deps) {
  const router = express.Router();

  router.get('/today', (req, res) => {
    const date = queryValue(req, 'date');
    return ok(res, dayStatePayload(deps, date));
  });

  router.get('/day', (req, res) => {
    const date = queryValue(req, 'date');
    return ok(res, dayStatePayload(deps, date));
  });

  return router;
}

module.exports = { createDayRoutes };
