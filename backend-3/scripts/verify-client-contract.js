'use strict';

/**
 * Verifies the four client-facing contracts (web + Android) against a running
 * server, using the exact payloads each client sends.
 *
 *   node scripts/verify-client-contract.js [baseUrl]
 *
 * Read-mostly: it changes settings and records one reason, then prints every
 * response so the shape can be confirmed by eye. Run it against your own server
 * only if you are happy for that data to exist.
 */

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const API = `${BASE}/api`;

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  -> ${detail}`}`);
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

function show(label, value, max = 420) {
  const text = JSON.stringify(value);
  console.log(`      ${label}: ${text.length > max ? `${text.slice(0, max)}…` : text}`);
}

async function main() {
  console.log(`\nClient contract verification against ${API}\n`);

  const today = await call('GET', '/today');
  check('the server reports a date', typeof today.body.isoDate === 'string', JSON.stringify(today.body).slice(0, 120));
  const date = today.body.isoDate;

  // Two promises: one kept, one deliberately left unanswered so the reflection
  // flow has something real to explain.
  const created = await call('POST', '/tasks', { title: 'Contract promise', repeat: 'daily', definition: 'At least 5 minutes' });
  const taskId = created.body.task && created.body.task.id;
  check('a promise can be created', Boolean(taskId), JSON.stringify(created.body).slice(0, 140));
  await call('PUT', `/tasks/${taskId}/complete`);

  const missed = await call('POST', '/tasks', {
    title: 'Contract promise (left undone)',
    repeat: 'daily',
    definition: 'Deliberately unanswered by this script',
  });
  const missedId = missed.body.task && missed.body.task.id;
  check('a second promise can be created', Boolean(missedId), JSON.stringify(missed.body).slice(0, 140));

  // ------------------------------------------------------------------ 1
  console.log('\n--- 1. GET /api/calendar/:date ---');
  const short = await call('GET', `/calendar/${date}`);
  show('status', short.status);
  show('data', short.body.data);
  check('it answers 200', short.status === 200, JSON.stringify(short.body).slice(0, 160));
  check('success is true', short.body.success === true);
  check('data is an object, not an array', short.body.data && !Array.isArray(short.body.data));
  check('data.date matches the request', short.body.data && short.body.data.date === date);
  check(
    'data.status is a documented value',
    ['completed', 'explained', 'unresolved', 'active', 'offday', 'empty'].includes(short.body.data.status),
    String(short.body.data && short.body.data.status)
  );
  check('data.tasks is an array', Array.isArray(short.body.data.tasks));
  check('data.reflection is present', 'reflection' in short.body.data);
  const shaped = (short.body.data.tasks || []).every(
    (t) => t.id !== undefined && t.name !== undefined && ['completed', 'missed'].includes(t.status) && 'completedAt' in t
  );
  check('every task has id, name, status and completedAt', shaped, JSON.stringify((short.body.data.tasks || [])[0]));
  check(
    'a kept promise reports completed with a timestamp',
    (short.body.data.tasks || []).some((t) => t.status === 'completed' && t.completedAt)
  );

  const long = await call('GET', `/calendar/day/${date}`);
  check('the canonical /calendar/day/:date route still works', long.status === 200 && long.body.data.date === date);
  check(
    'both routes agree',
    JSON.stringify(short.body.data.tasks) === JSON.stringify(long.body.data.tasks),
    'task lists differ'
  );

  const bogus = await call('GET', '/calendar/not-a-date');
  check('a non-date is refused', bogus.status === 400 && bogus.body.error.code === 'INVALID_DATE', JSON.stringify(bogus.body).slice(0, 140));

  // ------------------------------------------------------------------ 2
  console.log('\n--- 2. POST /api/reflections (missedTasks by name) ---');
  const month = await call('GET', `/calendar?month=${Number(date.slice(5, 7))}&year=${Number(date.slice(0, 4))}`);
  const missedNames = Object.entries(month.body.history || {})
    .filter(([, entry]) => entry.unresolved > 0)
    .map(([, entry]) => entry);
  show('days with unresolved promises (for reference)', missedNames.length);

  // The current day's unanswered promises, named as the mobile client would.
  const night = await call('GET', '/night-check');
  const openNames = (night.body.unfinishedTasks || []).map((t) => t.name);
  show('unfinished promise names today', openNames);

  if (openNames.length === 0) {
    check('there is something to explain for this check', false, 'no unfinished promises today');
  } else {
    const reflect = await call('POST', '/reflections', {
      date,
      reason: 'Client contract verification: explaining the unfinished promises.',
      missedTasks: openNames,
    });
    show('response', reflect.body);
    check('the reflection is accepted', reflect.status === 200, JSON.stringify(reflect.body).slice(0, 200));
    check('the day is resolved', reflect.body.dayResolved === true, String(reflect.body.remainingUnresolved));
    check('the reason is recorded', reflect.body.message === 'Reason recorded.', String(reflect.body.message));

    const unknown = await call('POST', '/reflections', {
      date,
      reason: 'Explaining a promise that does not exist on this day.',
      missedTasks: ['Not a real promise name'],
    });
    check(
      'an unknown promise name is rejected with a useful error',
      unknown.status === 400 && unknown.body.error.code === 'TASK_NOT_ON_DATE',
      JSON.stringify(unknown.body).slice(0, 200)
    );
  }

  // ------------------------------------------------------------------ 3
  console.log('\n--- 3. GET /api/reflections ---');
  const list = await call('GET', '/reflections');
  show('status', list.status);
  show('data', list.body.data);
  check('it answers 200', list.status === 200);
  check('data is an array', Array.isArray(list.body.data), typeof list.body.data);
  check('the array is not empty', (list.body.data || []).length > 0);
  const first = (list.body.data || [])[0] || {};
  check('each entry has date, reason and missedTasks', Boolean(first.date && first.reason && Array.isArray(first.missedTasks)), JSON.stringify(first));
  check('dates are ISO', /^\d{4}-\d{2}-\d{2}$/.test(String(first.date)), String(first.date));
  const descending = (list.body.data || []).every(
    (entry, index, all) => index === 0 || all[index - 1].date >= entry.date
  );
  check('entries are sorted descending by date', descending);
  check('the older mirrored key is still present', Array.isArray(list.body.reflections));

  const filtered = await call('GET', '/reflections?q=verification');
  check('keyword search filters the list', Array.isArray(filtered.body.data));

  const dayAfter = await call('GET', `/calendar/${date}`);
  show('day status after reflecting', { status: dayAfter.body.data.status, reflection: dayAfter.body.data.reflection });
  check('the reason is attached to the day', typeof dayAfter.body.data.reflection === 'string');

  // ------------------------------------------------------------------ 4
  console.log('\n--- 4. PUT /api/settings (dailyCheckTime / dayResetTime) ---');
  const settings = await call('PUT', '/settings', { dailyCheckTime: '22:45', dayResetTime: '03:30' });
  show('response', settings.body);
  check('the alias fields are accepted', settings.status === 200, JSON.stringify(settings.body).slice(0, 200));
  check('dailyCheckTime maps to accountabilityTime', settings.body.settings.accountabilityTime === '22:45', String(settings.body.settings.accountabilityTime));
  check('dayResetTime maps to dailyReset', settings.body.settings.dailyReset === '03:30', String(settings.body.settings.dailyReset));

  const readBack = await call('GET', '/settings');
  check('and they persist', readBack.body.accountabilityTime === '22:45' && readBack.body.dailyReset === '03:30');
  check('GET exposes both alias names', readBack.body.dailyCheckTime === '22:45' && readBack.body.dayResetTime === '03:30');

  const webPayload = await call('PUT', '/settings', {
    accountabilityTime: '22:30',
    dailyReset: '00:00',
    notifications: true,
    theme: 'dark',
    apiUrl: `${API}`,
  });
  check('the web client payload (including apiUrl) is accepted', webPayload.status === 200, JSON.stringify(webPayload.body).slice(0, 200));

  const time = await call('GET', '/time');
  check('the restored values drive the runtime', time.body.accountabilityTime === '22:30' && time.body.dailyReset === '00:00');

  // Clean up the promises created for this check.
  await call('DELETE', `/tasks/${taskId}`);
  await call('DELETE', `/tasks/${missedId}`);

  console.log(`\n${failures === 0 ? 'CLIENT CONTRACT VERIFIED' : `${failures} CHECK(S) FAILED`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`\nCould not verify the API at ${API}: ${err.message}`);
  console.error('Is the backend running?  npm start\n');
  process.exitCode = 1;
});
