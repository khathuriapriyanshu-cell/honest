'use strict';

/**
 * Timezone and date-boundary math.
 *
 * These are unit tests of the utilities that every other rule depends on:
 * what "today" means, what a local wall-clock time maps to in UTC, and how
 * DST transitions are handled. If these are wrong, everything is wrong.
 */

const time = require('../utils/time');
const { Clock } = require('../utils/clock');
const { openDatabase } = require('../database/db');
const { assertTrue, assertEqual, assertThrows } = require('./helpers');

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

function memoryClock(offsetMinutes = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'honest-time-'));
  const file = path.join(dir, 'clock.db');
  const { db } = openDatabase(file);
  const clock = new Clock(db, offsetMinutes);
  return { clock, db, dir };
}

module.exports = function timeTests() {
  return {
    'validates IANA timezones and rejects nonsense': () => {
      assertTrue(time.isValidTimezone('Asia/Kolkata'), 'Asia/Kolkata is a real zone');
      assertTrue(time.isValidTimezone('America/New_York'), 'America/New_York is a real zone');
      assertTrue(time.isValidTimezone('UTC'), 'UTC is a real zone');
      assertEqual(time.isValidTimezone('Mars/Olympus'), false, 'invented zones must be rejected');
      assertEqual(time.isValidTimezone(''), false, 'an empty zone must be rejected');
      assertEqual(time.isValidTimezone(null), false, 'a null zone must be rejected');
    },

    'resolves "auto" to the host timezone': () => {
      assertEqual(time.resolveTimezone('auto'), time.SERVER_TIMEZONE, 'auto follows the host');
      assertEqual(time.resolveTimezone(null), time.SERVER_TIMEZONE, 'a missing setting follows the host');
      assertEqual(time.resolveTimezone('Asia/Kolkata'), 'Asia/Kolkata', 'an explicit zone is honoured');
    },

    'computes the local calendar date from an instant': () => {
      // 2026-03-10T20:00Z is already 2026-03-11 in Kolkata (+05:30).
      const instant = new Date('2026-03-10T20:00:00Z');
      assertEqual(time.dateForInstant(instant, 'Asia/Kolkata'), '2026-03-11', 'Kolkata is ahead of UTC');
      assertEqual(time.dateForInstant(instant, 'UTC'), '2026-03-10', 'UTC stays on the 10th');
      assertEqual(time.dateForInstant(instant, 'America/Los_Angeles'), '2026-03-10', 'Los Angeles is behind UTC');
    },

    'finds local midnight across a forward timezone': () => {
      const instant = time.zonedTimeToUtc('2026-03-11', '00:00', 'Asia/Kolkata');
      assertEqual(instant.toISOString(), '2026-03-10T18:30:00.000Z', 'midnight IST is 18:30 UTC the previous day');
    },

    'honours daylight saving transitions': () => {
      // London: GMT in January (offset 0), BST in July (offset +60).
      assertEqual(
        time.getOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'Europe/London'),
        0,
        'London is UTC in winter'
      );
      assertEqual(
        time.getOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Europe/London'),
        60,
        'London is UTC+1 in summer'
      );

      const winterMidnight = time.zonedTimeToUtc('2026-01-15', '00:00', 'Europe/London');
      assertEqual(winterMidnight.toISOString(), '2026-01-15T00:00:00.000Z', 'winter midnight is 00:00 UTC');
      const summerMidnight = time.zonedTimeToUtc('2026-07-15', '00:00', 'Europe/London');
      assertEqual(summerMidnight.toISOString(), '2026-07-14T23:00:00.000Z', 'summer midnight is 23:00 UTC');
    },

    'handles a DST spring-forward day without producing an invalid date': () => {
      // 2026-03-29 in London: 01:00 jumps to 02:00, so 01:30 does not exist.
      const instant = time.zonedTimeToUtc('2026-03-29', '01:30', 'Europe/London');
      assertEqual(Number.isNaN(instant.getTime()), false, 'a non-existent wall time must still resolve to an instant');
      assertEqual(
        time.dateForInstant(instant, 'Europe/London'),
        '2026-03-29',
        'the resolved instant must still fall on the intended local date'
      );
    },

    'shifts dates across month and year boundaries': () => {
      assertEqual(time.shiftIsoDate('2026-03-01', -1), '2026-02-28', 'backwards over a month boundary');
      assertEqual(time.shiftIsoDate('2026-12-31', 1), '2027-01-01', 'forwards over a year boundary');
      assertEqual(time.shiftIsoDate('2024-02-28', 1), '2024-02-29', 'leap year');
      assertEqual(time.shiftIsoDate('2026-02-28', 1), '2026-03-01', 'non-leap year');
    },

    'maps dates to ISO weekdays (Monday = 1 .. Sunday = 7)': () => {
      assertEqual(time.isoWeekdayFromDate('2026-10-05'), 1, '5 October 2026 is a Monday');
      assertEqual(time.isoWeekdayFromDate('2026-10-11'), 7, '11 October 2026 is a Sunday');
    },

    'counts days in a month correctly': () => {
      assertEqual(time.daysInMonth(2026, 2), 28, 'February 2026');
      assertEqual(time.daysInMonth(2024, 2), 29, 'February 2024 (leap)');
      assertEqual(time.daysInMonth(2026, 10), 31, 'October');
      assertEqual(time.daysInMonth(2026, 4), 30, 'April');
    },

    'validates ISO date strings strictly': () => {
      assertEqual(time.isValidIsoDate('2026-02-30'), false, '30 February does not exist');
      assertEqual(time.isValidIsoDate('2024-02-29'), true, '29 February 2024 exists');
      assertEqual(time.isValidIsoDate('2026-13-01'), false, 'there is no month 13');
      assertEqual(time.isValidIsoDate('05-10-2026'), false, 'day-first formats are rejected');
      assertEqual(time.isValidIsoDate('2026-1-5'), false, 'single digit components are rejected');
    },

    'enumerates inclusive date ranges': () => {
      const range = time.enumerateDates('2026-02-27', '2026-03-02');
      assertEqual(range.length, 4, 'four days across the boundary');
      assertEqual(range[0], '2026-02-27', 'first day');
      assertEqual(range[3], '2026-03-02', 'last day');
    },

    'formats dates the way the frontend contract expects': () => {
      assertEqual(time.formatLongDate('2026-10-05'), 'Monday - 5 October', 'the "Monday - 5 October" header format');
      assertEqual(time.formatArchiveDate('2026-10-03'), 'October 3, 2026', 'the archive date format');
      assertEqual(time.formatMonthLabel(2026, 10), 'October 2026', 'the month label format');
    },

    'clock follows the configured timezone, not the host clock': () => {
      const { clock, db, dir } = memoryClock();
      try {
        // Pin the instant to a known UTC time.
        const targetUtc = Date.UTC(2026, 2, 10, 20, 0, 0); // 2026-03-10T20:00Z
        clock.setOffsetMinutes((targetUtc - Date.now()) / 60000);

        assertEqual(clock.today('UTC'), '2026-03-10', 'UTC still on the 10th');
        assertEqual(clock.today('Asia/Kolkata'), '2026-03-11', 'Kolkata has rolled over to the 11th');
        assertEqual(clock.currentHhmm('UTC'), '20:00', 'UTC wall clock');
        assertEqual(clock.currentHhmm('Asia/Kolkata'), '01:30', 'Kolkata wall clock (next day)');
        assertEqual(clock.minutesSinceMidnight('Asia/Kolkata'), 90, '90 minutes past local midnight');
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    'clock offset is persisted and restored': () => {
      const { clock, db, dir } = memoryClock();
      try {
        clock.setOffsetMinutes(1234);
        assertEqual(clock.offsetMinutes, 1234, 'the offset is applied in memory');
        const reopened = new Clock(db);
        assertEqual(reopened.offsetMinutes, 1234, 'the offset is restored from SQLite');
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },

    'clock refuses an implausible offset': () => {
      const { clock, db, dir } = memoryClock();
      try {
        assertThrows(() => clock.setOffsetMinutes(10_000_000), 'an out-of-range offset must be rejected');
      } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
};
