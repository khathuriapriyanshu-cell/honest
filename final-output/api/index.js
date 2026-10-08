'use strict';

/**
 * Vercel serverless entry point.
 *
 * Vercel's Node runtime calls the exported handler with `(req, res)` for every
 * request. An Express application *is* exactly such a handler, so the backend
 * runs unmodified - the only requirement is that this file exports it, which it
 * does in every shape Vercel and other platforms look for (`module.exports`,
 * `.default`, and a named `handler`).
 *
 * Deployment notes
 * ----------------
 *   - `vercel.json` rewrites every path to this function, so the Express router
 *     sees the original URL and all `/api/...` routes work unchanged.
 *   - The database is opened on the first request, not at import time.
 *   - A local SQLite file is ephemeral on Vercel. Configure a remote database:
 *
 *       TURSO_DATABASE_URL = libsql://<database>-<org>.turso.io
 *       TURSO_AUTH_TOKEN   = <token>
 *
 *   - Timers do not survive between invocations, so the accountability
 *     scheduler must be driven by Vercel Cron hitting `GET /api/cron/tick`
 *     with `CRON_SECRET`.
 */

const { createBootstrap } = require('../bootstrap');

// One bootstrap per function instance. Warm invocations reuse the open
// database connection; cold starts skip it until a request actually arrives.
const bootstrap = createBootstrap({ verbose: process.env.HONEST_QUIET !== '1' });

/** The Express app is the request handler. */
const handler = bootstrap.app;

module.exports = handler;
module.exports.default = handler;
module.exports.handler = handler;
module.exports.app = handler;

// Useful for diagnostics from a deployment shell or an integration test.
module.exports.bootstrap = bootstrap;
module.exports.createApp = require('../app').createApp;
module.exports.API_INDEX = require('../app').API_INDEX;
