'use strict';

/**
 * Persistence, restart behaviour and process-level startup.
 *
 * The product promise is that honesty is remembered: closing the server must
 * never erase a promise, a completion, a reason or an honest-day streak.
 */

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const { openDatabase } = require('../database/db');
const { getRuntimeSettings } = require('../services/settingsService');

const { createContext, restartContext, assertTrue, assertEqual, assertIncludes } = require('./helpers');

/**
 * A "restart" is a brand new process-shaped instance: a new connection to the
 * same database file, a new clock reading the persisted offset, a new scheduler
 * and a new HTTP server.
 */
function restart(ctx, options) {
  return restartContext(ctx, options);
}

module.exports = function persistenceTests() {
  return {
    'promises, completions and reflections survive a full restart': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });

        await ctx.put('/api/tasks/1/complete');
        await ctx.post('/api/night-check/reflect', {
          reason: 'Club work ran long.',
          taskIds: [2],
        });

        const before = await ctx.get('/api/today');
        const scoreBefore = await ctx.get('/api/stats/score');

        await ctx.close();

        const second = await restart(ctx);
        try {
          const after = await second.get('/api/today');
          assertEqual(after.status, 200, 'the restarted server answers');
          assertEqual(after.body.tasks.length, 3, 'all three promises are still there');
          assertEqual(
            after.body.tasks.find((t) => t.title === 'Coding').completed,
            true,
            'the completion survived'
          );
          assertEqual(
            after.body.tasks.find((t) => t.title === 'Workout').state,
            'missed_explained',
            'the explanation survived'
          );
          assertEqual(after.body.counts.completed, before.body.counts.completed, 'counts agree');
          assertEqual(after.body.counts.unresolved, before.body.counts.unresolved, 'unresolved counts agree');
          assertEqual(after.body.honestDays, before.body.honestDays, 'the honest-day streak survived');

          const archive = await second.get('/api/archive');
          assertEqual(archive.body.reflections.length, 1, 'the reflection is still archived');
          assertEqual(archive.body.reflections[0].reason, 'Club work ran long.', 'with its exact wording');

          const scoreAfter = await second.get('/api/stats/score');
          assertEqual(scoreAfter.body.honestyScore, scoreBefore.body.honestyScore, 'the score is unchanged');
          assertEqual(scoreAfter.body.explained, scoreBefore.body.explained, 'and so are its inputs');
        } finally {
          await second.close();
        }
      } finally {
        await ctx.cleanup();
      }
    },

    'history from earlier days is still accurate after a restart': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const dayOne = ctx.today();
        const target = ctx.shiftDate(dayOne, -2);
        // The promise exists from the day it was answered, as it would in
        // reality - the backend never records an answer for a day the promise
        // did not exist on.
        await ctx.post('/api/tasks', { title: 'Daily habit', repeat: 'daily', startDate: target });
        ctx.db
          .prepare(
            `INSERT INTO task_occurrences (task_id, date, status, completed, task_name, completed_at, created_at, updated_at)
             VALUES (1, ?, 'completed', 1, 'Daily habit', ?, ?, ?)`
          )
          .run(target, `${target}T18:00:00Z`, 'x', 'x');

        const before = await ctx.get(`/api/calendar/day/${target}`);
        assertEqual(before.body.status, 'completed', 'the historic day is completed before the restart');
        await ctx.close();

        const second = await restart(ctx);
        try {
          const after = await second.get(`/api/calendar/day/${target}`);
          assertEqual(after.status, 200, 'historic days remain readable');
          assertEqual(after.body.status, before.body.status, 'with the same status');
          assertEqual(after.body.completed, before.body.completed, 'and the same completion count');
          assertEqual(after.body.tasks[0].title, 'Daily habit', 'and the frozen promise name');
        } finally {
          await second.close();
        }
      } finally {
        await ctx.cleanup();
      }
    },

    'the scheduler does not re-notify after a restart': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:35',
        settings: { accountabilityTime: '22:30', gracePeriod: 15 },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        ctx.scheduler.runNow();
        const logged = ctx.count('notification_log');
        assertEqual(logged, 1, 'the accountability event was recorded once');

        await ctx.close();
        const second = await restart(ctx);
        try {
          // The restarted process runs its own startup tick.
          second.scheduler.runNow();
          const notifications = await second.get('/api/notifications');
          assertEqual(notifications.body.count, 1, 'the user is not re-notified for the same event');
          assertEqual(
            second.db.prepare('SELECT COUNT(*) AS n FROM notification_log').get().n,
            1,
            'and no duplicate row was written'
          );
        } finally {
          await second.close();
        }
      } finally {
        await ctx.cleanup();
      }
    },

    'settings survive a restart': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        await ctx.put('/api/settings', {
          accountabilityTime: '23:00',
          gracePeriod: 25,
          weekStart: 'sunday',
          theme: 'light',
          timezone: 'America/New_York',
        });
        await ctx.close();

        const second = await restart(ctx);
        try {
          const settings = await second.get('/api/settings');
          assertEqual(settings.body.accountabilityTime, '23:00', 'accountability time persisted');
          assertEqual(settings.body.gracePeriod, 25, 'grace period persisted');
          assertEqual(settings.body.weekStart, 'sunday', 'week start persisted');
          assertEqual(settings.body.theme, 'light', 'theme persisted');
          assertEqual(settings.body.timezone, 'America/New_York', 'timezone persisted');
          assertEqual(settings.body.timezoneResolved, 'America/New_York', 'and is applied');
        } finally {
          await second.close();
        }
      } finally {
        await ctx.cleanup();
      }
    },

    'an off day survives a restart and still suspends that day': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/off-day', { reason: 'Travel' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });
        await ctx.put('/api/tasks/2/complete');

        await ctx.close();
        const second = await restart(ctx);
        try {
          const state = await second.get('/api/today');
          assertEqual(state.body.isOffDay, true, 'the off day is still in force');
          assertEqual(state.body.offDayReason, 'Travel', 'with its reason');
          assertEqual(state.body.counts.unresolved, 0, 'and no promise counts as unresolved');
        } finally {
          await second.close();
        }
      } finally {
        await ctx.cleanup();
      }
    },

    'the real server starts, serves the API, and shuts down cleanly': async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-proc-'));
      const dbFile = path.join(dir, 'proc.db');
      const script = path.join(__dirname, '..', 'scripts', 'start-probe.js');
      try {
        const result = spawnSync(process.execPath, [script], {
          env: { ...process.env, HONEST_DB: dbFile, PORT: '0', HONEST_DISABLE_SCHEDULER: '1' },
          encoding: 'utf8',
          timeout: 30000,
        });
        const output = `${result.stdout || ''}${result.stderr || ''}`;
        assertEqual(result.status, 0, `the probe process exits cleanly (output: ${output.slice(-400)})`);
        assertIncludes(output, 'HONEST backend', 'the startup banner is printed');
        assertIncludes(output, 'API            http://localhost:', 'the API URL is announced');
        assertIncludes(output, 'health', 'the probe made a real request to a real endpoint');
        assertIncludes(output, 'tasks=', 'and read real data back from it');
        assertEqual(fs.existsSync(dbFile), true, 'the database file was created on disk');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    'the same database file is never created twice or reset on boot': async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-reopen-'));
      const dbFile = path.join(dir, 'persist.db');
      try {
        const first = openDatabase(dbFile);
        first.db
          .prepare(
            `INSERT INTO tasks (name, category, repeat_type, repeat_days, start_date, created_at, updated_at, status)
             VALUES ('Keep me', 'Study', 'daily', '[]', '2026-01-01', 'x', 'x', 'active')`
          )
          .run();
        first.db.close();

        const second = openDatabase(dbFile);
        const count = second.db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
        assertEqual(count, 1, 'the existing row is still there');
        assertEqual(second.migration.applied, false, 'and no migration was re-run');
        second.db.close();

        const fileSize = fs.statSync(dbFile).size;
        assertTrue(fileSize > 0, 'the database has real content on disk');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    'runtime settings resolve "auto" to a concrete timezone': async () => {
      // A timezone setting of "auto" follows the host, so the resolved zone is
      // whatever this machine is in - the point is that it is always concrete.
      const ctx = await createContext({ timezone: 'auto', localTime: '10:00' });
      try {
        const runtime = getRuntimeSettings(ctx.db);
        assertEqual(runtime.timezone, 'auto', 'the stored setting stays automatic');
        assertTrue(runtime.resolvedTimezone.length > 0, 'but a concrete zone is resolved for logic');
        assertTrue(
          runtime.resolvedTimezone.includes('/') || runtime.resolvedTimezone === 'UTC',
          `the resolved zone looks like an IANA name (got ${runtime.resolvedTimezone})`
        );
        assertEqual(runtime.offDayCutoff, runtime.dailyReset, 'the off-day cutoff defaults to the daily reset');

        const time = await ctx.get('/api/time');
        assertEqual(time.body.timezone, runtime.resolvedTimezone, 'and the API reports it');
        assertEqual(time.body.serverDate, ctx.today(), 'with the same idea of today as the rest of the API');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
