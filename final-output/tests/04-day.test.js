'use strict';

/**
 * Daily state, timezone authority, the midnight rollover, and the grace period.
 *
 * These are the rules the whole product rests on, so they are tested against a
 * simulated clock rather than by hoping the suite runs at the right moment.
 */

const { createContext, assertEqual, assertIncludes, assertNotIncludes } = require('./helpers');
const time = require('../utils/time');

module.exports = function dayTests() {
  return {
    'GET /api/today returns the documented daily state shape': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        await ctx.post('/api/tasks', {
          title: '2 hrs Coding',
          definition: 'At least 45 minutes focused session',
          category: 'DSA',
          repeat: 'daily',
          accountabilityTime: '22:30',
        });
        const res = await ctx.get('/api/today');
        assertEqual(res.status, 200, 'today is readable');
        assertEqual(res.body.success, true, 'success flag');
        assertEqual(typeof res.body.isoDate, 'string', 'isoDate is exposed for the frontend contract');

        const task = res.body.tasks[0];
        assertEqual(task.id, '1', 'the promise id is a string as documented');
        assertEqual(task.title, '2 hrs Coding', 'title');
        assertEqual(task.definition, 'At least 45 minutes focused session', 'definition');
        assertEqual(task.category, 'DSA', 'category');
        assertEqual(task.completed, false, 'completed flag');
        assertEqual(task.accountabilityTime, '22:30', 'accountabilityTime');
        assertEqual(res.body.counts.total, 1, 'the total count is real');
        assertEqual(res.body.counts.unresolved, 1, 'one unresolved promise');
        assertEqual(res.body.isOffDay, false, 'not an off day');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'empty database returns honest empty values, never fabricated data': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = await ctx.get('/api/today');
        assertEqual(today.body.tasks.length, 0, 'no promises exist yet');
        assertEqual(today.body.counts.total, 0, 'total is a real zero');
        assertEqual(today.body.honestDays, 0, 'no honest days are invented');
        assertEqual(today.body.notifications.length, 0, 'no notifications are invented');
        assertEqual(today.body.status, 'empty', 'an empty day is reported as empty');
        assertEqual(today.body.hasUnresolvedYesterday, false, 'nothing is waiting');

        const weekly = await ctx.get('/api/report/weekly');
        assertEqual(weekly.body.totalCount, 0, 'weekly total is zero');
        assertEqual(weekly.body.completedCount, 0, 'weekly completions are zero');
        assertEqual(weekly.body.completionRate, 0, 'the rate is zero, not a fake percentage');
        assertEqual(weekly.body.mostConsistent, 'None yet', 'no task is crowned without data');
        assertEqual(weekly.body.mostSkipped, 'None yet', 'no task is blamed without data');
        assertEqual(weekly.body.commonReason, null, 'no reason is invented');
        assertEqual(weekly.body.empty, true, 'the report declares itself empty');

        const score = await ctx.get('/api/stats/score');
        assertEqual(score.body.promisesMade, 0, 'no promises were made');
        assertEqual(score.body.honestyScore, 0, 'the score is 0 with no data');
        assertEqual(score.body.hasData, false, 'the score declares it has no data');

        const days = await ctx.get('/api/stats/honest-days');
        assertEqual(days.body.current, 0, 'no honest-day streak is invented');
        assertEqual(days.body.month.honestDays, 0, 'no monthly honest days are invented');

        const archive = await ctx.get('/api/archive');
        assertEqual(archive.body.reflections.length, 0, 'no reflections are invented');
        assertEqual(archive.body.patternNotice, null, 'no pattern notice without data');

        const insights = await ctx.get('/api/insights');
        assertEqual(insights.body.patterns.length, 0, 'no behavioural patterns without data');
        assertEqual(insights.body.empty, true, 'insights declare themselves empty');

        const calendar = await ctx.get('/api/calendar');
        assertEqual(Object.keys(calendar.body.history).length, 0, 'no calendar history is invented');
        assertEqual(calendar.body.summary.unresolvedDays, 0, 'no unresolved days are invented');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'the configured timezone decides what "today" is': async () => {
      // Pin the instant to 2026-03-10T20:00Z: the 10th in London, the 11th in Kolkata.
      const pinned = Date.UTC(2026, 2, 10, 20, 0, 0) - Date.now();

      const london = await createContext({ timezone: 'Europe/London', offsetMinutes: pinned / 60000 });
      const kolkata = await createContext({ timezone: 'Asia/Kolkata', offsetMinutes: pinned / 60000 });
      try {
        const londonToday = await london.get('/api/today');
        const kolkataToday = await kolkata.get('/api/today');

        assertEqual(londonToday.body.isoDate, '2026-03-10', 'London is still on the 10th at 20:00 UTC');
        assertEqual(kolkataToday.body.isoDate, '2026-03-11', 'Kolkata has already rolled over to the 11th');
        assertNotIncludes(londonToday.body.isoDate, '2026-03-11', 'London must not use the browser or UTC date blindly');

        const londonTime = await london.get('/api/time');
        const kolkataTime = await kolkata.get('/api/time');
        assertEqual(londonTime.body.serverTime, '20:00', 'London local time');
        assertEqual(kolkataTime.body.serverTime, '01:30', 'Kolkata local time, next day');
      } finally {
        await london.close();
        london.cleanup();
        await kolkata.close();
        kolkata.cleanup();
      }
    },

    'changing the timezone changes the day the backend reports': async () => {
      const ctx = await createContext({ timezone: 'UTC', localTime: '23:30' });
      try {
        const before = await ctx.get('/api/today');
        assertEqual(before.body.isoDate, ctx.today(), 'date matches the UTC setting');

        const updated = await ctx.put('/api/settings', { timezone: 'Asia/Kolkata' });
        assertEqual(updated.status, 200, 'the timezone change is accepted');
        assertEqual(updated.body.settings.timezoneResolved, 'Asia/Kolkata', 'the resolved zone is reported');

        const after = await ctx.get('/api/today');
        assertEqual(after.body.isoDate, ctx.today(), 'the reported date follows the new timezone');
        assertEqual(
          after.body.isoDate,
          time.shiftIsoDate(before.body.isoDate, 1),
          'at 23:30 UTC, Kolkata is already on the next day'
        );
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an invalid timezone is rejected and leaves the setting untouched': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.put('/api/settings', { timezone: 'Mars/Olympus' });
        assertEqual(res.status, 400, 'an invented timezone is rejected');
        assertEqual(res.body.error.code, 'INVALID_TIMEZONE', 'the error is explicit');
        const settings = await ctx.get('/api/settings');
        assertEqual(settings.body.timezone, 'Asia/Kolkata', 'the previous timezone is still in force');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'midnight: the new day requires a reflection for yesterday': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: '30 min Workout', repeat: 'daily', category: 'Workout' });
        await ctx.post('/api/tasks', { title: 'Read 20 Pages', repeat: 'daily', category: 'Reading' });

        // One of the two promises is kept; the other is left unexplained.
        await ctx.put('/api/tasks/1/complete');

        const beforeMidnight = await ctx.get('/api/today');
        assertEqual(beforeMidnight.body.date, dayOne, 'still the same day before midnight');
        assertEqual(beforeMidnight.body.hasUnresolvedYesterday, false, 'nothing is unresolved yet');

        // Roll the clock into the next day (10 minutes past the daily reset).
        await ctx.advanceToLocal('23:59');
        ctx.setOffsetMinutes(ctx.clock.offsetMinutes + 2);

        const afterMidnight = await ctx.get('/api/today');
        assertEqual(afterMidnight.body.date, ctx.shiftDate(dayOne, 1), 'the backend has rolled over to the new day');
        assertEqual(afterMidnight.body.hasUnresolvedYesterday, true, 'yesterday now needs an explanation');
        assertEqual(afterMidnight.body.canStartNewDay, false, 'the new day cannot be started yet');
        assertEqual(afterMidnight.body.reflection.required, true, 'reflection is required');
        assertEqual(afterMidnight.body.reflection.previousDate, dayOne, 'the reflection targets yesterday');
        assertEqual(afterMidnight.body.reflection.targets.length, 1, 'exactly the unexplained promise is listed');
        assertEqual(
          afterMidnight.body.reflection.targets[0].title,
          'Read 20 Pages',
          'the right promise is targeted'
        );

        // The previous day is not closed yet.
        const previous = await ctx.get(`/api/calendar/day/${dayOne}`);
        assertEqual(previous.body.status, 'unresolved', 'yesterday is marked unresolved');
        assertEqual(previous.body.completed, 1, 'one promise was completed');
        assertEqual(previous.body.total, 2, 'two promises were made');
        assertEqual(previous.body.completed + previous.body.explained + previous.body.unresolved, 2, 'counts add up');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'midnight: yesterday can still be finished inside the grace window': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '09:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Late workout', repeat: 'daily' });

        // 5 minutes past the daily reset: inside the 15 minute grace period.
        ctx.advanceToNextDay(5);
        assertEqual(ctx.today(), ctx.shiftDate(dayOne, 1), 'the simulated clock is on the next day');

        const state = await ctx.get('/api/today');
        assertEqual(state.body.date, ctx.shiftDate(dayOne, 1), 'a new day has begun');
        assertEqual(state.body.accountability.carryOverWindowOpen, true, 'the carry-over window is open');
        assertEqual(state.body.reflection.canStillCompleteYesterday, true, 'yesterday can still be finished');
        assertEqual(state.body.hasUnresolvedYesterday, true, 'and is still waiting');

        // The promise belongs to yesterday. Inside the grace window the backend
        // still understands an unqualified completion as "the day I am working
        // on", which is yesterday - and records it against yesterday's date.
        const completeNow = await ctx.put('/api/tasks/1/complete');
        assertEqual(completeNow.status, 200, 'inside the grace window the promise can still be completed');
        assertEqual(completeNow.body.date, dayOne, 'it is recorded against yesterday, not today');
        assertEqual(ctx.today(), ctx.shiftDate(dayOne, 1), 'and the new day still begins on schedule');

        const after = await ctx.get('/api/today');
        assertEqual(after.body.hasUnresolvedYesterday, false, 'yesterday is now closed');
        assertEqual(after.body.canStartNewDay, true, 'and the new day can start');
        const previous = await ctx.get(`/api/calendar/day/${dayOne}`);
        assertEqual(previous.body.status, 'completed', 'yesterday is recorded as completed');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'after the grace period a past day can only be explained, not completed': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '09:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });

        // Well past the daily reset: the grace window has closed.
        ctx.advanceToNextDay(31);
        assertEqual(ctx.today(), ctx.shiftDate(dayOne, 1), 'the simulated clock is on the next day');

        const state = await ctx.get('/api/today');
        assertEqual(state.body.accountability.carryOverWindowOpen, false, 'the carry-over window has closed');
        assertEqual(state.body.reflection.canStillCompleteYesterday, false, 'yesterday can no longer be completed');

        const attempt = await ctx.put(`/api/tasks/1/complete?date=${dayOne}`);
        assertEqual(attempt.status, 403, 'completing a closed past day is forbidden');
        assertEqual(attempt.body.error.code, 'DAY_CLOSED', 'it is reported as a closed day');
        assertEqual(ctx.count('task_occurrences'), 0, 'nothing was written');

        const explanation = await ctx.post('/api/night-check/reflect', {
          reason: 'Slept early, woke up with a headache.',
          date: dayOne,
        });
        assertEqual(explanation.status, 200, 'explaining it is still allowed');
        assertEqual(explanation.body.remainingUnresolved, 0, 'the day is resolved by honesty');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'a day with nothing promised never blocks the next day': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '09:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        // A one-time promise for day one only, answered honestly by completing it.
        await ctx.post('/api/tasks', { title: 'One-off errand', repeat: 'once', startDate: dayOne });
        await ctx.put('/api/tasks/1/complete');

        ctx.advanceToNextDay(1);
        ctx.advanceToNextDay(1);
        assertEqual(ctx.today(), ctx.shiftDate(dayOne, 2), 'the simulated clock is two days ahead');

        const state = await ctx.get('/api/today');
        assertEqual(state.body.date, ctx.shiftDate(dayOne, 2), 'two days later');
        assertEqual(state.body.counts.total, 0, 'nothing is promised for today');
        assertEqual(state.body.hasUnresolvedYesterday, false, 'the days in between left nothing unresolved');
        assertEqual(state.body.canStartNewDay, true, 'so today is not blocked');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an unanswered recurring promise keeps the previous day open until it is explained': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '09:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Daily thing', repeat: 'daily' });

        // The user never opened the app on day two: the promise was simply not
        // kept. That is exactly the state the product exists to surface.
        ctx.advanceToNextDay(1);
        ctx.advanceToNextDay(1);

        const state = await ctx.get('/api/today');
        assertEqual(state.body.hasUnresolvedYesterday, true, 'yesterday is waiting for an explanation');
        assertEqual(state.body.reflection.previousDate, ctx.shiftDate(dayOne, 1), 'it targets the day that was skipped');
        assertEqual(state.body.reflection.targets.length, 1, 'the skipped promise is listed');
        assertEqual(state.body.canStartNewDay, false, 'the new day is gated until it is answered');

        const reflected = await ctx.post('/api/night-check/reflect', {
          reason: 'Was travelling and never opened the app.',
        });
        assertEqual(reflected.status, 200, 'the reason is recorded');
        assertEqual(reflected.body.date, ctx.shiftDate(dayOne, 1), 'against the skipped day');

        const after = await ctx.get('/api/today');
        assertEqual(after.body.canStartNewDay, true, 'and now today can begin');
        // Honesty is per day: the skipped-then-explained day counts, but the
        // very first day (never answered) does not - so the streak is 1.
        assertEqual(after.body.honestDays, 1, 'only the honestly closed day counts toward the streak');
        assertEqual(
          after.body.reflection.backlog.count,
          1,
          'the earlier unsettled day is surfaced as a backlog rather than blocking today'
        );
        assertEqual(after.body.reflection.backlog.oldestDate, ctx.shiftDate(dayOne, 0), 'the backlog names that day');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'accountability check activates at the configured time': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '21:00',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.put('/api/tasks/3/complete');

        const before = await ctx.get('/api/night-check');
        assertEqual(before.body.active, false, 'the check is not active before the accountability time');
        assertEqual(before.body.unfinishedCount, 2, 'but the unfinished count is already real');

        await ctx.advanceToLocal('22:30');
        const at = await ctx.get('/api/night-check');
        assertEqual(at.body.active, true, 'the check becomes active at 22:30');
        assertEqual(at.body.unfinishedCount, 2, 'two promises are still open');
        assertEqual(at.body.accountabilityTime, '22:30', 'the configured time is reported');
        assertIncludes(
          at.body.message,
          'Be honest with yourself. You still have 2 unfinished promises today.',
          'the exact accountability sentence is composed by the backend'
        );

        const state = await ctx.get('/api/today');
        assertEqual(state.body.nightCheckActive, true, 'today reflects the active night check');

        const notifications = await ctx.get('/api/notifications');
        assertEqual(notifications.body.count, 1, 'exactly one accountability notification fired');
        assertEqual(notifications.body.notifications[0].kind, 'accountability', 'of the accountability kind');
        assertIncludes(
          notifications.body.notifications[0].message,
          'You still have 2 unfinished promises today.',
          'the notification carries the real count'
        );

        // Completing one promise does not retroactively change what was said.
        await ctx.put('/api/tasks/1/complete');
        const again = await ctx.get('/api/night-check');
        assertEqual(again.body.unfinishedCount, 1, 'the live count drops to one');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'night check is not active when nothing is unfinished or when the check is off': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { accountabilityTime: '22:30', gracePeriod: 15 },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Everything done', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');

        const done = await ctx.get('/api/night-check');
        assertEqual(done.body.active, false, 'nothing is outstanding, so there is no check to show');

        await ctx.post('/api/tasks', { title: 'Another', repeat: 'daily' });
        const active = await ctx.get('/api/night-check');
        assertEqual(active.body.active, true, 'a new promise makes the check active again');

        await ctx.put('/api/settings', { notifications: false });
        const silenced = await ctx.get('/api/night-check');
        assertEqual(silenced.body.active, false, 'notifications off means no accountability prompt');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'grace period produces the "minutes left" warning before the reset': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { accountabilityTime: '22:30', gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Unfinished', repeat: 'daily' });

        await ctx.advanceToLocal('23:45');
        const notifications = await ctx.get('/api/notifications');
        const kinds = notifications.body.notifications.map((n) => n.kind);
        assertIncludes(kinds, 'grace_warning', 'the grace warning fires inside the grace window');
        const grace = notifications.body.notifications.find((n) => n.kind === 'grace_warning');
        assertIncludes(grace.message, 'left.', 'the message states the remaining time');
        assertIncludes(grace.message, 'Or tell yourself why you didn', 'and offers the honest alternative');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'a custom daily reset time moves the day boundary': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '02:00',
        settings: { dailyReset: '04:00', gracePeriod: 15, accountabilityTime: '22:30' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Early bird', repeat: 'daily' });

        // 03:00 is still "yesterday" because the day resets at 04:00.
        const beforeReset = await ctx.get('/api/today');
        assertEqual(beforeReset.body.isoDate, dayOne, 'the calendar date has not changed yet');

        await ctx.advanceToLocal('03:00');
        const atThree = await ctx.get('/api/time');
        assertEqual(atThree.body.serverTime, '03:00', 'the local time is 03:00');
        assertEqual(atThree.body.dailyReset, '04:00', 'the custom reset is in force');

        await ctx.advanceToLocal('04:30');
        const afterReset = await ctx.get('/api/night-check');
        assertEqual(afterReset.body.date, ctx.today(), 'the report follows the configured reset, not the clock date');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day suspends accountability for that day': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { accountabilityTime: '22:30', gracePeriod: 15 },
      });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const off = await ctx.post('/api/off-day', { reason: 'Sick' });
        assertEqual(off.status, 200, 'the off day is accepted for today');
        assertEqual(off.body.isOffDay, true, 'today is now an off day');
        assertEqual(off.body.suspendedPromises, 1, 'one promise is suspended');

        const state = await ctx.get('/api/today');
        assertEqual(state.body.isOffDay, true, 'daily state reports the off day');
        assertEqual(state.body.offDayReason, 'Sick', 'with its reason');
        assertEqual(state.body.counts.unresolved, 0, 'nothing counts as unresolved on an off day');
        assertEqual(state.body.nightCheckActive, false, 'no accountability prompt on an off day');

        const night = await ctx.get('/api/night-check');
        assertEqual(night.body.active, false, 'the night check stays quiet');

        const calendar = await ctx.get('/api/calendar');
        assertEqual(calendar.body.history[ctx.today()].status, 'offday', 'history records the off day');

        const reflections = await ctx.post('/api/night-check/reflect', { reason: 'Was sick' });
        assertEqual(reflections.status, 409, 'there is nothing to explain on an off day');
        assertEqual(reflections.body.error.code, 'OFF_DAY_NO_REFLECTION_NEEDED', 'and the backend says so kindly');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
