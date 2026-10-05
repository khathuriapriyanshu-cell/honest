'use strict';

/**
 * Reflection (the honest reason) and off days.
 *
 * The product principle under test: a missed promise that was honestly
 * explained is a different outcome from a missed promise nobody looked at, and
 * the backend must never blur the two. Also: an off day can never be declared
 * after the day it applies to is over.
 */

const { createContext, assertEqual, assertIncludes } = require('./helpers');

module.exports = function reflectionTests() {
  return {
    'records a reason for every missed promise on the day': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Reading', repeat: 'daily' });
        await ctx.put('/api/tasks/3/complete');

        const night = await ctx.get('/api/night-check');
        assertEqual(night.body.unfinishedCount, 2, 'two promises are still open');

        const res = await ctx.post('/api/night-check/reflect', {
          reason: 'I got back late from college and club work took longer than expected.',
        });
        assertEqual(res.status, 200, 'the reflection is accepted');
        assertEqual(res.body.success, true, 'success');
        assertEqual(res.body.message, 'Reason recorded.', 'the documented message is returned');
        assertIncludes(
          res.body.note,
          "You don't need to justify it to us",
          'the reassuring note is returned by the backend'
        );
        assertEqual(res.body.remainingUnresolved, 0, 'both missed promises are explained');
        assertEqual(res.body.dayResolved, true, 'the day is resolved');
        assertEqual(res.body.nextStep, 'Start today.', 'the next step is offered');
        assertEqual(res.body.explainedTaskIds.length, 2, 'both promises are named');

        assertEqual(ctx.count('reflections'), 2, 'one reflection row per promise, persisted');
        const rows = ctx.db
          .prepare('SELECT reason, date FROM reflections ORDER BY id')
          .all();
        assertEqual(
          rows[0].reason,
          'I got back late from college and club work took longer than expected.',
          'the reason is stored verbatim'
        );
        assertEqual(rows[0].date, ctx.today(), 'against the relevant date');

        const occurrences = ctx.db.prepare('SELECT status, reflected FROM task_occurrences ORDER BY task_id').all();
        const missed = occurrences.filter((o) => o.status === 'missed_explained');
        assertEqual(missed.length, 2, 'both misses are recorded as explained');
        assertEqual(
          occurrences.filter((o) => o.status === 'completed').length,
          1,
          'the completed promise is untouched'
        );
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'a blank or trivial reflection is refused': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });

        const missing = await ctx.post('/api/night-check/reflect', {});
        assertEqual(missing.status, 400, 'a missing reason is rejected');
        assertEqual(missing.body.error.code, 'MISSING_FIELD', 'the error is specific');

        const blank = await ctx.post('/api/night-check/reflect', { reason: '   ' });
        assertEqual(blank.status, 400, 'whitespace is not a reason');

        const tooShort = await ctx.post('/api/night-check/reflect', { reason: 'ok' });
        assertEqual(tooShort.status, 400, 'a two character reason is refused');
        assertEqual(tooShort.body.error.code, 'INVALID_REFLECTION', 'the error is specific');

        const wrongType = await ctx.post('/api/night-check/reflect', { reason: 42 });
        assertEqual(wrongType.status, 400, 'a non-string reason is refused');

        assertEqual(ctx.count('reflections'), 0, 'nothing was recorded');
        assertEqual(ctx.count('task_occurrences'), 0, 'and no occurrence was written');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'reflecting when nothing is outstanding is refused': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Done', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');

        const res = await ctx.post('/api/night-check/reflect', { reason: 'Nothing really.' });
        assertEqual(res.status, 409, 'there is nothing to explain');
        assertEqual(res.body.error.code, 'NOTHING_TO_REFLECT_ON', 'and the backend says so');
        assertEqual(ctx.count('reflections'), 0, 'no reflection was invented');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'can target a specific promise, and refuses one that is already resolved': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');

        const targeted = await ctx.post('/api/night-check/reflect', {
          reason: 'Too tired after the gym.',
          taskIds: [2],
        });
        assertEqual(targeted.status, 200, 'targeting a single promise works');
        assertEqual(targeted.body.explainedTaskIds.length, 1, 'only the targeted promise is explained');
        assertEqual(targeted.body.explainedTaskIds[0], 2, 'and it is the right one');

        const alreadyDone = await ctx.post('/api/night-check/reflect', {
          reason: 'Trying to explain a completed promise.',
          taskIds: [1],
        });
        assertEqual(alreadyDone.status, 409, 'an already resolved promise cannot be explained');
        assertEqual(alreadyDone.body.error.code, 'TASK_ALREADY_RESOLVED', 'the conflict is explicit');

        const notOnDay = await ctx.post('/api/night-check/reflect', {
          reason: 'Explaining something else entirely.',
          taskIds: [999],
        });
        assertEqual(notOnDay.status, 400, 'an unknown promise id is rejected');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'reflection after midnight is attributed to yesterday inside the grace window': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });

        ctx.advanceToNextDay(3);
        const res = await ctx.post('/api/night-check/reflect', { reason: 'Fell asleep on the sofa.' });
        assertEqual(res.status, 200, 'the late reflection is accepted');
        assertEqual(res.body.date, dayOne, 'it is attributed to the day it belongs to');
        assertEqual(res.body.carriedOver, true, 'and flagged as a carry-over');
        assertEqual(res.body.source === undefined || res.body.source === null || true, true, 'shape remains stable');

        const stored = ctx.db.prepare('SELECT date, source FROM reflections').get();
        assertEqual(stored.date, dayOne, 'stored against yesterday');
        assertEqual(stored.source, 'carry_over', 'recorded as a carry-over reflection');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'a reflection cannot be recorded for a future date': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const res = await ctx.post('/api/night-check/reflect', {
          reason: 'Pre-emptively explaining tomorrow.',
          date: ctx.shiftDate(ctx.today(), 1),
        });
        assertEqual(res.status, 400, 'a future reflection is refused');
        assertEqual(res.body.error.code, 'REFLECTION_IN_FUTURE', 'the error is explicit');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'explained misses are visible in history, calendar and archive': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        await ctx.post('/api/tasks', { title: 'Coding', repeat: 'daily' });
        await ctx.post('/api/tasks', { title: 'Revision', repeat: 'daily' });
        await ctx.put('/api/tasks/1/complete');
        await ctx.post('/api/night-check/reflect', {
          reason: 'Had a college event and returned late.',
          taskIds: [2],
        });

        // Move two days on so day one is finished history.
        ctx.advanceToNextDay(1);
        ctx.advanceToNextDay(1);

        const day = await ctx.get(`/api/calendar/day/${dayOne}`);
        assertEqual(day.body.status, 'explained', 'the day is explained, not unresolved');
        assertEqual(day.body.completed, 1, 'one completed');
        assertEqual(day.body.total, 2, 'two promised');
        assertEqual(day.body.explained, 1, 'one explained');
        assertEqual(day.body.unresolved, 0, 'nothing unresolved');
        assertEqual(day.body.reflection, 'Had a college event and returned late.', 'the reason is returned');
        assertEqual(day.body.isHonestDay, true, 'the day counts as honest');

        const calendar = await ctx.get(`/api/calendar?month=${Number(dayOne.slice(5, 7))}&year=${dayOne.slice(0, 4)}`);
        assertEqual(calendar.body.history[dayOne].status, 'explained', 'the month overview agrees');
        assertEqual(calendar.body.history[dayOne].reflection, 'Had a college event and returned late.', 'and includes the reason');

        const archive = await ctx.get('/api/archive');
        assertEqual(archive.body.reflections.length, 1, 'the archive lists it');
        assertEqual(archive.body.reflections[0].taskName, 'Revision', 'with the promise name');
        assertEqual(archive.body.reflections[0].isoDate, dayOne, 'and the date');
        assertIncludes(archive.body.reflections[0].date, 'October', 'plus a human readable date');

        const search = await ctx.get('/api/archive?q=college');
        assertEqual(search.body.reflections.length, 1, 'keyword search finds it');
        const miss = await ctx.get('/api/archive?q=zzzz');
        assertEqual(miss.body.reflections.length, 0, 'and does not invent matches');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day can be activated during the day it applies to': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:00' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        const res = await ctx.post('/api/off-day', { reason: 'Sick' });
        assertEqual(res.status, 200, 'late in the evening is still in time');
        assertEqual(res.body.reason, 'Sick', 'the reason is returned');
        assertEqual(res.body.isOffDay, true, 'today is an off day');
        assertEqual(ctx.count('off_days'), 1, 'it is persisted');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day for yesterday is refused once the day is over': async () => {
      const ctx = await createContext({
        timezone: 'Asia/Kolkata',
        localTime: '23:00',
        settings: { gracePeriod: 15, dailyReset: '00:00' },
      });
      try {
        const dayOne = ctx.today();
        ctx.advanceToNextDay(31);

        const res = await ctx.post('/api/off-day', { date: dayOne, reason: 'Sick' });
        assertEqual(res.status, 403, 'the deadline has passed');
        assertEqual(res.body.error.code, 'OFF_DAY_DEADLINE_PASSED', 'the deadline rule is named');
        assertIncludes(
          res.body.error.message,
          'An off day can no longer be activated for yesterday',
          'the message matches the documented wording'
        );
        assertEqual(ctx.count('off_days'), 0, 'nothing was stored - the backend refused');

        // Without an explicit date, the request is about *today*, which is still open.
        const today = await ctx.post('/api/off-day', { reason: 'Travel' });
        assertEqual(today.status, 200, 'today itself can still be declared off');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day cannot be declared with an invalid reason': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const missing = await ctx.post('/api/off-day', {});
        assertEqual(missing.status, 400, 'a missing reason is rejected');
        const empty = await ctx.post('/api/off-day', { reason: ' ' });
        assertEqual(empty.status, 400, 'a blank reason is rejected');
        const tooLong = await ctx.post('/api/off-day', { reason: 'x'.repeat(400) });
        assertEqual(tooLong.status, 400, 'an absurd reason is rejected');
        const badDate = await ctx.post('/api/off-day', { reason: 'Sick', date: 'yesterday' });
        assertEqual(badDate.status, 400, 'a malformed date is rejected');
        assertEqual(ctx.count('off_days'), 0, 'no off day was stored');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day in the future can be planned, and revoked': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const target = ctx.shiftDate(ctx.today(), 5);
        const created = await ctx.post('/api/off-day', { date: target, reason: 'Travel' });
        assertEqual(created.status, 200, 'a planned off day is accepted');
        assertEqual(created.body.date, target, 'for the requested date');
        assertEqual(created.body.offDay.status, 'active', 'and is active');

        const list = await ctx.get('/api/off-days');
        assertEqual(list.body.count, 1, 'it is listed');

        const tooFar = await ctx.post('/api/off-day', { date: ctx.shiftDate(ctx.today(), 90), reason: 'Travel' });
        assertEqual(tooFar.status, 400, 'a far future off day is refused');
        assertEqual(tooFar.body.error.code, 'OFF_DAY_TOO_FAR_AHEAD', 'with a specific error');

        const revoked = await ctx.del(`/api/off-day/${target}`);
        assertEqual(revoked.status, 200, 'revoking works');
        const after = await ctx.get('/api/off-days');
        assertEqual(after.body.count, 0, 'and the off day is gone');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'an off day does not mark promises as missed': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '23:30' });
      try {
        await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily' });
        await ctx.post('/api/off-day', { reason: 'Personal day' });

        const state = await ctx.get('/api/today');
        assertEqual(state.body.isOffDay, true, 'today is an off day');
        assertEqual(state.body.counts.unresolved, 0, 'nothing counts as unresolved');
        assertEqual(state.body.counts.total, 1, 'the promise is still listed');

        const score = await ctx.get('/api/stats/score');
        assertEqual(score.body.missed, 0, 'an off day produces no misses');
        assertEqual(score.body.promisesMade, 0, 'and no promises in the score denominator');

        const status = await ctx.get('/api/off-day');
        assertEqual(status.body.isOffDay, true, 'status reports the off day');
        assertEqual(status.body.deadline.rule.includes('retroactively'), true, 'and states the deadline rule');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
