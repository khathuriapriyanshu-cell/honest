'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp, clockAt } = require('./helpers');

// Fixed clock: 2026-10-05 12:00 UTC (a Monday). Timezone pinned to UTC.
const clock = clockAt('2026-10-05T12:00:00Z');
let app;

test.before(async () => {
  app = await startApp({ now: () => clock.value });
  const tz = await app.put('/settings', { timezone: 'UTC' });
  assert.strictEqual(tz.status, 200);
});

test.after(async () => {
  await app.stop();
});

test('task CRUD: create, list, fetch, update, deactivate, restore', async (t) => {
    const created = await app.post('/tasks', {
    name: 'Study Physics',
    category: 'Study',
    repeatType: 'daily',
    minimumCompletion: { value: 45, unit: 'minutes', text: 'At least 45 minutes' },
    reminderTime: '20:00',
  });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.success, true);
  const task = created.body.data.task;
  assert.strictEqual(task.name, 'Study Physics');
  assert.strictEqual(task.repeatType, 'daily');
  assert.strictEqual(task.minimumCompletion.value, 45);
  assert.strictEqual(task.isActive, true);
  assert.strictEqual(task.startDate, '2026-10-05'); // defaults to today
  // Frontend flat projection present at the top level.
  assert.strictEqual(created.body.task.title, 'Study Physics');
  assert.strictEqual(created.body.task.definition, 'At least 45 minutes');

  const list = await app.get('/tasks');
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.data.tasks.length, 1);

  const one = await app.get(`/tasks/${task.id}`);
  assert.strictEqual(one.status, 200);
  assert.strictEqual(one.body.data.task.id, task.id);

  const renamed = await app.patch(`/tasks/${task.id}`, { name: 'Study Physics (Ch 4)' });
  assert.strictEqual(renamed.status, 200);
  assert.strictEqual(renamed.body.data.task.name, 'Study Physics (Ch 4)');

  // Schedule edit same-day: the old row covered only today (empty historical
  // range), so it is dropped; the new rule replaces it from today onward.
  // Cross-day history preservation is covered in reports.test.js.
  const rescheduled = await app.patch(`/tasks/${task.id}`, { repeatType: 'selected_days', selectedDays: [1, 3] });
  assert.strictEqual(rescheduled.status, 200);
  assert.strictEqual(rescheduled.body.data.task.repeatType, 'selected_days');
  assert.deepStrictEqual(rescheduled.body.data.task.selectedDays, [1, 3]);
  assert.strictEqual(rescheduled.body.data.task.schedules.length, 1);
  assert.strictEqual(rescheduled.body.data.task.schedules[0].startDate, '2026-10-05');
  assert.strictEqual(rescheduled.body.data.task.schedules[0].endDate, null);

  const deleted = await app.del(`/tasks/${task.id}`);
  assert.strictEqual(deleted.status, 200);
  assert.strictEqual(deleted.body.data.task.isActive, false);

  const listActive = await app.get('/tasks');
  assert.strictEqual(listActive.body.data.tasks.length, 0);
  const listAll = await app.get('/tasks?includeInactive=true');
  assert.strictEqual(listAll.body.data.tasks.length, 1);

  const restored = await app.post(`/tasks/${task.id}/restore`);
  assert.strictEqual(restored.status, 200);
  assert.strictEqual(restored.body.data.task.isActive, true);
});

test('recurring logic: daily / selected days / one-time appearance', async (t) => {
    const daily = await app.post('/tasks', { name: 'Daily walk', repeatType: 'daily' });
  const monWed = await app.post('/tasks', { name: 'Mon/Wed gym', repeatType: 'selected_days', selectedDays: [1, 3] });
  const tueOnly = await app.post('/tasks', { name: 'Tue only', repeatType: 'selected_days', selectedDays: [2] });
  const onceToday = await app.post('/tasks', { name: 'One-time today', repeatType: 'one_time' });
  const onceFuture = await app.post('/tasks', {
    name: 'One-time Oct 7',
    repeatType: 'one_time',
    startDate: '2026-10-07',
  });
  for (const r of [daily, monWed, tueOnly, onceToday, onceFuture]) assert.strictEqual(r.status, 201);

  const today = await app.get('/today');
  const names = today.body.data.tasks.map((x) => x.name).sort();
  // 2026-10-05 is a Monday.
  assert.deepStrictEqual(names, ['Daily walk', 'Mon/Wed gym', 'One-time today', 'Study Physics (Ch 4)']);

  const futureDay = await app.get('/calendar/2026-10-07');
  assert.strictEqual(futureDay.body.data.status, 'future');
  assert.deepStrictEqual(futureDay.body.data.tasks, []);

  // Yesterday (before the task existed) has no promises.
  const past = await app.get('/calendar/2026-10-04');
  assert.strictEqual(past.body.data.status, 'no_promises');
});

test('task validation rejects bad input with useful errors', async (t) => {
    const cases = [
    [{ repeatType: 'daily' }, 'missing name', 'VALIDATION_ERROR'],
    [{ name: '   ' }, 'blank name', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'weekly' }, 'bad repeat type', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'selected_days' }, 'selected days missing', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'selected_days', selectedDays: [9] }, 'weekday out of range', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'selected_days', selectedDays: [] }, 'empty selected days', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'daily', selectedDays: [1] }, 'days with daily', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'one_time', startDate: '2026-10-01' }, 'past start date', 'DATE_IN_PAST'],
    [{ name: 'X', repeatType: 'daily', startDate: '2026-13-01' }, 'impossible date', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'daily', reminderTime: '25:00' }, 'bad reminder time', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'daily', endDate: '2026-10-01', startDate: '2026-10-05' }, 'end before start', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'daily', color: 'red' }, 'unknown field', 'VALIDATION_ERROR'],
    [{ name: 'X', repeatType: 'daily', minimumCompletion: { value: -5 } }, 'negative min value', 'VALIDATION_ERROR'],
  ];
  for (const [body, label, code] of cases) {
    const res = await app.post('/tasks', body);
    assert.strictEqual(res.status, 400, label);
    assert.strictEqual(res.body.success, false, label);
    assert.strictEqual(res.body.error.code, code, label);
    if (code === 'VALIDATION_ERROR') assert.ok(Array.isArray(res.body.error.details), label);
  }

  assert.strictEqual((await app.get('/tasks/abc')).status, 400);
  const missing = await app.get('/tasks/9999');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error.code, 'TASK_NOT_FOUND');
});

test('frontend alias keys are accepted (title/repeat/definition/reminder)', async (t) => {
    const res = await app.post('/tasks', {
    title: '2 hrs Coding',
    definition: 'At least 45 minutes focused session',
    category: 'DSA',
    repeat: 'daily',
    reminder: '20:00',
    accountabilityTime: '22:30',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.data.task.name, '2 hrs Coding');
  assert.strictEqual(res.body.data.task.minimumCompletion.text, 'At least 45 minutes focused session');
  assert.strictEqual(res.body.data.task.repeatType, 'daily');
  assert.strictEqual(res.body.data.task.reminderTime, '20:00');

  const sel = await app.post('/tasks', { title: 'Alt days', repeat: 'selected', selectedDays: [1] });
  assert.strictEqual(sel.status, 201);
  assert.strictEqual(sel.body.data.task.repeatType, 'selected_days');
});

test('completion: mark, update, undo; errors for wrong dates and tasks', async (t) => {
    const task = (await app.post('/tasks', { name: 'Completable', repeatType: 'daily' })).body.data.task;
  const tueTask = (await app.post('/tasks', { name: 'Tue task', repeatType: 'selected_days', selectedDays: [2] }))
    .body.data.task;

  const done = await app.put(`/tasks/${task.id}/complete`, { minutes: 45, note: 'Focused block' });
  assert.strictEqual(done.status, 200);
  assert.strictEqual(done.body.data.task.status, 'completed');
  assert.strictEqual(done.body.data.task.minutesSpent, 45);
  assert.strictEqual(done.body.task.completed, true); // flat frontend shape

  // Re-completing updates details without duplicating the record.
  const again = await app.put(`/tasks/${task.id}/complete`, { note: 'Actually 60 min', minutes: 60 });
  assert.strictEqual(again.status, 200);
  const detail = await app.get(`/tasks/${task.id}`);
  assert.strictEqual(detail.body.data.task.recentCompletions.length, 1);
  assert.strictEqual(detail.body.data.task.recentCompletions[0].note, 'Actually 60 min');

  // Not scheduled today (Tuesday-only task on a Monday).
  const notScheduled = await app.put(`/tasks/${tueTask.id}/complete`, { date: '2026-10-05' });
  assert.strictEqual(notScheduled.status, 409);
  assert.strictEqual(notScheduled.body.error.code, 'TASK_NOT_SCHEDULED');

  const future = await app.put(`/tasks/${task.id}/complete`, { date: '2026-10-06' });
  assert.strictEqual(future.status, 400);
  assert.strictEqual(future.body.error.code, 'DATE_IN_FUTURE');

  const badMinutes = await app.put(`/tasks/${task.id}/complete`, { minutes: -5 });
  assert.strictEqual(badMinutes.status, 400);

  const undone = await app.put(`/tasks/${task.id}/uncomplete`);
  assert.strictEqual(undone.status, 200);
  assert.strictEqual(undone.body.task.completed, false);
  const undoneAgain = await app.put(`/tasks/${task.id}/uncomplete`);
  assert.strictEqual(undoneAgain.status, 404);
  assert.strictEqual(undoneAgain.body.error.code, 'COMPLETION_NOT_FOUND');

  assert.strictEqual((await app.put('/tasks/9999/complete')).status, 404);
});

test('deleting a task preserves its completed history for today', async (t) => {
    const task = (await app.post('/tasks', { name: 'Delete me after done', repeatType: 'daily' })).body.data.task;
  await app.put(`/tasks/${task.id}/complete`);
  await app.del(`/tasks/${task.id}`);

  const today = await app.get('/today');
  const occ = today.body.data.tasks.find((x) => x.taskId === task.id);
  assert.ok(occ, 'completed occurrence should still be visible after deactivation');
  assert.strictEqual(occ.status, 'completed');
});

test('malformed JSON and unknown routes fail cleanly', async (t) => {
    const bad = await app.call('POST', '/tasks', undefined, '{"name": broken');
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'INVALID_JSON');

  const nope = await app.get('/definitely-not-a-route');
  assert.strictEqual(nope.status, 404);
  assert.strictEqual(nope.body.error.code, 'NOT_FOUND');
});
