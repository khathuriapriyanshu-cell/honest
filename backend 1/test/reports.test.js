'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startApp, clockAt } = require('./helpers');
const { createApp } = require('../app');

/**
 * Seeded week (2026-10-05 .. 2026-10-11, Monday-start week, timezone UTC,
 * "today" = Sunday 2026-10-11 12:00 UTC):
 *
 *   Coding   daily            completed all 7 days              -> 7/7
 *   Workout  Tue+Thu (2,4)    completed Tue, missed+explained Thu
 *   Reading  daily            completed 5, missed Wed (explained), Fri (unexplained)
 *
 * Expected weekly: promised 16, completed 13, missed 3 (explained 2, unexplained 1),
 * completionRate 0.8125, mostConsistent Coding, mostSkipped Workout,
 * common reason "Too tired after college." x2.
 */
const clock = clockAt('2026-10-11T12:00:00Z');
let app;
let ids;

function seedTask(db, { name, category = 'general', repeatType, selectedDays = null, startDate = '2026-10-05' }) {
  const nowIso = '2026-10-05T08:00:00.000Z';
  const daysJson = selectedDays ? JSON.stringify(selectedDays) : null;
  const r = db.run(
    'INSERT INTO tasks (name, category, repeat_type, selected_days, is_active, created_at, updated_at) VALUES (?,?,?,?,1,?,?)',
    name,
    category,
    repeatType,
    daysJson,
    nowIso,
    nowIso
  );
  db.run(
    'INSERT INTO task_schedules (task_id, repeat_type, selected_days, start_date, end_date, created_at) VALUES (?,?,?,?,NULL,?)',
    r.lastInsertRowid,
    repeatType,
    daysJson,
    startDate,
    nowIso
  );
  return r.lastInsertRowid;
}

function seedCompletion(db, taskId, date) {
  db.run(
    'INSERT INTO completions (task_id, date, completed_at) VALUES (?,?,?)',
    taskId,
    date,
    `${date}T18:00:00.000Z`
  );
}

function seedReflection(db, date, taskId, reason) {
  db.run(
    'INSERT INTO reflections (date, task_id, reason, created_at, updated_at) VALUES (?,?,?,?,?)',
    date,
    taskId,
    reason,
    `${date}T23:00:00.000Z`,
    `${date}T23:00:00.000Z`
  );
}

async function seedWeek() {
  const app = await startApp({ now: () => clock.value });
  await app.put('/settings', { timezone: 'UTC' });
  const db = app.db;

  const coding = seedTask(db, { name: 'Coding', category: 'DSA', repeatType: 'daily' });
  const workout = seedTask(db, { name: 'Workout', repeatType: 'selected_days', selectedDays: [2, 4] });
  const reading = seedTask(db, { name: 'Reading', repeatType: 'daily' });

  for (const d of ['05', '06', '07', '08', '09', '10', '11']) seedCompletion(db, coding, `2026-10-${d}`);
  seedCompletion(db, workout, '2026-10-06'); // Tue
  seedReflection(db, '2026-10-08', workout, 'Too tired after college.'); // Thu miss explained
  for (const d of ['05', '06', '08', '10', '11']) seedCompletion(db, reading, `2026-10-${d}`);
  seedReflection(db, '2026-10-07', reading, 'Too tired after college.'); // Wed miss explained
  // Fri (Oct 9) reading miss stays UNEXPLAINED; a day-level note does not excuse it.
  seedReflection(db, '2026-10-09', null, 'Long day at college.');
  // Off day before any promises existed (activated on time).
  db.run(
    "INSERT INTO off_days (date, reason, note, activated_at) VALUES ('2026-10-04','Sick',NULL,'2026-10-04T10:00:00.000Z')"
  );

  return { app, ids: { coding, workout, reading } };
}

test.before(async () => {
  const seeded = await seedWeek();
  app = seeded.app;
  ids = seeded.ids;
});

test.after(async () => {
  await app.stop();
});

test('calendar month history uses real per-day statuses', async (t) => {
    const cal = await app.get('/calendar?month=10&year=2026');
  assert.strictEqual(cal.status, 200);
  assert.strictEqual(cal.body.month, 'October 2026');
  const h = cal.body.history;

  assert.strictEqual(h['2026-10-01'].status, 'none'); // before tasks existed
  assert.strictEqual(h['2026-10-04'].status, 'off');
  assert.strictEqual(h['2026-10-05'].status, 'completed');
  assert.deepStrictEqual([h['2026-10-05'].completed, h['2026-10-05'].total], [2, 2]);
  assert.strictEqual(h['2026-10-07'].status, 'explained');
  assert.strictEqual(h['2026-10-07'].reflection, 'Too tired after college.');
  assert.strictEqual(h['2026-10-08'].status, 'explained');
  assert.strictEqual(h['2026-10-09'].status, 'unresolved'); // unexplained miss
  assert.strictEqual(h['2026-10-11'].status, 'completed'); // today, everything done so far
  assert.strictEqual(h['2026-10-12'].status, 'future');

  const range = await app.get('/calendar?from=2026-10-05&to=2026-10-09');
  assert.strictEqual(range.body.data.days.length, 5);
  assert.strictEqual(range.body.data.days[4].status, 'red');

  const bad = await app.get('/calendar?from=2026-10-09&to=2026-10-05');
  assert.strictEqual(bad.status, 400);
});

test('calendar day detail lists every promise with its state', async (t) => {
    const day = await app.get('/calendar/day/2026-10-08');
  assert.strictEqual(day.status, 200);
  assert.strictEqual(day.body.completed, 2);
  assert.strictEqual(day.body.total, 3);
  assert.strictEqual(day.body.status, 'explained');
  const workout = day.body.tasks.find((x) => x.title === 'Workout');
  assert.strictEqual(workout.completed, false);
  assert.strictEqual(workout.reflection, 'Too tired after college.');
  assert.strictEqual(day.body.reflection, 'Too tired after college.');

  const day9 = await app.get('/calendar/day/2026-10-09');
  assert.strictEqual(day9.body.status, 'unresolved');
});

test('weekly report: every number derived from the seeded data', async (t) => {
    const report = await app.get('/report/weekly'); // frontend alias endpoint
  assert.strictEqual(report.status, 200);

  assert.strictEqual(report.body.completedCount, 13);
  assert.strictEqual(report.body.totalCount, 16);
  assert.strictEqual(report.body.completionRate, 81.3);
  assert.strictEqual(report.body.mostConsistent, 'Coding (100%)');
  assert.strictEqual(report.body.mostSkipped, 'Workout (50%)');
  assert.strictEqual(report.body.commonReason, 'Too tired after college.');
  assert.strictEqual(typeof report.body.insight, 'string');

  const canonical = await app.get('/reports/weekly');
  const totals = canonical.body.data.totals;
  assert.deepStrictEqual(totals, {
    promised: 16,
    completed: 13,
    missed: 3,
    explained: 2,
    unexplained: 1,
    honestDays: 6,
    completionRate: 0.8125,
  });
  assert.strictEqual(canonical.body.data.week.start, '2026-10-05');
  assert.strictEqual(canonical.body.data.week.end, '2026-10-11');
  assert.strictEqual(canonical.body.data.mostConsistent.name, 'Coding');
  assert.strictEqual(canonical.body.data.mostSkipped.name, 'Workout');
  assert.strictEqual(canonical.body.data.mostCommonReason.count, 2);

  // Deterministic: same input, same output.
  const again = await app.get('/reports/weekly');
  assert.deepStrictEqual(again.body.data.totals, totals);
});

test('honest score is deterministic and documented', async (t) => {
    const score = await app.get('/honesty/score?window=month');
  // Closed days Oct 5-10: 14 promised, 11 completed, 3 missed (2 explained),
  // 6 countable days, 5 honest days ->
  // round(100*(0.5*11/14 + 0.3*2/3 + 0.2*5/6)) = round(75.95) = 76
  assert.strictEqual(score.body.data.score, 76);
  assert.deepStrictEqual(score.body.data.breakdown, {
    promisesMade: 14,
    completed: 11,
    missed: 3,
    explained: 2,
    unexplained: 1,
    countableDays: 6,
    honestDays: 5,
    completionRate: 0.7857,
    explanationRate: 0.6667,
    consistencyRate: 0.8333,
  });
  assert.strictEqual(score.body.data.formula, score.body.data.formula); // stable string
  assert.ok(score.body.data.formula.includes('completionRate'));

  const flat = await app.get('/stats/score');
  assert.strictEqual(flat.body.honestyScore, 76);
  assert.strictEqual(flat.body.month, 'October 2026');
  assert.strictEqual(flat.body.promisesMade, 14);
  assert.strictEqual(flat.body.unexplained, 1);

  const w30 = await app.get('/honesty/score?window=30d');
  assert.strictEqual(w30.body.data.score, 76); // all data is within 30 days
});

test('honest days: current streak, best streak, monthly tally', async (t) => {
    const days = await app.get('/honesty/days');
  // Oct 11 green (today), Oct 10 green, Oct 9 red -> current = 2.
  assert.strictEqual(days.body.data.current, 2);
  // Best run: Oct 5-8 (green, green, yellow, yellow) = 4.
  assert.strictEqual(days.body.data.best, 4);
  assert.strictEqual(days.body.data.today, 'green_so_far');
  assert.deepStrictEqual(days.body.data.monthly, {
    month: '2026-10',
    honestDays: 6,
    greenDays: 4,
    yellowDays: 2,
    offDays: 1,
    redDays: 1,
    noPromiseDays: 3, // Oct 1-3, before the first promise existed
  });
  const history = days.body.data.history;
  assert.strictEqual(history.length, 11); // Oct 1..11
  assert.strictEqual(history.find((x) => x.date === '2026-10-09').honest, false);
  assert.strictEqual(history.find((x) => x.date === '2026-10-08').honest, true);
});

test('insights and archive are computed from real history', async (t) => {
    const insights = await app.get('/insights');
  assert.strictEqual(insights.status, 200);
  assert.ok(Array.isArray(insights.body.patterns));
  assert.ok(insights.body.patterns.some((p) => p.content.includes('Reading')), 'most-skipped insight');

  const archive = await app.get('/archive?q=tired');
  assert.strictEqual(archive.status, 200);
  assert.strictEqual(archive.body.reflections.length, 2);
  assert.ok(archive.body.patternNotice.includes('Too tired after college.'));

  const all = await app.get('/archive');
  assert.strictEqual(all.body.reflections.length, 3); // two task + one day-level
});

test('schedule edits never rewrite history', async (t) => {
  // Coding was completed today (Oct 11) under the old daily rule; the record
  // and the occurrence must survive a same-day schedule change.
  const todayBefore = await app.get('/today');
  assert.strictEqual(todayBefore.body.data.tasks.find((x) => x.taskId === ids.coding).status, 'completed');

  // Change Coding from daily to Mondays-only, effective today (Oct 11, Sunday).
  const res = await app.patch(`/tasks/${ids.coding}`, { repeatType: 'selected_days', selectedDays: [1] });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.data.task.schedules.length, 2); // closed daily row + new rule

  // History: Coding still appears completed on Oct 6 (old schedule + completion).
  const oct6 = await app.get('/calendar/day/2026-10-06');
  assert.strictEqual(oct6.body.tasks.find((x) => x.title === 'Coding').completed, true);

  // Today's promise already existed, so it still shows (completed).
  const today = await app.get('/today');
  assert.strictEqual(today.body.data.tasks.find((x) => x.taskId === ids.coding).status, 'completed');

  // Under the new rule Coding runs Mondays only: next Tuesday it is absent.
  clock.value = new Date('2026-10-13T12:00:00Z'); // Tuesday
  const tue = await app.get('/today');
  assert.ok(!tue.body.data.tasks.some((x) => x.taskId === ids.coding));
  clock.value = new Date('2026-10-11T12:00:00Z'); // restore

  // The past week's report is unchanged: 16 promised, 13 completed.
  const report = await app.get('/reports/weekly');
  assert.strictEqual(report.body.data.totals.promised, 16);
  assert.strictEqual(report.body.data.totals.completed, 13);
});

test('persistence: data survives a full server restart', async (t) => {
  const dbFile = app.dbFile;
  const before = await app.get('/tasks');
  assert.ok(before.body.data.tasks.length >= 3);

  await app.disconnect(); // closes server + sqlite handle, KEEPS the db file

  const app2 = createApp({ dbPath: dbFile, now: () => clock.value });
  const server = app2.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const res = await fetch(`${base}/tasks`);
  const body = await res.json();
  assert.strictEqual(body.data.tasks.length, before.body.data.tasks.length);

  const day = await fetch(`${base}/calendar/day/2026-10-07`);
  const dayBody = await day.json();
  assert.strictEqual(dayBody.data.status, 'yellow'); // history intact

  const score = await fetch(`${base}/stats/score`);
  const scoreBody = await score.json();
  assert.strictEqual(scoreBody.honestyScore, 76);

  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  app2.locals.db.close();
});

test('empty states: a fresh database reports honest empties, not fabrications', async () => {
  const fresh = await startApp({ now: () => new Date('2026-10-11T12:00:00Z') });
  await fresh.put('/settings', { timezone: 'UTC' });

  const score = await fresh.get('/honesty/score');
  assert.strictEqual(score.body.data.score, null); // no data -> no score
  assert.strictEqual(score.body.data.breakdown.promisesMade, 0);

  const weekly = await fresh.get('/report/weekly');
  assert.strictEqual(weekly.body.completedCount, 0);
  assert.strictEqual(weekly.body.totalCount, 0);
  assert.strictEqual(weekly.body.completionRate, null);
  assert.strictEqual(weekly.body.mostConsistent, null);
  assert.strictEqual(weekly.body.mostSkipped, null);
  assert.strictEqual(weekly.body.commonReason, null);
  assert.strictEqual(weekly.body.insight, null);

  const days = await fresh.get('/honesty/days');
  assert.strictEqual(days.body.data.current, 0);
  assert.strictEqual(days.body.data.best, 0);

  const today = await fresh.get('/today');
  assert.strictEqual(today.body.data.counts.promised, 0);
  assert.strictEqual(today.body.data.canStartToday, true);
  assert.strictEqual(today.body.data.messages.phase.title, 'A clean slate.');

  const insights = await fresh.get('/insights');
  assert.deepStrictEqual(insights.body.patterns, []);

  const archive = await fresh.get('/archive');
  assert.strictEqual(archive.body.patternNotice, null);
  assert.deepStrictEqual(archive.body.reflections, []);

  const cal = await fresh.get('/calendar?month=10&year=2026');
  assert.strictEqual(cal.body.history['2026-10-05'].status, 'none');

  await fresh.stop();
});
