'use strict';

/**
 * App factory. Tests inject a controlled clock via `now`; server.js uses the
 * real system clock. The database file is created and initialized
 * automatically on first boot.
 */

const path = require('path');
const express = require('express');
const { openDatabase } = require('./database/db');
const { initializeSchema } = require('./database/schema');
const buildApi = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const DEFAULT_DB_PATH = path.join(__dirname, 'database', 'honest.sqlite');

function createApp({ dbPath, now = () => new Date() } = {}) {
  const db = openDatabase(dbPath || DEFAULT_DB_PATH);
  initializeSchema(db);

  const app = express();
  app.disable('x-powered-by');

  // CORS: the frontend runs on a different port during development.
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '256kb' }));
  app.use('/api', buildApi({ db, now }));
  app.use(notFoundHandler);
  app.use(errorHandler);

  app.locals.db = db;
  app.locals.now = now;
  return app;
}

module.exports = { createApp, DEFAULT_DB_PATH };
