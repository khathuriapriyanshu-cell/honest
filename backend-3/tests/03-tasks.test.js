'use strict';

/**
 * Promise (task) API + recurrence resolution.
 *
 * The central rule under test: the backend decides which promises belong to a
 * date. The frontend only renders what it is given.
 */

const { createContext, assertTrue, assertEqual, assertIncludes } = require('./helpers');

module.exports = function taskTests() {
  return {
    'creates a promise and returns the documented shape': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const res = await ctx.post('/api/tasks', {
          title: 'Study Physics',
          definition: 'At least 45 minutes without phone',
          category: 'Study',
          repeat: 'daily',
          reminder: '20:00',
          accountabilityTime: '22:30',
        });
        assertEqual(res.status, 201, 'creating a promise returns 201');
        assertEqual(res.body.success, true, 'success flag is present');
        assertEqual(res.body.task.title, 'Study Physics', 'title is echoed back');
        assertEqual(res.body.task.definition, 'At least 45 minutes without phone', 'the minimum definition is stored');
        assertEqual(res.body.task.category, 'Study', 'category is stored');
        assertEqual(res.body.task.repeat, 'daily', 'repeat type is stored');
        assertEqual(res.body.task.completed, false, 'a new promise starts incomplete');
        assertEqual(res.body.task.accountabilityTime, '22:30', 'the promise carries its accountability time');
        assertEqual(res.body.data.task.title, 'Study Physics', 'the same payload also appears under data');
        assertEqual(ctx.count('tasks'), 1, 'exactly one row was persisted');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'accepts "name" as an alias for "title"': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const res = await ctx.post('/api/tasks', { name: 'Read 20 pages', repeat: 'daily' });
        assertEqual(res.status, 201, 'creation succeeds');
        assertEqual(res.body.task.title, 'Read 20 pages', 'the name is used as the title');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'rejects invalid promise input with useful errors': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const noTitle = await ctx.post('/api/tasks', { category: 'Study' });
        assertEqual(noTitle.status, 400, 'a missing title is a client error');
        assertEqual(noTitle.body.success, false, 'failure flag is present');
        assertEqual(noTitle.body.error.code, 'MISSING_FIELD', 'a stable error code is returned');

        const badRepeat = await ctx.post('/api/tasks', { title: 'X', repeat: 'hourly' });
        assertEqual(badRepeat.status, 400, 'an unsupported repeat type is rejected');
        assertEqual(badRepeat.body.error.code, 'INVALID_REPEAT', 'the repeat error is specific');

        const badTime = await ctx.post('/api/tasks', { title: 'X', accountabilityTime: '25:99' });
        assertEqual(badTime.status, 400, 'an impossible time is rejected');
        assertEqual(badTime.body.error.code, 'INVALID_TIME', 'the time error is specific');

        const selectedNoDays = await ctx.post('/api/tasks', { title: 'X', repeat: 'selected', selectedDays: [] });
        assertEqual(selectedNoDays.status, 400, 'selected-days without days is rejected');
        assertEqual(selectedNoDays.body.error.code, 'REPEAT_DAYS_REQUIRED', 'the error explains what is missing');

        const badDays = await ctx.post('/api/tasks', { title: 'X', repeat: 'selected', selectedDays: [9] });
        assertEqual(badDays.status, 400, 'a weekday outside 1..7 is rejected');

        const badDate = await ctx.post('/api/tasks', { title: 'X', startDate: '2026-02-30' });
        assertEqual(badDate.status, 400, 'an impossible date is rejected');

        assertEqual(ctx.count('tasks'), 0, 'no invalid promise was persisted');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'daily promise appears on every day after it starts': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        await ctx.post('/api/tasks', { title: 'Daily Coding', repeat: 'daily', startDate: today });

        const tomorrow = ctx.shiftDate(today, 1);
        const yesterday = ctx.shiftDate(today, -1);

        const todayState = await ctx.get('/api/today');
        assertEqual(todayState.body.tasks.length, 1, 'the promise is scheduled today');

        const tomorrowState = await ctx.get(`/api/day?date=${tomorrow}`);
        assertEqual(tomorrowState.body.tasks.length, 1, 'a daily promise also belongs to tomorrow');

        const yesterdayState = await ctx.get(`/api/day?date=${yesterday}`);
        assertEqual(yesterdayState.body.tasks.length, 0, 'it does not exist before its start date');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'selected-days promise only appears on the chosen weekdays': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        // Monday only.
        const created = await ctx.post('/api/tasks', {
          title: 'Monday Lecture Prep',
          repeat: 'selected',
          selectedDays: [1],
          startDate: ctx.shiftDate(today, -30),
        });
        assertEqual(created.status, 201, 'creation succeeds');
        assertEqual(created.body.task.repeatDays.join(','), '1', 'the chosen weekdays are stored');

        const scheduled = [];
        for (let i = 0; i < 7; i += 1) {
          const date = ctx.shiftDate(today, i);
          const day = await ctx.get(`/api/day?date=${date}`);
          if (day.body.tasks.some((t) => t.title === 'Monday Lecture Prep')) scheduled.push(date);
        }
        assertEqual(scheduled.length, 1, 'exactly one occurrence in a seven day window');
        const weekday = require('../utils/time').isoWeekdayFromDate(scheduled[0]);
        assertEqual(weekday, 1, 'the occurrence falls on a Monday');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'one-time promise only appears on its own date': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        const target = ctx.shiftDate(today, 2);
        const created = await ctx.post('/api/tasks', {
          title: 'Submit assignment',
          repeat: 'once',
          startDate: target,
        });
        assertEqual(created.status, 201, 'creation succeeds');

        const onTarget = await ctx.get(`/api/day?date=${target}`);
        assertEqual(onTarget.body.tasks.length, 1, 'it belongs to its scheduled date');

        const onToday = await ctx.get('/api/today');
        assertEqual(onToday.body.tasks.length, 0, 'it does not appear before its date');

        const after = await ctx.get(`/api/day?date=${ctx.shiftDate(target, 1)}`);
        assertEqual(after.body.tasks.length, 0, 'it does not repeat the next day');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'completing and undoing a promise is persisted and reflected in daily state': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const created = await ctx.post('/api/tasks', { title: 'Workout', repeat: 'daily', category: 'Workout' });
        const id = created.body.task.id;

        const complete = await ctx.put(`/api/tasks/${id}/complete`);
        assertEqual(complete.status, 200, 'completion succeeds');
        assertEqual(complete.body.success, true, 'success is reported');
        assertEqual(complete.body.task.completed, true, 'the promise is reported complete');

        const state = await ctx.get('/api/today');
        const task = state.body.tasks.find((t) => t.id === id);
        assertEqual(task.completed, true, 'daily state shows it complete');
        assertEqual(state.body.counts.completed, 1, 'the completed count is real');
        assertEqual(state.body.status, 'active', "today's status stays active while the day is in progress");

        const occurrence = ctx.db.prepare('SELECT * FROM task_occurrences WHERE task_id = ?').get(Number(id));
        assertEqual(occurrence.completed, 1, 'the occurrence row is persisted');
        assertEqual(occurrence.status, 'completed', 'the derived status is completed');
        assertEqual(occurrence.task_name, 'Workout', 'the promise content is frozen on the occurrence');

        const undo = await ctx.put(`/api/tasks/${id}/uncomplete`);
        assertEqual(undo.status, 200, 'undoing succeeds the same day');
        assertEqual(undo.body.task.completed, false, 'the promise is incomplete again');
        const after = ctx.db.prepare('SELECT * FROM task_occurrences WHERE task_id = ?').get(Number(id));
        assertEqual(after.status, 'missed_unexplained', 'the derived status returns to unresolved');

        const second = await ctx.put(`/api/tasks/${id}/uncomplete`);
        assertEqual(second.status, 409, 'undoing twice is a conflict, not a silent success');
        assertEqual(second.body.error.code, 'NOT_COMPLETED', 'the conflict explains itself');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'refuses to complete a promise for a date it is not scheduled on': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        const created = await ctx.post('/api/tasks', {
          title: 'Wednesday only',
          repeat: 'selected',
          selectedDays: [3],
          startDate: ctx.shiftDate(today, -30),
        });
        const id = created.body.task.id;

        // Find a recent past date that is not a Wednesday.
        let otherDay = ctx.shiftDate(today, -1);
        for (let i = 1; i < 8; i += 1) {
          const candidate = ctx.shiftDate(today, -i);
          if (require('../utils/time').isoWeekdayFromDate(candidate) !== 3) {
            otherDay = candidate;
            break;
          }
        }

        const res = await ctx.put(`/api/tasks/${id}/complete?date=${otherDay}`);
        assertEqual(res.status, 403, 'completing a closed past day is refused');
        assertEqual(res.body.error.code, 'DAY_CLOSED', 'the error names the rule that applies');
        assertEqual(ctx.count('task_occurrences'), 0, 'nothing was persisted for the rejected completion');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'rejects a completion for a weekday the promise does not fall on': async () => {
      // Start well away from the grace window that follows the daily reset.
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '10:00' });
      try {
        const day = (offset) => require('../utils/time').isoWeekdayFromDate(ctx.shiftDate(ctx.today(), offset));
        const excluded = [day(0), day(-1)];
        const chosen = [1, 2, 3, 4, 5, 6, 7].find((weekday) => !excluded.includes(weekday));

        const created = await ctx.post('/api/tasks', {
          title: 'Specific weekday only',
          repeat: 'selected',
          selectedDays: [chosen],
          startDate: ctx.shiftDate(ctx.today(), -30),
        });
        const id = created.body.task.id;
        assertEqual(created.status, 201, 'creation succeeds');
        assertEqual(created.body.task.repeatDays.join(','), String(chosen), 'the chosen weekday is stored');

        // Move clear of the grace window that follows the daily reset.
        ctx.advanceToLocal('09:00');

        const res = await ctx.put(`/api/tasks/${id}/complete`);
        assertEqual(res.status, 400, 'completing it on a day it does not fall on is a client error');
        assertEqual(res.body.error.code, 'TASK_NOT_SCHEDULED', 'the error names the schedule rule');
        assertEqual(ctx.count('task_occurrences'), 0, 'nothing was persisted');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'refuses to complete a promise in the future': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const created = await ctx.post('/api/tasks', { title: 'Daily', repeat: 'daily' });
        const id = created.body.task.id;
        const future = ctx.shiftDate(ctx.today(), 1);
        const res = await ctx.put(`/api/tasks/${id}/complete?date=${future}`);
        assertEqual(res.status, 400, 'a future completion is rejected');
        assertEqual(res.body.error.code, 'COMPLETION_IN_FUTURE', 'the error is explicit');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'one-time promise is retired when completed': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        const created = await ctx.post('/api/tasks', { title: 'Pay fees', repeat: 'once', startDate: today });
        const id = created.body.task.id;
        await ctx.put(`/api/tasks/${id}/complete`);

        const row = ctx.db.prepare('SELECT * FROM tasks WHERE id = ?').get(Number(id));
        assertEqual(row.status, 'inactive', 'a finished one-time promise is deactivated');
        assertIncludes(row.snapshot, 'Pay fees', 'its content is frozen for history');

        const state = await ctx.get('/api/today');
        assertEqual(state.body.tasks.length, 1, 'it still appears in today so the record is complete');
        assertEqual(state.body.tasks[0].completed, true, 'and it shows as completed');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'editing a recurring promise does not rewrite past history': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        const created = await ctx.post('/api/tasks', {
          title: 'Original Name',
          definition: 'Original definition',
          repeat: 'daily',
          startDate: today,
        });
        const id = created.body.task.id;
        await ctx.put(`/api/tasks/${id}/complete`);

        const updated = await ctx.patch(`/api/tasks/${id}`, {
          title: 'Renamed Promise',
          definition: 'New definition',
        });
        assertEqual(updated.status, 200, 'the edit succeeds');
        assertEqual(updated.body.task.title, 'Renamed Promise', 'the live promise is renamed');

        const state = await ctx.get('/api/today');
        const task = state.body.tasks.find((t) => t.id === id);
        // Today has no stored occurrence content mismatch problem: the point is
        // that the *stored* occurrence kept the original wording.
        const occ = ctx.db.prepare('SELECT * FROM task_occurrences WHERE task_id = ?').get(Number(id));
        assertEqual(occ.task_name, 'Original Name', 'the frozen name is unchanged');
        assertEqual(occ.task_definition, 'Original definition', 'the frozen definition is unchanged');
        assertTrue(task !== undefined, 'the promise is still listed today');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'deactivating a promise keeps its history and stops future recurrence': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const today = ctx.today();
        const created = await ctx.post('/api/tasks', { title: 'Old habit', repeat: 'daily', startDate: today });
        const id = created.body.task.id;
        await ctx.put(`/api/tasks/${id}/complete`);

        const removed = await ctx.del(`/api/tasks/${id}`);
        assertEqual(removed.status, 200, 'deactivation succeeds');
        assertEqual(removed.body.mode, 'deactivated', 'the default is a soft deactivate');
        assertEqual(ctx.count('tasks'), 1, 'the promise row is kept for history');
        assertEqual(ctx.count('task_occurrences'), 1, 'its completion history is kept');

        const tomorrow = await ctx.get(`/api/day?date=${ctx.shiftDate(today, 1)}`);
        assertEqual(tomorrow.body.tasks.length, 0, 'it no longer recurs tomorrow');

        const todayState = await ctx.get('/api/today');
        assertEqual(todayState.body.tasks.length, 1, "today's record still shows it (inactive from today)");
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'refuses to erase a promise that already has history': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const created = await ctx.post('/api/tasks', { title: 'Has history', repeat: 'daily' });
        const id = created.body.task.id;
        await ctx.put(`/api/tasks/${id}/complete`);

        const hard = await ctx.del(`/api/tasks/${id}?hard=true`);
        assertEqual(hard.status, 409, 'a hard delete with history is refused');
        assertEqual(hard.body.error.code, 'TASK_HAS_HISTORY', 'the refusal is explained honestly');
        assertEqual(ctx.count('tasks'), 1, 'nothing was deleted');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'hard-deletes a promise that was created by mistake': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata', localTime: '09:00' });
      try {
        const created = await ctx.post('/api/tasks', { title: 'Typo promise', repeat: 'daily' });
        const id = created.body.task.id;
        const hard = await ctx.del(`/api/tasks/${id}?hard=true`);
        assertEqual(hard.status, 200, 'a history-free promise can be deleted');
        assertEqual(ctx.count('tasks'), 0, 'the row is gone');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'returns 404 for an unknown promise id and 400 for a nonsense id': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        const missing = await ctx.get('/api/tasks/999');
        assertEqual(missing.status, 404, 'an unknown id is a 404');
        assertEqual(missing.body.error.code, 'TASK_NOT_FOUND', 'the code is specific');

        const nonsense = await ctx.get('/api/tasks/abc');
        assertEqual(nonsense.status, 400, 'a non-numeric id is a 400');
        assertEqual(nonsense.body.error.code, 'INVALID_ID', 'the code is specific');

        const completeMissing = await ctx.put('/api/tasks/999/complete');
        assertEqual(completeMissing.status, 404, 'completing an unknown promise is a 404');

        const deleteMissing = await ctx.del('/api/tasks/999');
        assertEqual(deleteMissing.status, 404, 'deleting an unknown promise is a 404');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },

    'lists promises and supports filters': async () => {
      const ctx = await createContext({ timezone: 'Asia/Kolkata' });
      try {
        await ctx.post('/api/tasks', { title: 'A', repeat: 'daily', category: 'Study' });
        await ctx.post('/api/tasks', { title: 'B', repeat: 'selected', selectedDays: [2], category: 'Health' });
        const c = await ctx.post('/api/tasks', { title: 'C', repeat: 'daily', category: 'Study' });
        await ctx.del(`/api/tasks/${c.body.task.id}`);

        const all = await ctx.get('/api/tasks');
        assertEqual(all.body.count, 3, 'all promises are listed');
        const active = await ctx.get('/api/tasks?status=active');
        assertEqual(active.body.count, 2, 'only active promises');
        const inactive = await ctx.get('/api/tasks?status=inactive');
        assertEqual(inactive.body.count, 1, 'only inactive promises');
        const study = await ctx.get('/api/tasks?category=Study');
        assertEqual(study.body.count, 2, 'filtered by category');
      } finally {
        await ctx.close();
        ctx.cleanup();
      }
    },
  };
};
