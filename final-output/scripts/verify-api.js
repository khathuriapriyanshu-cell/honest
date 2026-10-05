'use strict';

/**
 * End-to-end verification against the real HTTP contract used by the frontend.
 *
 *   node scripts/verify-api.js [baseUrl]
 *
 * Unlike the test suite (which runs in-process against a temporary database),
 * this script talks to a *running* server over the network and walks through
 * the exact requests the frontend service layer makes, in the documented order.
 * It prints every response so a human can confirm the contract by eye.
 *
 * It is read-mostly: it creates one promise, completes it, records one reason
 * and then cleans up after itself. Point it at your own server only if you are
 * happy for that data to exist.
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api`;

let failures = 0;

function check(label, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? `  -> ${detail}` : ''}`);
}

async function call(method, route, body) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (err) {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function show(label, value, max = 320) {
  const text = JSON.stringify(value);
  console.log(`      ${label}: ${text.length > max ? `${text.slice(0, max)}…` : text}`);
}

async function main() {
  console.log(`\nHONEST backend contract verification against ${API}\n`);

  // --- availability --------------------------------------------------------
  const health = await call('GET', '/health');
  console.log('GET /api/health', health.status);
  show('body', health.body);
  check('health responds 200', health.status === 200, JSON.stringify(health.body));
  check('database is reachable', health.body.database === 'ok', JSON.stringify(health.body));

  const time = await call('GET', '/time');
  console.log('\nGET /api/time', time.status);
  show('body', time.body);
  check('the backend publishes an authoritative date', typeof time.body.serverDate === 'string');

  // --- create a promise ----------------------------------------------------
  const created = await call('POST', '/tasks', {
    title: 'Contract check promise',
    definition: 'At least 5 minutes of focused attention',
    category: 'Study',
    repeat: 'daily',
    selectedDays: [],
    reminder: null,
    accountabilityTime: '22:30',
  });
  console.log('\nPOST /api/tasks', created.status);
  show('body', created.body);
  check('creating a promise returns 201', created.status === 201, JSON.stringify(created.body));
  check('the response carries a task id', created.body.task && created.body.task.id !== undefined);
  const taskId = created.body.task && created.body.task.id;

  // --- today ---------------------------------------------------------------
  const today = await call('GET', '/today');
  console.log('\nGET /api/today', today.status);
  show('keys', Object.keys(today.body));
  show('date/tasks', {
    isoDate: today.body.isoDate,
    date: today.body.date,
    dateLabel: today.body.dateLabel,
    honestDays: today.body.honestDays,
    isOffDay: today.body.isOffDay,
    hasUnresolvedYesterday: today.body.hasUnresolvedYesterday,
    nightCheckActive: today.body.nightCheckActive,
    counts: today.body.counts,
  });
  check('today matches the server date', today.body.isoDate === time.body.serverDate);
  check('today lists the new promise', (today.body.tasks || []).some((t) => String(t.id) === String(taskId)));
  check(
    'every promise exposes the documented fields',
    (today.body.tasks || []).every(
      (t) => t.id !== undefined && t.title !== undefined && t.completed !== undefined && t.accountabilityTime !== undefined
    )
  );

  // --- completion ----------------------------------------------------------
  const completed = await call('PUT', `/tasks/${taskId}/complete`);
  console.log(`\nPUT /api/tasks/${taskId}/complete`, completed.status);
  show('body', completed.body);
  check('completion returns success', completed.body.success === true);
  check('the promise is reported complete', completed.body.task.completed === true);

  const afterComplete = await call('GET', '/today');
  const completedTask = (afterComplete.body.tasks || []).find((t) => String(t.id) === String(taskId));
  check('the completion is persisted and visible', completedTask && completedTask.completed === true);

  const uncompleted = await call('PUT', `/tasks/${taskId}/uncomplete`);
  console.log(`\nPUT /api/tasks/${taskId}/uncomplete`, uncompleted.status);
  check('undo works on the same day', uncompleted.body.task.completed === false);

  // --- night check and reflection -----------------------------------------
  const night = await call('GET', '/night-check');
  console.log('\nGET /api/night-check', night.status);
  show('body', {
    active: night.body.active,
    accountabilityTime: night.body.accountabilityTime,
    unfinishedCount: night.body.unfinishedCount,
    message: night.body.message,
  });
  check('night check exposes the accountability sentence', typeof night.body.message === 'string');

  const reflect = await call('POST', '/night-check/reflect', {
    reason: 'Contract verification reason - not a real day.',
    taskIds: [taskId],
  });
  console.log('\nPOST /api/night-check/reflect', reflect.status);
  show('body', reflect.body);
  check('reflection is recorded', reflect.body.success === true && reflect.body.remainingUnresolved === 0);
  check('the documented message is returned', reflect.body.message === 'Reason recorded.');

  const afterReflect = await call('GET', '/today');
  const explainedTask = (afterReflect.body.tasks || []).find((t) => String(t.id) === String(taskId));
  check('the promise is now missed-but-explained, not unresolved', explainedTask && explainedTask.state === 'missed_explained');

  // --- history -------------------------------------------------------------
  const d = today.body.isoDate;
  const day = await call('GET', `/calendar/day/${d}`);
  console.log(`\nGET /api/calendar/day/${d}`, day.status);
  show('body', {
    status: day.body.status,
    completed: day.body.completed,
    total: day.body.total,
    explained: day.body.explained,
    unresolved: day.body.unresolved,
    reflection: day.body.reflection,
    tasks: (day.body.tasks || []).map((t) => `${t.title}:${t.completed ? 'done' : 'missed'}`),
  });
  check('day history reports explained, not unresolved', day.body.unresolved === 0 && day.body.explained >= 1);
  check('the reason is attached to the day', typeof day.body.reflection === 'string' && day.body.reflection.length > 0);

  const calendar = await call('GET', `/calendar?month=${Number(d.slice(5, 7))}&year=${Number(d.slice(0, 4))}`);
  console.log('\nGET /api/calendar', calendar.status);
  show('month', calendar.body.month);
  show('summary', calendar.body.summary);
  check('the month map contains today', calendar.body.history && calendar.body.history[d] !== undefined);
  check('the month summary counts real days', calendar.body.summary.honestDays >= 1, JSON.stringify(calendar.body.summary));
  const summarised = ['completedDays', 'explainedDays', 'unresolvedDays', 'activeDays', 'offDays'].reduce(
    (sum, key) => sum + (calendar.body.summary[key] || 0),
    0
  );
  check(
    'the summary adds up to the days in the map',
    summarised === Object.keys(calendar.body.history).length,
    `summary=${summarised} map=${Object.keys(calendar.body.history).length}`
  );

  // --- reports and analytics ----------------------------------------------
  const weekly = await call('GET', '/report/weekly');
  console.log('\nGET /api/report/weekly', weekly.status);
  show('body', weekly.body);
  check('weekly totals are real numbers', typeof weekly.body.totalCount === 'number' && typeof weekly.body.completionRate === 'number');
  check('the insight is backend generated', typeof weekly.body.insight === 'string' && weekly.body.insight.length > 0);

  const score = await call('GET', '/stats/score');
  console.log('\nGET /api/stats/score', score.status);
  show('body', score.body);
  check('the score is a bounded integer', Number.isInteger(score.body.honestyScore) && score.body.honestyScore >= 0 && score.body.honestyScore <= 100);
  const made = score.body.promisesMade;
  const parts = score.body.completed + score.body.missed;
  check('score inputs add up', made === parts, `made=${made} completed+missed=${parts}`);
  check('explained + unexplained equals missed', score.body.explained + score.body.unexplained === score.body.missed);

  const honestDays = await call('GET', '/stats/honest-days');
  console.log('\nGET /api/stats/honest-days', honestDays.status);
  show('body', honestDays.body);
  check('honest days are reported', typeof honestDays.body.current === 'number');

  const archive = await call('GET', '/archive?q=Contract');
  console.log('\nGET /api/archive?q=Contract', archive.status);
  show('body', archive.body);
  check('the archive found the recorded reason', (archive.body.reflections || []).length >= 1);

  const insights = await call('GET', '/insights');
  console.log('\nGET /api/insights', insights.status);
  show('body', insights.body);
  check('insights return an array', Array.isArray(insights.body.patterns));

  const notifications = await call('GET', '/notifications');
  console.log('\nGET /api/notifications', notifications.status);
  show('body', notifications.body);
  check('notifications return an array', Array.isArray(notifications.body.notifications));

  // --- settings ------------------------------------------------------------
  const settings = await call('GET', '/settings');
  console.log('\nGET /api/settings', settings.status);
  show('body', settings.body);
  check(
    'settings expose every documented key',
    ['accountabilityTime', 'dailyReset', 'gracePeriod', 'weekStart', 'notifications', 'theme'].every(
      (key) => settings.body[key] !== undefined
    )
  );

  const updated = await call('PUT', '/settings', { theme: settings.body.theme });
  console.log('\nPUT /api/settings', updated.status);
  check('settings update succeeds', updated.body.success === true);

  // --- error honesty -------------------------------------------------------
  const missing = await call('GET', '/tasks/99999999');
  console.log('\nGET /api/tasks/99999999', missing.status);
  show('body', missing.body);
  check('an unknown promise is a 404 with a code', missing.status === 404 && Boolean(missing.body.error && missing.body.error.code));

  const badTask = await call('POST', '/tasks', { title: '' });
  console.log('\nPOST /api/tasks (empty title)', badTask.status);
  show('body', badTask.body);
  check('invalid input is rejected, not accepted', badTask.status === 400 && badTask.body.success === false);

  // --- clean up ------------------------------------------------------------
  // The promise already has recorded history, so erasing it is refused by
  // design; deactivation is the honest way to retire it.
  const removed = await call('DELETE', `/tasks/${taskId}`);
  console.log(`\nDELETE /api/tasks/${taskId}`, removed.status);
  show('body', removed.body);
  check('a promise with history is deactivated, not erased', removed.body.mode === 'deactivated');

  const erased = await call('DELETE', `/tasks/${taskId}?hard=true`);
  console.log(`\nDELETE /api/tasks/${taskId}?hard=true`, erased.status);
  show('body', erased.body);
  check('erasing recorded history is refused', erased.status === 409, JSON.stringify(erased.body));

  console.log(`\n${failures === 0 ? 'ALL CONTRACT CHECKS PASSED' : `${failures} CONTRACT CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nCould not verify the API at ${API}: ${err.message}`);
  console.error('Is the backend running?  npm start\n');
  process.exitCode = 1;
});
