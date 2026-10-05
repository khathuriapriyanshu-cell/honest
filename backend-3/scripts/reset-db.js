'use strict';

/**
 * Development helper: wipes the database file so you can start from a clean,
 * honest slate. Refuses to run against a path outside this project.
 *
 *   npm run reset-db
 */

const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.HONEST_DB
  ? path.resolve(process.env.HONEST_DB)
  : path.resolve(__dirname, '..', 'data', 'honest.db');

const projectRoot = path.resolve(__dirname, '..');
if (!DB_PATH.startsWith(projectRoot)) {
  console.error(`Refusing to delete ${DB_PATH}: it is outside ${projectRoot}.`);
  process.exit(1);
}

const targets = [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`];
let removed = 0;
for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target);
    removed += 1;
    console.log(`removed ${target}`);
  }
}

console.log(removed === 0 ? 'Nothing to remove - the database did not exist yet.' : `Removed ${removed} file(s).`);
console.log('The database will be recreated automatically on the next start.');
