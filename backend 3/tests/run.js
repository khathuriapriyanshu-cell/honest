'use strict';

/**
 * Test entry point.
 *
 *   npm test                     run every suite
 *   npm test -- honest days      run only tests whose name contains the text
 *
 * Runs every suite against temporary databases. The suite is self-contained:
 * it needs no network access and no external services.
 */

const path = require('node:path');
const fs = require('node:fs');

const { runFiles } = require('./helpers');

const filter = process.argv.slice(2).join(' ').trim().toLowerCase() || null;

const files = fs
  .readdirSync(__dirname)
  .filter((name) => /\.test\.js$/.test(name))
  .sort()
  .map((name) => path.join(__dirname, name));

runFiles(files, { filter })
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('test runner crashed:', err);
    process.exitCode = 1;
  });
