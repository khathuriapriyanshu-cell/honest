'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp, clockAt } = require('./helpers');
const eventService = require('../services/eventService');
const { getClockContext } = require('../services/settingsService');

/**
 * Full accountability cycle in Asia/Kolkata (UTC+5:30):
 *   20:30 open -> 22:35 accountability -> 23:20 grace_ended ->
 *   23:50 final warning -> 00:00 new day, yesterday red -> reflect -> yellow.
 */
const clock = clockAt('2026-10-05T15:00:00Z'); // 20:30 IST
let app;
let taskA;
let taskB;

test.before(async () => {
  app = await startApp({ now: () => clock.value });
  const s = await app.put('/settings', {
    timezone: 'Asia/Kolkata',
    accountabilityTime: '22:30',
    gracePeriodMinutes: 15,
    dailyReset: '00:00',
  });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.settings.accountabilityTime, '22:30'); // flat shape
  assert.strictEqual(s.body.data.settings.timezoneEffective, 'Asia/Kolkata');

  const a = await app.post('/tasks', { name: 'Task A', repeatType: 'daily' });
  const b = await app.post('/tasks', { name: 'Task B', repeatType: 'daily' });
  taskA = a.body.data.task.id;
  taskB = b.body.data.task.id;
});

test.after(async () => {
  await app.stop();
});

test('phase: open before the accountability time', async (t) => {
    const state = await app.get('/today');
  assert.strictEqual(state.body.data.phase, 'open');
  assert.strictEqual(state.body.data.todayDate, '2026-10-05');
  assert.strictEqual(state.body.data.counts.promised, 2);
  assert.strictEqual(state.body.data.counts.incomplete, 2);
  assert.strictEqual(state.body.data.canStartToday, true); // yesterday had no promises
  const night = await app.get('/night-check');
  assert.strictEqual(night.body.active, false);
});

test('phase: accountability at 22:35 with unfinished promises', async (t) => {
    clock.value = new Date('2026-10-05T17:05:00Z'); // 22:35 IST
  const state = await app.get('/accountability/state');
  assert.strictEqual(state.body.data.phase, 'accountability');
  assert.strictEqual(state.body.data.counts.unfinishedPromises, 2);
  assert.strictEqual(state.body.data.messages.phase.title, 'Be honest with yourself.');
  assert.strictEqual(
    state.body.data.messages.phase.body,
    'You still have 2 unfinished promises today.'
  );

  const notif = await app.get('/notifications');
  assert.strictEqual(notif.body.notifications.length, 1);
  assert.match(notif.body.notifications[0].message, /2 unfinished promises today/);

  const night = await app.get('/night-check');
  assert.strictEqual(night.body.active, true);
  assert.strictEqual(night.body.unfinishedTasks.length, 2);
  assert.strictEqual(night.body.accountabilityTime, '22:30');
});

test('completing during the accountability window still counts', async (t) => {
    const done = await app.put(`/tasks/${taskA}/complete`);
  assert.strictEqual(done.status, 200);
  const state = await app.get('/today');
  assert.strictEqual(state.body.data.counts.unfinishedPromises, 1);
  assert.strictEqual(state.body.data.counts.completed, 1);
});

test('phases: grace_ended then final_warning with minutes left', async (t) => {
    clock.value = new Date('2026-10-05T17:50:00Z'); // 23:20 IST
  assert.strictEqual((await app.get('/accountability/state')).body.data.phase, 'grace_ended');

  clock.value = new Date('2026-10-05T18:20:00Z'); // 23:50 IST
  const state = await app.get('/accountability/state');
  assert.strictEqual(state.body.data.phase, 'final_warning');
  assert.strictEqual(state.body.data.messages.phase.title, '10 minutes left.');

  const notif = await app.get('/notifications');
  const ids = notif.body.notifications.map((n) => n.id);
  assert.ok(ids.includes('final-warning'));
});

test('midnight: new day, yesterday unresolved blocks start, reflection resolves it', async (t) => {
    clock.value = new Date('2026-10-05T18:30:00Z'); // exactly 2026-10-06 00:00 IST
  const state = await app.get('/today');
  assert.strictEqual(state.body.data.todayDate, '2026-10-06');
  assert.strictEqual(state.body.data.yesterday.status, 'red');
  assert.strictEqual(state.body.data.yesterday.resolved, false);
  assert.strictEqual(state.body.data.yesterday.reflectionRequired, true);
  assert.strictEqual(state.body.data.canStartToday, false);
  assert.strictEqual(state.body.data.messages.yesterday.title, 'Yesterday is waiting for an explanation.');
  assert.strictEqual(state.body.hasUnresolvedYesterday, true); // flat
  assert.deepStrictEqual(
    state.body.data.yesterday.unexplainedTasks.map((x) => x.name),
    ['Task B']
  );

  // The closed day can no longer be completed — only reflected on.
  const lateComplete = await app.put(`/tasks/${taskB}/complete`, { date: '2026-10-05' });
  assert.strictEqual(lateComplete.status, 409);
  assert.strictEqual(lateComplete.body.error.code, 'DAY_CLOSED');

  // Night-check reflect (frontend flow): applies to all owing tasks of the day.
  const reflect = await app.post('/night-check/reflect', {
    reason: 'Got back late from college and club work took longer than expected.',
  });
  assert.strictEqual(reflect.status, 200);
  assert.strictEqual(reflect.body.message, 'Reason recorded.');

  const after = await app.get('/today');
  assert.strictEqual(after.body.data.yesterday.status, 'yellow');
  assert.strictEqual(after.body.data.yesterday.resolved, true);
  assert.strictEqual(after.body.data.canStartToday, true);
  assert.strictEqual(after.body.hasUnresolvedYesterday, false);

  const day = await app.get('/calendar/day/2026-10-05');
  assert.strictEqual(day.body.data.status, 'yellow');
  assert.strictEqual(day.body.data.honestDay, true);
  assert.strictEqual(day.body.status, 'explained'); // flat
  const missed = day.body.data.tasks.find((x) => x.taskId === taskB);
  assert.strictEqual(missed.status, 'missed_explained');
  assert.match(missed.reflection.reason, /club work/);
});

test('reflection validation', async (t) => {
    const completedTask = await app.post('/reflections', {
    date: '2026-10-05',
    taskIds: [taskA],
    reason: 'why',
  });
  assert.strictEqual(completedTask.status, 409);
  assert.strictEqual(completedTask.body.error.code, 'REFLECTION_FOR_COMPLETED');

  const future = await app.post('/reflections', { date: '2026-10-07', taskIds: [taskB], reason: 'why' });
  assert.strictEqual(future.status, 400);
  assert.strictEqual(future.body.error.code, 'DATE_IN_FUTURE');

  const empty = await app.post('/reflections', { date: '2026-10-05', taskIds: [taskB], reason: '   ' });
  assert.strictEqual(empty.status, 400);

  const ghost = await app.post('/reflections', { date: '2026-10-05', taskIds: [9999], reason: 'why' });
  assert.strictEqual(ghost.status, 404);
  assert.strictEqual(ghost.body.error.code, 'TASK_NOT_FOUND');

  const alreadyExplained = await app.post('/reflections', {
    date: '2026-10-05',
    taskIds: [taskB],
    reason: 'Second attempt',
  });
  assert.strictEqual(alreadyExplained.status, 200); // upsert updates the reason
  const day = await app.get('/calendar/2026-10-05');
  assert.strictEqual(day.body.data.tasks.find((x) => x.taskId === taskB).reflection.reason, 'Second attempt');

  // With yesterday resolved, night-check reflect targets TODAY's incomplete
  // promises (early honesty) — the frontend flow works at any hour.
  const earlyToday = await app.post('/night-check/reflect', {
    reason: 'Already know I will not get to these tonight.',
  });
  assert.strictEqual(earlyToday.status, 200);
  assert.strictEqual(earlyToday.body.data.date, '2026-10-06');

  // Once everything owing has a reason, there is truly nothing to reflect on.
  const nothingLeft = await app.post('/night-check/reflect', { reason: 'Nothing owing now' });
  assert.strictEqual(nothingLeft.status, 409);
  assert.strictEqual(nothingLeft.body.error.code, 'NOTHING_TO_REFLECT');
});

test('grace period is configurable and validated', async (t) => {
    clock.value = new Date('2026-10-06T17:10:00Z'); // Oct 6, 22:40 IST
  const s = await app.patch('/settings', { gracePeriodMinutes: 30 });
  assert.strictEqual(s.status, 200);
  assert.strictEqual((await app.get('/accountability/state')).body.data.phase, 'accountability'); // grace ends 23:00

  clock.value = new Date('2026-10-06T17:35:00Z'); // 23:05 IST
  assert.strictEqual((await app.get('/accountability/state')).body.data.phase, 'grace_ended');

  const bad = await app.patch('/settings', { accountabilityTime: '23:50', gracePeriodMinutes: 30 });
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(bad.body.error.code, 'INVALID_SETTINGS');

  const badTz = await app.patch('/settings', { timezone: 'Mars/Olympus' });
  assert.strictEqual(badTz.status, 400);

  await app.patch('/settings', { gracePeriodMinutes: 15, accountabilityTime: '22:30' });
});

test('off day: activate before deadline only; retroactive is impossible', async (t) => {
  const app2 = await startApp({ now: () => clock.value });
  await app2.put('/settings', { timezone: 'Asia/Kolkata' });
  await app2.post('/tasks', { name: 'Daily promise', repeatType: 'daily' });

  // 20:00 IST on Oct 6 — before the 22:45 deadline.
  clock.value = new Date('2026-10-06T14:30:00Z');
  const off = await app2.post('/off-day', { reason: 'Sick' });
  assert.strictEqual(off.status, 201);
  assert.strictEqual(off.body.data.offDay.date, '2026-10-06');

  const state = await app2.get('/today');
  assert.strictEqual(state.body.isOffDay, true);
  assert.strictEqual(state.body.offDayReason, 'Sick');
  assert.strictEqual(state.body.data.counts.promised, 0); // nothing owed
  assert.strictEqual(state.body.data.counts.unfinishedPromises, 0);
  assert.strictEqual(state.body.data.messages.phase.title, 'Rest day.');

  // After the deadline (23:00 IST): cannot remove, cannot duplicate, cannot go retroactive.
  clock.value = new Date('2026-10-06T17:30:00Z'); // 23:00 IST
  const remove = await app2.del(`/off-days/${off.body.data.offDay.id}`);
  assert.strictEqual(remove.status, 409);
  assert.strictEqual(remove.body.error.code, 'OFF_DAY_LOCKED');

  const duplicate = await app2.post('/off-days', { date: '2026-10-06', reason: 'Sick again' });
  assert.strictEqual(duplicate.status, 409);
  assert.strictEqual(duplicate.body.error.code, 'OFF_DAY_DEADLINE_PASSED');

  const retroactive = await app2.post('/off-days', { date: '2026-10-05', reason: 'Travel' });
  assert.strictEqual(retroactive.status, 409);
  assert.strictEqual(retroactive.body.error.code, 'OFF_DAY_DEADLINE_PASSED');
  assert.match(retroactive.body.error.message, /cannot be claimed retroactively/);

  // A future off day is fine and removable while its own deadline is far.
  const future = await app2.post('/off-days', { date: '2026-10-10', reason: 'Travel' });
  assert.strictEqual(future.status, 201);
  assert.strictEqual((await app2.del(`/off-days/${future.body.data.offDay.id}`)).status, 200);

  // Off day appears in calendar history with its own status.
  const cal = await app2.get('/calendar?month=10&year=2026');
  assert.strictEqual(cal.body.history['2026-10-06'].status, 'off');

  await app2.stop();
});

test('timezone change shifts the authoritative date', async (t) => {
  const app3 = await startApp({ now: () => clock.value });
  clock.value = new Date('2026-10-06T03:00:00Z');
  await app3.put('/settings', { timezone: 'Asia/Kolkata' });
  assert.strictEqual((await app3.get('/today')).body.data.todayDate, '2026-10-06'); // 08:30 IST

  const s = await app3.patch('/settings', { timezone: 'Pacific/Honolulu' });
  assert.strictEqual(s.status, 200);
  assert.strictEqual((await app3.get('/today')).body.data.todayDate, '2026-10-05'); // 17:00 HST
  await app3.stop();
});

test('scheduler tick records durable, deduplicated events', async (t) => {
    clock.value = new Date('2026-10-06T17:10:00Z'); // 22:40 IST — accountability phase
  const db = app.db;
  const tick1 = eventService.tick(db, { clock: getClockContext(db, clock.value) });
  assert.strictEqual(tick1.recorded, true);
  eventService.tick(db, { clock: getClockContext(db, clock.value) }); // second tick

  const events = await app.get('/accountability/events?limit=50');
  assert.strictEqual(events.status, 200);
  const rows = events.body.data.events;
  const checks = rows.filter((e) => e.type === 'accountability_check' && e.date === '2026-10-06');
  assert.strictEqual(checks.length, 1, 'events are deduplicated per (type, date)');
  assert.ok(rows.some((e) => e.type === 'day_rolled' && e.date === '2026-10-06'));
});
