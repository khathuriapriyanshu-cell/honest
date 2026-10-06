'use strict';

/**
 * Client-alignment contracts.
 *
 * These pin the exact request/response shapes the web client and the Android app
 * depend on:
 *
 *   GET  /api/calendar/:date    day detail with per-promise status
 *   POST /api/reflections       reason + missed promise names, persisted
 *   GET  /api/reflections       every day's reason, newest first
 *   PUT  /api/settings          dailyCheckTime / dayResetTime aliases
 *
 * They exist because these four shapes were the ones most likely to drift apart
 * between the two clients, and each has a matching negative case so a silent
 * failure cannot pass.
 */

const { createContext, assertTrue, assertEqual, assertIncludes } = require('./helpers');

module.exports = function clientContractTests() {
  return {
    'GET /api/calendar/:date returns the documented day shape': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');
        const date = ctx.today();

        const res = await ctx.get(`/api/calendar/${date}`);
        assertEqual(res.status, 200, 'the short form is served');
        assertEqual(res.body.success, true, 'with a success envelope');

        // `data` must be the object, not the mirrored top level.
        assertEqual(Array.isArray(res.body.data), false, 'data is an object');
        const day = res.body.data;
        assertEqual(day.date, date, 'data.date is the ISO date');
        assertTrue(['completed', 'explained', 'unresolved', 'active'].includes(day.status), `data.status is a known value (got ${day.status})`);
        assertTrue(Array.isArray(day.tasks), 'data.tasks is an array');
        assertEqual(day.tasks.length, 3, 'all three promises are listed');
        assertTrue('reflection' in day, 'data.reflection is present');

        for (const task of day.tasks) {
          assertTrue(typeof task.id === 'string' || typeof task.id === 'number', 'each task has an id');
          assertTrue(typeof task.name === 'string' && task.name.length > 0, 'each task has a name');
          assertTrue(['completed', 'missed'].includes(task.status), `each task status is completed|missed (got ${task.status})`);
          assertTrue('completedAt' in task, 'each task carries completedAt');
        }

        const coding = day.tasks.find((t) => t.name === 'Coding');
        assertEqual(coding.status, 'completed', 'a kept promise reports completed');
        assertEqual(typeof coding.completedAt, 'string', 'and a real completion timestamp');
        const workout = day.tasks.find((t) => t.name === 'Workout');
        assertEqual(workout.status, 'missed', 'an unanswered promise reports missed');
        assertEqual(workout.completedAt, null, 'with no completion timestamp');
        assertEqual(day.reflection, null, 'and no reason yet');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'GET /api/calendar/:date agrees with /api/calendar/day/:date': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');
        const date = ctx.today();

        const short = await ctx.get(`/api/calendar/${date}`);
        const long = await ctx.get(`/api/calendar/day/${date}`);
        assertEqual(short.status, 200, 'the alias responds');
        assertEqual(long.status, 200, 'the canonical route responds');
        assertEqual(short.body.data.status, long.body.data.status, 'same status');
        assertEqual(short.body.data.completed, long.body.data.completed, 'same completed count');
        assertEqual(short.body.data.tasks.length, long.body.data.tasks.length, 'same task list length');
        assertEqual(
          JSON.stringify(short.body.data.tasks.map((t) => [t.id, t.name, t.status])),
          JSON.stringify(long.body.data.tasks.map((t) => [t.id, t.name, t.status])),
          'same task identities and statuses'
        );

        // `/calendar/day` must not be swallowed by the short alias.
        assertEqual(long.body.data.date, date, 'the canonical route still resolves its own date');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'GET /api/calendar/:date rejects nonsense and future dates': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        const bad = await ctx.get('/api/calendar/not-a-date');
        assertEqual(bad.status, 400, 'a non-date is rejected');
        assertEqual(bad.body.error.code, 'INVALID_DATE', 'with a specific code');

        const future = await ctx.get(`/api/calendar/${ctx.shiftDate(ctx.today(), 3)}`);
        assertEqual(future.status, 400, 'a future date has no history');
        assertEqual(future.body.error.code, 'DATE_IN_FUTURE', 'with a specific code');

        const missing = await ctx.get('/api/calendar/9999-99-99');
        assertEqual(missing.status, 400, 'an impossible date is rejected');

        // A reserved literal must reach the not-found handler rather than being
        // parsed as a date, so a typo produces an honest 404.
        const unknown = await ctx.get('/api/calendar/today');
        assertEqual(unknown.status, 404, 'a reserved word is not treated as a date');
        assertEqual(unknown.body.error.code, 'ROUTE_NOT_FOUND', 'and it reports the route as unknown');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'POST /api/reflections accepts missed task names and closes the day': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');
        const date = ctx.today();

        const res = await ctx.post('/api/reflections', {
          date,
          reason: 'Got back late from college and club work ran long.',
          missedTasks: ['Workout', 'Reading'],
        });
        assertEqual(res.status, 200, 'the reflection is accepted');
        assertEqual(res.body.success, true, 'with a success envelope');
        assertEqual(res.body.remainingUnresolved, 0, 'every missed promise is explained');
        assertEqual(res.body.dayResolved, true, 'so the day is resolved');
        assertEqual(res.body.date, date, 'against the requested date');
        assertEqual(res.body.explainedTaskIds.sort().join(','), '2,3', 'and only the named promises');

        // Persisted permanently, not only in the response.
        const stored = ctx.db.prepare('SELECT date, reason FROM reflections ORDER BY task_id').all();
        assertEqual(stored.length, 2, 'two reflection rows were written');
        assertTrue(
          stored.every((row) => row.reason === 'Got back late from college and club work ran long.'),
          'with the exact sentence'
        );
        assertTrue(stored.every((row) => row.date === date), 'against the right day');

        const missed = ctx.db
          .prepare("SELECT COUNT(*) AS n FROM task_occurrences WHERE status = 'missed_explained'")
          .get();
        assertEqual(missed.n, 2, 'the occurrences are recorded as missed-but-explained');

        // The day now reports as explained once it is history.
        ctx.advanceToNextDay(1);
        const history = await ctx.get(`/api/calendar/${date}`);
        assertEqual(history.body.data.status, 'explained', 'the day status becomes explained');
        assertIncludes(history.body.data.reflection, 'Got back late from college', 'and the reason is on the record');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'POST /api/reflections accepts ids and case-insensitive names': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Read 20 Pages', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const date = ctx.today();

        const byName = await ctx.post('/api/reflections', {
          date,
          reason: 'Ran out of evening time.',
          missedTasks: ['read 20 PAGES'],
        });
        assertEqual(byName.status, 200, 'names match case-insensitively');
        assertEqual(byName.body.explainedTaskIds.join(','), '1', 'and resolve to the right promise');

        const byId = await ctx.post('/api/reflections', {
          date,
          reason: 'And the workout slipped.',
          missedTasks: ['2'],
        });
        assertEqual(byId.status, 200, 'a numeric entry is treated as an id');
        assertEqual(byId.body.explainedTaskIds.join(','), '2', 'resolving to the second promise');
        assertEqual(byId.body.remainingUnresolved, 0, 'the day is now fully explained');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'POST /api/reflections rejects an unknown or resolved promise': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        const date = ctx.today();

        const unknown = await ctx.post('/api/reflections', {
          date,
          reason: 'Explaining something that is not on the day.',
          missedTasks: ['Nonexistent promise'],
        });
        assertEqual(unknown.status, 400, 'an unknown promise name is rejected');
        assertEqual(unknown.body.error.code, 'TASK_NOT_ON_DATE', 'with a specific code');
        assertIncludes(
          JSON.stringify(unknown.body.error.details),
          'Coding',
          'and the available promises are listed so the client can correct itself'
        );
        assertEqual(ctx.count('reflections'), 0, 'nothing was written');

        await ctx.put('/api/tasks/1/complete');
        const resolved = await ctx.post('/api/reflections', {
          date,
          reason: 'Trying to explain a promise that was kept.',
          missedTasks: ['Coding'],
        });
        assertEqual(resolved.status, 409, 'an already resolved promise is a conflict');
        assertEqual(resolved.body.error.code, 'TASK_ALREADY_RESOLVED', 'with a specific code');

        const malformed = await ctx.post('/api/reflections', {
          date,
          reason: 'Malformed missed task list.',
          missedTasks: 'Coding',
        });
        assertEqual(malformed.status, 400, 'a non-array missedTasks is rejected');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'GET /api/reflections returns every day newest first': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const first = ctx.today();

        // Day one: two promises explained with one sentence.
        await ctx.post('/api/reflections', {
          date: first,
          reason: 'Club work took longer than expected.',
          missedTasks: ['Coding', 'Workout'],
        });

        // Day two: one promise explained with a different sentence.
        ctx.advanceToNextDay(1);
        const second = ctx.today();
        await ctx.post('/api/reflections', {
          date: second,
          reason: 'Slept early with a headache.',
          missedTasks: ['Workout'],
        });

        const res = await ctx.get('/api/reflections');
        assertEqual(res.status, 200, 'the list is served');
        assertEqual(Array.isArray(res.body.data), true, 'data is an array');

        const days = res.body.data;
        assertEqual(days.length, 2, 'one entry per day');
        assertEqual(days[0].date, second, 'newest day first');
        assertEqual(days[1].date, first, 'oldest day last');
        assertTrue(days[0].date > days[1].date, 'strictly descending');

        for (const day of days) {
          assertTrue(typeof day.date === 'string', 'each entry has an ISO date');
          assertTrue(typeof day.reason === 'string' && day.reason.length > 0, 'each entry has a reason');
          assertTrue(Array.isArray(day.missedTasks), 'each entry has a missedTasks array');
          assertTrue(day.missedTasks.every((name) => typeof name === 'string'), 'containing names');
        }

        assertEqual(days[0].missedTasks.join(','), 'Workout', 'day two names its one promise');
        assertEqual(days[1].missedTasks.join(','), 'Coding,Workout', 'day one names both, in day order');
        assertEqual(days[1].reason, 'Club work took longer than expected.', 'and its single sentence is not duplicated');

        // The mirrored top-level key stays for clients written against it.
        assertEqual(res.body.reflections.length, 2, 'the mirrored key carries the same days');

        const filtered = await ctx.get('/api/reflections?q=headache');
        assertEqual(filtered.body.data.length, 1, 'keyword search filters the list');
        assertEqual(filtered.body.data[0].date, second, 'to the matching day');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'PUT /api/settings persists dailyCheckTime and dayResetTime': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const res = await ctx.put('/api/settings', {
          dailyCheckTime: '22:45',
          dayResetTime: '03:30',
        });
        assertEqual(res.status, 200, 'the mobile field names are accepted');
        assertEqual(res.body.success, true, 'with a success envelope');
        assertEqual(res.body.settings.accountabilityTime, '22:45', 'dailyCheckTime persists as accountabilityTime');
        assertEqual(res.body.settings.dailyReset, '03:30', 'dayResetTime persists as dailyReset');
        assertEqual(res.body.settings.dailyCheckTime, '22:45', 'and the alias is echoed back');
        assertEqual(res.body.settings.dayResetTime, '03:30', 'for both names');

        // Persisted, not merely echoed: read it back through a separate request.
        const read = await ctx.get('/api/settings');
        assertEqual(read.body.accountabilityTime, '22:45', 'the stored accountability time');
        assertEqual(read.body.dailyReset, '03:30', 'the stored daily reset');
        assertEqual(read.body.dailyCheckTime, '22:45', 'GET exposes the alias too');
        assertEqual(read.body.dayResetTime, '03:30', 'so a mobile client can skip the mapping');

        // The aliases drive real behaviour, not just storage.
        const rows = ctx.db.prepare("SELECT key, value FROM settings WHERE key IN ('accountabilityTime','dailyReset')").all();
        const map = Object.fromEntries(rows.map((row) => [row.key, row.value]));
        assertEqual(map.accountabilityTime, '22:45', 'written to the canonical column');
        assertEqual(map.dailyReset, '03:30', 'and the canonical reset column');

        const time = await ctx.get('/api/time');
        assertEqual(time.body.accountabilityTime, '22:45', 'the runtime settings agree');
        assertEqual(time.body.dailyReset, '03:30', 'for both values');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'PUT /api/settings accepts the web payload including apiUrl': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        // Exactly what the web client sends today.
        const res = await ctx.put('/api/settings', {
          accountabilityTime: '22:30',
          dailyReset: '00:00',
          notifications: true,
          theme: 'dark',
          apiUrl: 'http://localhost:3000/api',
        });
        assertEqual(res.status, 200, 'the web payload is accepted');
        assertTrue('apiUrl' in res.body.settings, 'apiUrl is echoed back for the client that sent it');
        assertEqual(res.body.settings.theme, 'dark', 'and the real settings are applied');

        // apiUrl is the client's own concern and must never be persisted as a
        // server setting.
        const stored = ctx.db.prepare('SELECT value FROM settings WHERE key = ?').get('apiUrl');
        assertEqual(stored, undefined, 'apiUrl is not stored on the server');

        const mixed = await ctx.put('/api/settings', {
          dailyCheckTime: '21:00',
          dayResetTime: '04:00',
          notifications: false,
          apiUrl: '',
        });
        assertEqual(mixed.status, 200, 'aliases and client fields can be sent together');
        assertEqual(mixed.body.settings.accountabilityTime, '21:00', 'the alias wins cleanly');
        assertEqual(mixed.body.settings.notifications, false, 'and other fields still apply');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'PUT /api/settings refuses conflicting, malformed and unknown fields': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const conflict = await ctx.put('/api/settings', {
          dailyCheckTime: '22:00',
          accountabilityTime: '23:00',
        });
        assertEqual(conflict.status, 400, 'two names for one setting with different values is a conflict');
        assertEqual(conflict.body.error.code, 'CONFLICTING_SETTING', 'with a specific code');

        const same = await ctx.put('/api/settings', {
          dailyCheckTime: '22:00',
          accountabilityTime: '22:00',
        });
        assertEqual(same.status, 200, 'the same value under both names is fine');
        assertEqual(same.body.settings.accountabilityTime, '22:00', 'and is applied');

        const badTime = await ctx.put('/api/settings', { dailyCheckTime: '25:00' });
        assertEqual(badTime.status, 400, 'an impossible time is rejected through the alias too');
        assertEqual(badTime.body.error.code, 'INVALID_TIME', 'with a specific code');

        const badBody = await ctx.put('/api/settings', { dailyCheckTime: '22:00', dayResetTime: 'not-a-time' });
        assertEqual(badBody.status, 400, 'an impossible reset time is rejected');

        const unknown = await ctx.put('/api/settings', { favouriteColour: 'blue' });
        assertEqual(unknown.status, 400, 'a genuinely unknown key is still rejected');
        assertEqual(unknown.body.error.code, 'UNKNOWN_SETTING', 'with a specific code and the allowed list');
        assertIncludes(JSON.stringify(unknown.body.error.details.allowed), 'dailyCheckTime', 'which names the aliases');

        // Nothing invalid was written.
        const read = await ctx.get('/api/settings');
        assertEqual(read.body.accountabilityTime, '22:00', 'the last valid value is still in force');
        assertEqual(read.body.dailyReset, '00:00', 'and the untouched reset is unchanged');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
