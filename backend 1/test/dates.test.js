'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  addDays,
  diffDays,
  weekdayOf,
  isValidDateString,
  parseTimeToMinutes,
  localDateInTz,
  localMinutesInTz,
  zonedTimeToInstant,
  accountabilityDate,
  formatHHMM,
  isValidTimeZone,
} = require('../utils/dates');

test('calendar math: addDays / diffDays / weekdayOf', () => {
  assert.strictEqual(addDays('2026-10-31', 1), '2026-11-01');
  assert.strictEqual(addDays('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(addDays('2028-02-28', 1), '2028-02-29'); // leap year
  assert.strictEqual(diffDays('2026-10-01', '2026-10-31'), 30);
  assert.strictEqual(diffDays('2026-10-05', '2026-10-05'), 0);
  assert.strictEqual(weekdayOf('2026-10-05'), 1); // Monday
  assert.strictEqual(weekdayOf('2026-10-11'), 0); // Sunday
});

test('date validation rejects impossible and malformed dates', () => {
  assert.strictEqual(isValidDateString('2026-10-05'), true);
  assert.strictEqual(isValidDateString('2024-02-29'), true);
  assert.strictEqual(isValidDateString('2026-02-29'), false); // not a leap year
  assert.strictEqual(isValidDateString('2026-13-01'), false);
  assert.strictEqual(isValidDateString('2026-10-32'), false);
  assert.strictEqual(isValidDateString('26-10-05'), false);
  assert.strictEqual(isValidDateString('2026-10-5'), false);
  assert.strictEqual(isValidDateString('2026/10/05'), false);
  assert.strictEqual(isValidDateString(101), false);
});

test('time parsing (HH:MM 24h)', () => {
  assert.strictEqual(parseTimeToMinutes('22:30'), 1350);
  assert.strictEqual(parseTimeToMinutes('07:05'), 425);
  assert.strictEqual(parseTimeToMinutes('00:00'), 0);
  assert.strictEqual(parseTimeToMinutes('23:59'), 1439);
  assert.strictEqual(parseTimeToMinutes('24:00'), null);
  assert.strictEqual(parseTimeToMinutes('7:5'), null);
  assert.strictEqual(parseTimeToMinutes('banana'), null);
  assert.strictEqual(formatHHMM(1350), '22:30');
  assert.strictEqual(formatHHMM(0), '00:00');
});

test('timezone validation', () => {
  assert.strictEqual(isValidTimeZone('Asia/Kolkata'), true);
  assert.strictEqual(isValidTimeZone('America/New_York'), true);
  assert.strictEqual(isValidTimeZone('Mars/Olympus'), false);
  assert.strictEqual(isValidTimeZone(''), false);
});

test('local date conversion honors the timezone', () => {
  const instant = new Date('2026-10-05T20:00:00Z');
  assert.strictEqual(localDateInTz(instant, 'UTC'), '2026-10-05');
  assert.strictEqual(localDateInTz(instant, 'Asia/Kolkata'), '2026-10-06'); // 01:30 next day
  assert.strictEqual(localDateInTz(instant, 'Pacific/Honolulu'), '2026-10-05'); // 10:00 same day
  assert.strictEqual(localMinutesInTz(instant, 'Asia/Kolkata'), 90); // 01:30
});

test('zonedTimeToInstant round-trips across timezones and DST boundaries', () => {
  const zones = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Pacific/Honolulu'];
  const dates = ['2026-10-05', '2026-11-01', '2026-03-08', '2026-06-15'];
  const minutes = [0, 600, 1350, 1439];
  for (const tz of zones) {
    for (const d of dates) {
      for (const m of minutes) {
        const instant = zonedTimeToInstant(d, m, tz);
        assert.strictEqual(localDateInTz(instant, tz), d, `${tz} ${d} ${m}`);
      }
    }
  }
  // Wall-clock minutes round-trip on a regular (non-transition) date.
  for (const m of [0, 600, 1350]) {
    const instant = zonedTimeToInstant('2026-10-05', m, 'America/New_York');
    assert.strictEqual(localMinutesInTz(instant, 'America/New_York'), m);
  }
});

test('accountability date rolls at the configured reset time', () => {
  const lateNight = new Date('2026-10-06T03:00:00Z');
  // UTC, reset at midnight: the calendar date IS the accountability date.
  assert.strictEqual(accountabilityDate(lateNight, 'UTC', 0), '2026-10-06');
  // Reset at 04:00: 03:00 still belongs to the previous accountability day.
  assert.strictEqual(accountabilityDate(lateNight, 'UTC', 240), '2026-10-05');
  const afterReset = new Date('2026-10-06T05:00:00Z');
  assert.strictEqual(accountabilityDate(afterReset, 'UTC', 240), '2026-10-06');
});
