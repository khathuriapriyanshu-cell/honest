'use strict';

/**
 * API contract, validation and error handling.
 *
 * Two things matter here:
 *   1. The documented response shapes are actually produced (the frontend must
 *      not have to guess);
 *   2. Malformed input never crashes the server and never silently "succeeds".
 */

const { createContext, assertTrue, assertEqual, assertIncludes, assertNotIncludes, assertMatch } = require('./helpers');

module.exports = function contractTests() {
  return {
    'success responses carry both the documented fields and a data envelope': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const res = await ctx.get('/api/today');
        assertEqual(res.status, 200, 'ok');
        assertEqual(res.body.success, true, 'success flag');
        assertTrue(res.body.data !== undefined, 'a data envelope is present');
        assertEqual(res.body.data.isoDate, res.body.isoDate, 'and mirrors the documented fields');
        assertEqual(res.body.data.tasks.length, res.body.tasks.length, 'consistently');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'error responses use the documented shape with a stable code': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.get('/api/tasks/424242');
        assertEqual(res.status, 404, 'unknown resource');
        assertEqual(res.body.success, false, 'failure flag');
        assertTrue(typeof res.body.error.code === 'string', 'a machine readable code is present');
        assertTrue(typeof res.body.error.message === 'string', 'and a human readable message');
        assertEqual(res.body.message, res.body.error.message, 'the legacy top-level message mirrors it');
        assertNotIncludes(JSON.stringify(res.body), 'SELECT', 'no SQL leaks into the response');
        assertNotIncludes(JSON.stringify(res.body), 'sqlite', 'no driver detail leaks into the response');
        assertNotIncludes(JSON.stringify(res.body), 'task_occurrences', 'no table names leak into the response');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'malformed JSON is rejected without crashing the server': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.request('POST', '/api/tasks', '{"title": "Broken"');
        assertEqual(res.status, 400, 'a broken body is a client error');
        assertEqual(res.body.error.code, 'MALFORMED_JSON', 'with a specific code');

        const after = await ctx.get('/api/health');
        assertEqual(after.status, 200, 'the server is still healthy afterwards');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'unknown routes and methods are reported clearly': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.get('/api/does-not-exist');
        assertEqual(res.status, 404, 'an unknown endpoint is a 404');
        assertEqual(res.body.error.code, 'ROUTE_NOT_FOUND', 'with a specific code');
        assertIncludes(res.body.error.message, 'GET /api', 'and it points at the endpoint index');

        const wrongMethod = await ctx.del('/api/settings');
        assertEqual(wrongMethod.status, 404, 'an unsupported method on a real path is also a 404');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'the endpoint index and health check describe the API honestly': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const index = await ctx.get('/api');
        assertEqual(index.status, 200, 'the index is available');
        assertEqual(index.body.name, 'HONEST backend', 'and names the service');
        assertTrue(index.body.endpoints.promises.length > 0, 'and lists the promise endpoints');
        assertTrue(index.body.endpoints.analytics.length > 0, 'and the analytics endpoints');

        const health = await ctx.get('/api/health');
        assertEqual(health.body.status, 'ok', 'health reports ok');
        assertEqual(health.body.database, 'ok', 'with a real database probe');
        assertTrue(health.body.schemaVersion >= 1, 'and the schema version');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'the time endpoint documents the server clock': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:15' });
      try {
        const res = await ctx.get('/api/time');
        assertEqual(res.status, 200, 'the time endpoint is available');
        assertEqual(res.body.serverDate, ctx.today(), 'the authoritative date');
        assertEqual(res.body.serverTime, '20:15', 'the local wall clock');
        assertEqual(res.body.timezone, 'Asia/Kolkata', 'the resolved timezone');
        assertEqual(res.body.dailyReset, '00:00', 'the reset time');
        assertEqual(res.body.accountabilityTime, '22:30', 'the accountability time');
        assertEqual(res.body.gracePeriod, 15, 'the grace period');
        assertIncludes(res.body.note, 'source of truth', 'and states that the backend owns the date');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'settings validation rejects nonsense and unknown keys': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const time = await ctx.put('/api/settings', { accountabilityTime: '24:00' });
        assertEqual(time.status, 400, 'an impossible accountability time is rejected');
        assertEqual(time.body.error.code, 'INVALID_TIME', 'with a specific code');

        const grace = await ctx.put('/api/settings', { gracePeriod: -5 });
        assertEqual(grace.status, 400, 'a negative grace period is rejected');

        const graceTooBig = await ctx.put('/api/settings', { gracePeriod: 9999 });
        assertEqual(graceTooBig.status, 400, 'an absurd grace period is rejected');

        const week = await ctx.put('/api/settings', { weekStart: 'tuesday' });
        assertEqual(week.status, 400, 'a week start other than monday/sunday is rejected');

        const theme = await ctx.put('/api/settings', { theme: 'neon' });
        assertEqual(theme.status, 400, 'an unknown theme is rejected');

        const notifications = await ctx.put('/api/settings', { notifications: 'maybe' });
        assertEqual(notifications.status, 400, 'a non-boolean notifications flag is rejected');

        const unknown = await ctx.put('/api/settings', { favouriteColour: 'blue' });
        assertEqual(unknown.status, 400, 'an unknown setting key is rejected rather than ignored');
        assertEqual(unknown.body.error.code, 'UNKNOWN_SETTING', 'with a specific code');

        const body = await ctx.request('PUT', '/api/settings', '[]');
        assertEqual(body.status, 400, 'a non-object settings body is rejected');

        const settings = await ctx.get('/api/settings');
        assertEqual(settings.body.accountabilityTime, '22:30', 'nothing invalid was persisted');
        assertEqual(settings.body.gracePeriod, 15, 'the grace period is unchanged');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'settings updates are applied, validated and reflected in behaviour': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '21:00' });
      try {
        const updated = await ctx.put('/api/settings', {
          accountabilityTime: '21:30',
          gracePeriod: 30,
          weekStart: 'sunday',
          theme: 'light',
          notifications: false,
        });
        assertEqual(updated.status, 200, 'the update succeeds');
        assertEqual(updated.body.settings.accountabilityTime, '21:30', 'the time is applied');
        assertEqual(updated.body.settings.gracePeriod, 30, 'the grace period is applied');
        assertEqual(updated.body.settings.weekStart, 'sunday', 'the week start is applied');
        assertEqual(updated.body.settings.theme, 'light', 'the theme is applied');
        assertEqual(updated.body.settings.notifications, false, 'notifications are off');

        await ctx.post('/api/tasks', { title: 'Anything', repeat: 'daily' });
        await ctx.advanceToLocal('21:31');
        const night = await ctx.get('/api/night-check');
        assertEqual(night.body.active, false, 'notifications off means no night check');

        const enabled = await ctx.put('/api/settings', { notifications: true });
        assertEqual(enabled.body.settings.notifications, true, 'turning them back on works');
        const nightAfter = await ctx.get('/api/night-check');
        assertEqual(nightAfter.body.active, true, 'and the check becomes active again');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'oversized bodies are refused rather than buffered forever': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const huge = await ctx.post('/api/tasks', {
          title: 'x'.repeat(400000),
          repeat: 'daily',
        });
        assertEqual(huge.status, 413, 'a very large body is refused');
        assertEqual(huge.body.success, false, 'with an error, not a success');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'CORS headers are sent so a separately hosted frontend can call the API': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.request('GET', '/api/today', undefined, { Origin: 'http://localhost:5500' });
        assertEqual(res.status, 200, 'the request succeeds');
        assertEqual(
          res.headers.get('access-control-allow-origin'),
          'http://localhost:5500',
          'the calling origin is allowed'
        );

        // A browser sends a preflight before PUT/DELETE; it must be answered
        // with the verbs the API actually supports.
        const preflight = await ctx.request('OPTIONS', '/api/tasks/1/complete', undefined, {
          Origin: 'http://localhost:5500',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'content-type',
        });
        assertTrue(preflight.status === 204 || preflight.status === 200, 'the preflight is accepted');
        const allowed = preflight.headers.get('access-control-allow-methods') || '';
        for (const verb of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
          assertIncludes(allowed, verb, `the preflight advertises ${verb}`);
        }
        assertIncludes(
          preflight.headers.get('access-control-allow-headers') || '',
          'Content-Type',
          'and advertises the JSON content type'
        );
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'every documented frontend endpoint responds with the expected shape': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const created = await ctx.post('/api/tasks', {
          title: 'Study Physics',
          definition: 'At least 45 minutes without phone',
          category: 'Study',
          repeat: 'daily',
          selectedDays: [],
          reminder: '20:00',
          accountabilityTime: '22:30',
        });
        const id = created.body.task.id;

        // GET /api/today
        const today = await ctx.get('/api/today');
        assertEqual(today.body.isoDate, ctx.today(), 'today.isoDate');
        assertMatch(
          today.body.dateLabel || today.body.data.dateLabel,
          /^[A-Z][a-z]+ - \d+ [A-Z][a-z]+$/,
          'the human readable date is the documented "Monday - 5 October" format'
        );
        assertTrue(Array.isArray(today.body.tasks), 'today.tasks is an array');
        assertTrue(typeof today.body.honestDays === 'number', 'today.honestDays is a number');
        assertTrue(typeof today.body.isOffDay === 'boolean', 'today.isOffDay is a boolean');
        assertTrue(typeof today.body.nightCheckActive === 'boolean', 'today.nightCheckActive is a boolean');
        assertTrue(typeof today.body.hasUnresolvedYesterday === 'boolean', 'today.hasUnresolvedYesterday');

        // PUT /api/tasks/:id/complete  and /uncomplete
        const complete = await ctx.put(`/api/tasks/${id}/complete`);
        assertEqual(complete.body.success, true, 'complete.success');
        assertEqual(complete.body.task.completed, true, 'complete.task.completed');
        const uncomplete = await ctx.put(`/api/tasks/${id}/uncomplete`);
        assertEqual(uncomplete.body.task.completed, false, 'uncomplete.task.completed');

        // GET /api/night-check
        const night = await ctx.get('/api/night-check');
        assertTrue(typeof night.body.active === 'boolean', 'night-check.active');
        assertTrue(Array.isArray(night.body.unfinishedTasks), 'night-check.unfinishedTasks');
        assertTrue(typeof night.body.accountabilityTime === 'string', 'night-check.accountabilityTime');
        assertTrue(night.body.unfinishedTasks[0].title !== undefined, 'unfinished tasks carry a title');
        assertTrue(night.body.unfinishedTasks[0].definition !== undefined, 'and a definition');

        // POST /api/night-check/reflect
        const reflect = await ctx.post('/api/night-check/reflect', { reason: 'Got back late from college.' });
        assertEqual(reflect.body.success, true, 'reflect.success');
        assertEqual(reflect.body.message, 'Reason recorded.', 'reflect.message');

        // GET /api/calendar
        const calendar = await ctx.get('/api/calendar?month=10&year=2026');
        assertTrue(typeof calendar.body.month === 'string', 'calendar.month');
        assertTrue(typeof calendar.body.history === 'object', 'calendar.history');

        // GET /api/calendar/day/:date
        const day = await ctx.get(`/api/calendar/day/${ctx.today()}`);
        assertEqual(typeof day.body.completed, 'number', 'day.completed');
        assertEqual(typeof day.body.total, 'number', 'day.total');
        assertTrue(Array.isArray(day.body.tasks), 'day.tasks');
        assertTrue('reflection' in day.body, 'day.reflection is present');

        // GET /api/report/weekly
        const weekly = await ctx.get('/api/report/weekly');
        assertEqual(typeof weekly.body.completedCount, 'number', 'weekly.completedCount');
        assertEqual(typeof weekly.body.totalCount, 'number', 'weekly.totalCount');
        assertEqual(typeof weekly.body.completionRate, 'number', 'weekly.completionRate');
        assertTrue('mostConsistent' in weekly.body, 'weekly.mostConsistent');
        assertTrue('mostSkipped' in weekly.body, 'weekly.mostSkipped');
        assertTrue('commonReason' in weekly.body, 'weekly.commonReason');
        assertTrue(typeof weekly.body.insight === 'string', 'weekly.insight');

        // GET /api/archive
        const archive = await ctx.get('/api/archive?q=late');
        assertTrue(Array.isArray(archive.body.reflections), 'archive.reflections');
        assertTrue('patternNotice' in archive.body, 'archive.patternNotice');

        // GET /api/stats/score
        const score = await ctx.get('/api/stats/score');
        assertEqual(typeof score.body.honestyScore, 'number', 'score.honestyScore');
        assertTrue(typeof score.body.month === 'string', 'score.month');
        assertEqual(typeof score.body.promisesMade, 'number', 'score.promisesMade');
        assertEqual(typeof score.body.completed, 'number', 'score.completed');
        assertEqual(typeof score.body.missed, 'number', 'score.missed');
        assertEqual(typeof score.body.explained, 'number', 'score.explained');
        assertEqual(typeof score.body.unexplained, 'number', 'score.unexplained');

        // GET /api/insights
        const insights = await ctx.get('/api/insights');
        assertTrue(Array.isArray(insights.body.patterns), 'insights.patterns');

        // GET /api/settings  +  PUT /api/settings
        const settings = await ctx.get('/api/settings');
        assertTrue(typeof settings.body.accountabilityTime === 'string', 'settings.accountabilityTime');
        assertTrue(typeof settings.body.dailyReset === 'string', 'settings.dailyReset');
        assertEqual(typeof settings.body.gracePeriod, 'number', 'settings.gracePeriod');
        assertTrue(typeof settings.body.weekStart === 'string', 'settings.weekStart');
        assertTrue(typeof settings.body.notifications === 'boolean', 'settings.notifications');
        assertTrue(typeof settings.body.theme === 'string', 'settings.theme');
        const saved = await ctx.put('/api/settings', { theme: 'light' });
        assertEqual(saved.body.success, true, 'settings update success');
        assertEqual(saved.body.settings.theme, 'light', 'settings payload is returned');

        // POST /api/off-day
        const offDay = await ctx.post('/api/off-day', { reason: 'Sick' });
        assertEqual(offDay.body.success, true, 'off-day success');
        assertEqual(offDay.body.reason, 'Sick', 'off-day reason');

        // GET /api/notifications
        const notifications = await ctx.get('/api/notifications');
        assertTrue(Array.isArray(notifications.body.notifications), 'notifications array');
        assertTrue(typeof notifications.body.notifications.length === 'number', 'and a real length');

        // DELETE /api/tasks/:id
        const removed = await ctx.del(`/api/tasks/${id}`);
        assertEqual(removed.body.success, true, 'delete success');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'no response ever contains shaming language': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:30' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const endpoints = [
          '/api/today',
          '/api/night-check',
          '/api/report/weekly',
          '/api/stats/score',
          '/api/stats/honest-days',
          '/api/insights',
          '/api/notifications',
          '/api/archive',
          '/api/off-day',
        ];
        const banned = ['you failed', 'lazy', 'pathetic', 'wasted another day', 'shame', 'loser', 'disappoint'];
        for (const endpoint of endpoints) {
          const res = await ctx.get(endpoint);
          const text = JSON.stringify(res.body).toLowerCase();
          for (const word of banned) {
            assertNotIncludes(text, word, `${endpoint} must never contain "${word}"`);
          }
        }
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'the backend scheduler runs on its own and records real events': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:31',
        settings: { accountabilityTime: '22:30', gracePeriod: 15 },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        // The scheduler runs on a timer in production; here it is run explicitly
        // to prove the mechanism is idempotent and its state is persisted.
        ctx.scheduler.runNow();
        const before = ctx.count('notification_log');
        assertEqual(before, 1, 'the accountability event was recorded by the scheduler');
        ctx.scheduler.runNow();
        assertEqual(ctx.count('notification_log'), 1, 'a further tick does not duplicate it');

        const status = ctx.scheduler.status();
        assertEqual(status.running, true, 'the scheduler reports it is running');
        assertTrue(status.ticks >= 1, 'and that it has ticked');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
