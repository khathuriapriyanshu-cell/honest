'use strict';

/**
 * Analytics: weekly report, Honest Score, Honest Days, calendar and insights.
 *
 * Every assertion compares the API to numbers the test arranged in the database
 * itself, so a hardcoded or fabricated figure cannot pass. Days are seeded from
 * an explicit start date so month boundaries never make the suite flaky.
 */

const { createContext, assertTrue, assertEqual, assertIncludes, assertNotIncludes } = require('./helpers');

/**
 * Writes occurrence rows for a list of scripted days, starting at `fromDate`,
 * and leaves the simulated clock at the end of the script.
 *
 * The promise rows are also backdated to `fromDate`, because a recorded
 * occurrence for a day before a promise existed is a state the API can never
 * produce - the fixture has to stay honest about that.
 *
 * script: [[{ taskId, status, reason?, name? }], ...]  (one entry per day)
 */
async function seedDaysFrom(ctx, fromDate, script, { time = '20:00' } = {}) {
  const taskIds = new Set();
  for (const day of script) for (const entry of day) taskIds.add(entry.taskId);
  const backdate = ctx.db.prepare(
    'UPDATE tasks SET start_date = ? WHERE id = ? AND start_date > ?'
  );
  for (const taskId of taskIds) backdate.run(fromDate, taskId, fromDate);

  for (let offset = 0; offset < script.length; offset += 1) {
    const date = ctx.shiftDate(fromDate, offset);
    ctx.goTo(date, time);
    for (const entry of script[offset]) {
      const nowIso = `${date}T18:00:00Z`;
      const completed = entry.status === 'completed';
      const reflected = entry.status === 'missed_explained';
      ctx.db
        .prepare(
          `INSERT INTO task_occurrences
             (task_id, date, status, completed, reflected, task_name, task_definition, task_category,
              completed_at, reflected_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(task_id, date) DO UPDATE SET
             status = excluded.status, completed = excluded.completed, reflected = excluded.reflected`
        )
        .run(
          entry.taskId,
          date,
          entry.status,
          completed ? 1 : 0,
          reflected ? 1 : 0,
          entry.name || null,
          entry.definition || null,
          entry.category || null,
          completed ? nowIso : null,
          reflected ? nowIso : null,
          nowIso,
          nowIso
        );
      if (reflected) {
        ctx.db
          .prepare(
            `INSERT INTO reflections (task_id, date, task_name, reason, source, created_at)
             VALUES (?, ?, ?, ?, 'night_check', ?)`
          )
          .run(entry.taskId, date, entry.name || 'task', entry.reason || 'Too tired', nowIso);
      }
    }
  }
  // The first date of the run. Tests index days off this value; returning the
  // current day instead would silently shift every fixture by the run length.
  return fromDate;
}

/** Seeds a run of days ending on `endDate`, so the whole run sits in one month. */
async function seedEndingOn(ctx, endDate, script, options) {
  return seedDaysFrom(ctx, ctx.shiftDate(endDate, -(script.length - 1)), script, options);
}

module.exports = function analyticsTests() {
  return {
    'weekly report is computed from the week actually recorded': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const coding = await ctx.post('/api/tasks', {
          title: 'Coding',
          repeat: 'daily',
          startDate: ctx.shiftDate(ctx.baseDay(), -20),
        });
        const workout = await ctx.post('/api/tasks', {
          title: 'Workout',
          repeat: 'daily',
          startDate: ctx.shiftDate(ctx.baseDay(), -20),
        });
        const revision = await ctx.post('/api/tasks', {
          title: 'Revision',
          repeat: 'daily',
          startDate: ctx.shiftDate(ctx.baseDay(), -20),
        });
        const codingId = Number(coding.body.task.id);
        const workoutId = Number(workout.body.task.id);
        const revisionId = Number(revision.body.task.id);

        // A complete Monday..Sunday week two weeks back, built in the database.
        // Anchoring it in the past keeps it away from whatever the current week
        // happens to contain.
        const today = ctx.baseDay();
        const time = require('../utils/time');
        const weekday = time.isoWeekdayFromDate(today);
        const thisMonday = ctx.shiftDate(today, -(weekday - 1));
        const pastMonday = ctx.shiftDate(thisMonday, -14);
        const pastSunday = ctx.shiftDate(pastMonday, 6);

        // Bound the promises to that week so they cannot leak into this week.
        for (const id of [codingId, workoutId, revisionId]) {
          ctx.db.prepare('UPDATE tasks SET end_date = ? WHERE id = ?').run(pastSunday, id);
        }

        const script = [
          [
            { taskId: codingId, status: 'completed' },
            { taskId: workoutId, status: 'missed_explained', reason: 'Too tired / got late' },
          ],
          [
            { taskId: codingId, status: 'completed' },
            { taskId: workoutId, status: 'missed_explained', reason: 'Too tired / got late' },
          ],
          [
            { taskId: codingId, status: 'completed' },
            { taskId: workoutId, status: 'missed_explained', reason: 'Family function' },
          ],
          [{ taskId: codingId, status: 'completed' }],
          [],
          [],
          [],
        ];

        await seedDaysFrom(ctx, pastMonday, script);
        ctx.goTo(today, '20:00');

        const week = await ctx.get(`/api/report/weekly?date=${pastMonday}`);
        assertEqual(week.status, 200, 'the weekly report is available for a past week');
        assertEqual(week.body.weekStart, pastMonday, 'the week starts on the configured week start (Monday)');
        assertEqual(week.body.weekEnd, pastSunday, 'and ends on the Sunday');
        assertEqual(week.body.totalCount, 7, 'seven promises were recorded that week');
        assertEqual(week.body.completedCount, 4, 'four were kept');
        assertEqual(week.body.explainedCount, 3, 'three were missed and explained');
        assertEqual(week.body.unexplainedCount, 0, 'none were left unexplained');
        assertEqual(week.body.completionRate, 57.1, 'the completion rate is the real ratio (4/7)');
        assertEqual(week.body.mostConsistent, 'Coding (100%)', 'the most consistent promise is the one kept every time');
        assertEqual(week.body.mostSkipped, 'Workout (0%)', 'the most skipped promise is the real one');
        assertEqual(week.body.commonReason, 'Too tired / got late', 'the most common real reason');
        assertEqual(week.body.commonReasonCount, 2, 'with its real count');
        assertEqual(week.body.daysTracked, 4, 'four days of that week have real records');
        assertIncludes(week.body.insight, 'kept', 'the insight references the real numbers');
        assertNotIncludes(week.body.insight, 'lazy', 'and never shames the user');
        assertNotIncludes(week.body.insight, 'failed', 'and never uses the word "failed"');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'weekly report does not crown a task that was only answered once': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const task = await ctx.post('/api/tasks', { title: 'One-off', repeat: 'daily' });
        await seedEndingOn(ctx, ctx.baseDay(), [[{ taskId: Number(task.body.task.id), status: 'completed' }]]);
        const week = await ctx.get('/api/report/weekly');
        assertEqual(week.body.totalCount, 1, 'one promise recorded');
        assertEqual(week.body.mostConsistent, 'None yet', 'a single data point is not a pattern');
        assertEqual(week.body.mostSkipped, 'None yet', 'and nothing is blamed either');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'Honest Score follows the documented formula': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        const id = Number(task.body.task.id);

        const today = ctx.today();
        const from = `${today.slice(0, 7)}-01`;
        const daysAvailable = Number(today.slice(8, 10));
        const planned = Math.min(30, daysAvailable);
        const completedDays = Math.floor(planned * 0.6);
        const explainedDays = planned - completedDays;

        const script = [];
        for (let day = 0; day < planned; day += 1) {
          script.push([
            {
              taskId: id,
              status: day < completedDays ? 'completed' : 'missed_explained',
              reason: 'Ran out of time',
            },
          ]);
        }
        await seedDaysFrom(ctx, from, script, { time: '22:00' });

        const score = await ctx.get(`/api/stats/score?from=${from}&to=${today}`);
        assertEqual(score.status, 200, 'the score is available');
        assertEqual(score.body.promisesMade, planned, 'every planned promise is counted');
        assertEqual(score.body.completed, completedDays, 'exactly the completed ones');
        assertEqual(score.body.missed, explainedDays, 'exactly the missed ones');
        assertEqual(score.body.explained, explainedDays, 'all of them explained');
        assertEqual(score.body.unexplained, 0, 'none left unexplained');

        const expectedCompletion = Math.round((100 * completedDays) / planned);
        assertEqual(score.body.breakdown.completionScore, expectedCompletion, 'completion term is the real ratio');
        assertEqual(
          score.body.breakdown.explanationScore,
          100,
          'explanation term is 100 when every miss is explained'
        );
        assertEqual(score.body.breakdown.noUnansweredBonus, 100, 'no unanswered promises');
        const expected = Math.round(0.55 * expectedCompletion + 0.3 * 100 + 0.1 * 100 + 0.05 * 100);
        assertEqual(score.body.honestyScore, expected, 'the score matches the documented weighting exactly');
        assertEqual(
          score.body.completionRate,
          Math.round((1000 * completedDays) / planned) / 10,
          'the completion rate is the real ratio'
        );
        assertIncludes(score.body.formula, '0.55', 'the formula is documented in the response');
        assertTrue(typeof score.body.month === 'string', 'the month label is present');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an identical period always produces an identical score (determinism)': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Mixed', repeat: 'daily' });
        const id = Number(task.body.task.id);
        const today = ctx.baseDay();
        // A fixed ten day window ending today, scored through the explicit range
        // so the numbers do not depend on how far into the month we are.
        const from = ctx.shiftDate(today, -9);
        const planned = 10;

        const script = [];
        for (let day = 0; day < planned; day += 1) {
          if (day === 0) script.push([{ taskId: id, status: 'missed_unexplained' }]);
          else if (day === 1) script.push([{ taskId: id, status: 'missed_explained', reason: 'Late night' }]);
          else script.push([{ taskId: id, status: 'completed' }]);
        }
        await seedDaysFrom(ctx, from, script, { time: '22:00' });

        const range = `?from=${from}&to=${today}`;
        const first = await ctx.get(`/api/stats/score${range}`);
        const second = await ctx.get(`/api/stats/score${range}`);
        const third = await ctx.get(`/api/stats/score${range}`);
        assertEqual(first.body.honestyScore, second.body.honestyScore, 'the score does not drift');
        assertEqual(second.body.honestyScore, third.body.honestyScore, 'and is not random');

        const made = first.body.promisesMade;
        const completed = first.body.completed;
        const explained = first.body.explained;
        const unexplained = first.body.unexplained;
        assertTrue(explained > 0 && unexplained > 0, 'the scenario really contains both kinds of miss');

        const expected = Math.round(
          0.55 * ((100 * completed) / made) +
            0.3 * ((100 * explained) / (explained + unexplained)) +
            0.1 * ((100 * explained) / (explained + unexplained)) +
            0.05 * (unexplained === 0 ? 100 : 0)
        );
        assertEqual(first.body.honestyScore, expected, 'the score equals the formula applied to the real counts');
        assertTrue(first.body.honestyScore >= 0 && first.body.honestyScore <= 100, 'the score is bounded 0..100');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'Honest Days count explained misses as honest and unexplained ones as not': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Daily habit', repeat: 'daily' });
        const id = Number(task.body.task.id);

        // day 1 completed -> honest
        // day 2 missed+explained -> honest
        // day 3 completed -> honest
        // day 4 missed unexplained -> not honest
        // day 5 (today) completed -> honest but still in progress
        const start = await seedEndingOn(ctx, ctx.baseDay(), [
          [{ taskId: id, status: 'completed' }],
          [{ taskId: id, status: 'missed_explained', reason: 'Slept early' }],
          [{ taskId: id, status: 'completed' }],
          [{ taskId: id, status: 'missed_unexplained' }],
          [{ taskId: id, status: 'completed' }],
        ]);
        assertEqual(ctx.today(), ctx.baseDay(), 'the clock ends on the final scripted day, which is today');

        const days = await ctx.get('/api/stats/honest-days');
        assertEqual(days.status, 200, 'honest days are available');
        assertEqual(days.body.current, 1, 'the streak runs back only to the unexplained day');
        assertEqual(days.body.todayHonest, true, 'today is honest');
        assertEqual(days.body.month.honestDays, 4, 'four honest days so far this month');
        assertEqual(days.body.month.trackedDays, 5, 'five days had promises');
        assertEqual(days.body.lifetime.honestDays, 4, 'the lifetime total agrees');
        assertIncludes(days.body.definition, 'not a plain completion streak', 'the definition is explicit');

        const dayFour = await ctx.get(`/api/calendar/day/${ctx.shiftDate(start, 3)}`);
        assertEqual(dayFour.body.status, 'unresolved', 'the unexplained day is unresolved');
        assertEqual(dayFour.body.isHonestDay, false, 'and is not an honest day');

        const dayTwo = await ctx.get(`/api/calendar/day/${ctx.shiftDate(start, 1)}`);
        assertEqual(dayTwo.body.status, 'explained', 'the explained day is explained');
        assertEqual(dayTwo.body.isHonestDay, true, 'and is an honest day');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day keeps the honest-day streak alive': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Daily habit', repeat: 'daily' });
        const id = Number(task.body.task.id);

        const start = await seedEndingOn(ctx, ctx.baseDay(), [
          [{ taskId: id, status: 'completed' }],
          [],
          [{ taskId: id, status: 'completed' }],
        ]);
        // The clock is left on the day before seeding started; return to today.
        ctx.goTo(ctx.shiftDate(start, 2), '20:00');
        // Record the middle day as an off day, the way the service would have
        // written it at the time.
        ctx.db
          .prepare(
            `INSERT INTO off_days (date, reason, activated_at, deadline_at, status, created_at)
             VALUES (?, 'Sick', ?, ?, 'active', ?)`
          )
          .run(
            ctx.shiftDate(start, 1),
            `${ctx.shiftDate(start, 1)}T10:00:00Z`,
            `${ctx.shiftDate(start, 2)}T00:00:00Z`,
            `${ctx.shiftDate(start, 1)}T10:00:00Z`
          );

        const days = await ctx.get('/api/stats/honest-days');
        assertEqual(days.body.current, 3, 'the off day did not break the streak');
        assertEqual(days.body.month.honestDays, 3, 'and it counts as an honest day');

        const offDayDetail = await ctx.get(`/api/calendar/day/${ctx.shiftDate(start, 1)}`);
        assertEqual(offDayDetail.body.status, 'offday', 'history marks it as an off day');
        assertEqual(offDayDetail.body.offDay.reason, 'Sick', 'with its reason');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'calendar month returns real per-day statuses and a real summary': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const today = ctx.baseDay();
        // Three completed days of history that end yesterday, so all three are
        // finished days (today is always reported as "active").
        const start = ctx.shiftDate(today, -3);
        const end = ctx.shiftDate(today, -1);
        const task = await ctx.post('/api/tasks', {
          title: 'Coding',
          repeat: 'daily',
          startDate: start,
          endDate: end,
        });
        const id = Number(task.body.task.id);
        await seedDaysFrom(ctx, start, [
          [{ taskId: id, status: 'completed' }],
          [{ taskId: id, status: 'missed_explained', reason: 'College event' }],
          [{ taskId: id, status: 'missed_unexplained' }],
        ]);
        // Seeding ends on the last scripted day; return to the real "today" so
        // the three days being inspected are all history.
        ctx.goTo(today, '20:00');

        const [year, month] = start.split('-').map(Number);
        const calendar = await ctx.get(`/api/calendar?month=${month}&year=${year}`);
        assertEqual(calendar.status, 200, 'the month is returned');
        assertIncludes(calendar.body.month, String(year), 'with a readable label');
        assertEqual(calendar.body.summary.daysTracked, 3, 'three days were tracked');
        assertEqual(calendar.body.summary.honestDays, 2, 'two honest days (completed + explained)');
        assertEqual(calendar.body.summary.completedDays, 1, 'one fully completed day');
        assertEqual(calendar.body.summary.explainedDays, 1, 'one explained day');
        assertEqual(calendar.body.summary.unresolvedDays, 1, 'one unresolved day');

        assertEqual(calendar.body.history[ctx.shiftDate(start, 0)].status, 'completed', 'day one completed');
        assertEqual(calendar.body.history[ctx.shiftDate(start, 1)].status, 'explained', 'day two explained');
        assertEqual(calendar.body.history[ctx.shiftDate(start, 2)].status, 'unresolved', 'day three unresolved');

        const emptyDay = ctx.shiftDate(start, 9);
        assertEqual(calendar.body.history[emptyDay], undefined, 'an untouched day is not invented');
        const future = ctx.shiftDate(ctx.today(), 2);
        assertEqual(calendar.body.history[future], undefined, 'a future day is not reported');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'archive reports a repeated reason and search filters it': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const id = Number(task.body.task.id);
        await seedEndingOn(ctx, ctx.baseDay(), [
          [{ taskId: id, status: 'missed_explained', reason: 'Too tired.' }],
          [{ taskId: id, status: 'missed_explained', reason: 'too tired' }],
          [{ taskId: id, status: 'missed_explained', reason: 'Had a college event.' }],
        ]);

        const archive = await ctx.get('/api/archive');
        assertEqual(archive.body.total, 3, 'three reflections are archived');
        assertIncludes(archive.body.patternNotice, 'this month', 'a repeated reason produces a pattern notice');
        assertEqual(archive.body.pattern.count, 2, 'counting normalised text as the same reason');
        assertEqual(archive.body.reflections.length, 3, 'all are returned');

        const filtered = await ctx.get('/api/archive?q=college');
        assertEqual(filtered.body.reflections.length, 1, 'keyword search filters the archive');
        assertEqual(filtered.body.empty, false, 'and reports it is not empty');

        const none = await ctx.get('/api/archive?q=nothingmatchesthis');
        assertEqual(none.body.reflections.length, 0, 'an unmatched search returns nothing');
        assertEqual(none.body.empty, true, 'and says so honestly');
        assertIncludes(none.body.emptyMessage, 'No reflection matches', 'with a useful message');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'insights only claim patterns the data supports': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const today = ctx.today();
        // A twelve-day promise window that definitely ends today.
        const start = ctx.shiftDate(today, -11);
        const morning = await ctx.post('/api/tasks', {
          title: 'Morning coding',
          repeat: 'daily',
          reminder: '08:00',
          startDate: start,
          endDate: today,
        });
        const evening = await ctx.post('/api/tasks', {
          title: 'Evening reading',
          repeat: 'daily',
          reminder: '21:00',
          startDate: start,
          endDate: today,
        });
        assertEqual(morning.status, 201, 'the morning promise has a bounded window');
        assertEqual(morning.body.task.endDate, today, 'and the end date is stored');
        const morningId = Number(morning.body.task.id);
        const eveningId = Number(evening.body.task.id);

        const script = [];
        for (let day = 0; day < 12; day += 1) {
          script.push([
            { taskId: morningId, status: 'completed' },
            {
              taskId: eveningId,
              status: day < 3 ? 'completed' : 'missed_explained',
              reason: 'Too tired / got late',
            },
          ]);
        }
        await seedDaysFrom(ctx, start, script);

        const insights = await ctx.get('/api/insights');
        assertEqual(insights.status, 200, 'insights are available');
        assertEqual(insights.body.empty, false, 'there is enough data for a pattern');
        const leads = insights.body.patterns.map((p) => p.lead);
        assertIncludes(leads, 'Time-of-day discrepancy', 'the time-of-day pattern is detected from real timings');
        assertIncludes(leads, 'Primary justification', 'the repeated reason is detected');
        const timePattern = insights.body.patterns.find((p) => p.lead === 'Time-of-day discrepancy');
        // The honest form of this claim compares promises scheduled early with
        // promises scheduled late: 12 early at 100%, 12 late at 25%.
        assertIncludes(timePattern.content, '100%', 'and reports the real early rate');
        assertIncludes(timePattern.content, '25%', 'and the real late rate');
        assertIncludes(timePattern.content, '12 early promises', 'with the real sample sizes');
        for (const pattern of insights.body.patterns) {
          assertNotIncludes(pattern.content, 'lazy', 'no pattern shames the user');
          assertNotIncludes(pattern.content.toLowerCase(), 'pathetic', 'no pattern shames the user');
        }
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'insights stay empty when the data cannot support a claim': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '20:00' });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Occasional', repeat: 'daily' });
        const id = Number(task.body.task.id);
        await seedEndingOn(ctx, ctx.baseDay(), [
          [{ taskId: id, status: 'completed' }],
          [{ taskId: id, status: 'missed_explained', reason: 'Once off' }],
        ]);
        const insights = await ctx.get('/api/insights');
        assertEqual(insights.body.patterns.length, 0, 'two data points are not a pattern');
        assertIncludes(insights.body.emptyMessage, 'Not enough recorded promises', 'and the backend says so');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'accountability notifications are recorded once and are honest about counts': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:29',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });

        const early = await ctx.get('/api/notifications');
        assertEqual(early.body.count, 0, 'nothing before the accountability time');

        ctx.advanceToLocal('22:31');
        const first = await ctx.get('/api/notifications');
        assertEqual(first.body.count, 1, 'the accountability event fires once');
        assertEqual(first.body.notifications[0].kind, 'accountability', 'of the right kind');

        const second = await ctx.get('/api/notifications');
        assertEqual(second.body.count, 1, 'the same event is not repeated (dedupe by day)');
        assertEqual(ctx.count('notification_log'), 1, 'only one row was written');

        const history = await ctx.get('/api/notifications/history');
        assertEqual(history.body.count, 1, 'the history shows the single real event');
        assertEqual(history.body.history[0].date, ctx.today(), 'against today');
        assertEqual(history.body.history[0].payload.unfinishedCount, 2, 'with the real unfinished count');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'notifications can be acknowledged and are then no longer active': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '22:45',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        const active = await ctx.get('/api/notifications');
        assertEqual(active.body.count, 1, 'one notification is active');
        const id = active.body.notifications[0].notificationId;

        const acked = await ctx.post(`/api/notifications/${id}/ack`);
        assertEqual(acked.status, 200, 'acknowledging works');
        assertEqual(acked.body.acknowledged, true, 'and reports success');

        const after = await ctx.get('/api/notifications');
        assertEqual(after.body.count, 0, 'the acknowledged notification is no longer active');

        const missing = await ctx.post('/api/notifications/9999/ack');
        assertEqual(missing.status, 404, 'acknowledging an unknown notification is a 404');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'previously unresolved days are surfaced as a backlog, not lost': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '20:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const task = await ctx.post('/api/tasks', { title: 'Daily habit', repeat: 'daily' });
        const id = Number(task.body.task.id);
        const start = await seedEndingOn(ctx, ctx.baseDay(), [
          [{ taskId: id, status: 'missed_unexplained' }],
          [{ taskId: id, status: 'missed_explained', reason: 'Sick' }],
          [{ taskId: id, status: 'completed' }],
        ]);

        const state = await ctx.get('/api/today');
        assertEqual(state.body.canStartNewDay, true, 'today is not blocked by the older day');
        assertEqual(state.body.reflection.backlog.count, 1, 'the older unsettled day is in the backlog');
        assertEqual(state.body.reflection.backlog.oldestDate, start, 'and named');
        assertEqual(state.body.olderUnresolvedDates.length, 1, 'and exposed as a date list');

        const explained = await ctx.post('/api/night-check/reflect', {
          reason: 'Was travelling that day.',
          date: start,
        });
        assertEqual(explained.status, 200, 'the backlog day can still be explained');
        const after = await ctx.get('/api/today');
        assertEqual(after.body.reflection.backlog.count, 0, 'and then the backlog is clear');
        assertEqual(after.body.honestDays, 3, 'which restores the honest-day streak to three');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
