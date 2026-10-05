'use strict';

/**
 * Clock abstraction.
 *
 * All services read "now" through a Clock instance instead of calling
 * `new Date()` directly. That gives:
 *   - one authoritative definition of the current instant;
 *   - an optional manual offset, used by the test harness to simulate the
 *     midnight rollover, grace-period expiry and accountability windows
 *     without waiting for real wall-clock time.
 *
 * The offset is persisted in SQLite, so a shifted clock survives a restart.
 */

const { getZonedParts } = require('./time');

const MAX_OFFSET_MINUTES = 60 * 24 * 400; // 400 days forward or backward

class Clock {
  constructor(db, baseOffsetMinutes = 0) {
    this.db = db;
    this._offset = 0;
    if (db) {
      const row = db
        .prepare("SELECT value FROM meta WHERE key = 'clock_offset_minutes'")
        .get();
      if (row) {
        const parsed = Number(row.value);
        if (Number.isFinite(parsed) && Math.abs(parsed) <= MAX_OFFSET_MINUTES) {
          this._offset = parsed;
        }
      }
    }
    if (baseOffsetMinutes) {
      this._offset = Number(baseOffsetMinutes);
    }
  }

  /** Current instant, including any test offset. */
  now() {
    return new Date(Date.now() + this._offset * 60000);
  }

  nowIso() {
    return this.now().toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  /** Wall-clock parts of "now" in the given timezone. */
  parts(zone) {
    return getZonedParts(this.now(), zone);
  }

  /** Current calendar date in the given timezone. */
  today(zone) {
    return this.parts(zone).isoDate;
  }

  currentHhmm(zone) {
    return this.parts(zone).hhmm;
  }

  /** Minutes elapsed since local midnight (0..1439). */
  minutesSinceMidnight(zone) {
    const parts = this.parts(zone);
    return parts.hour * 60 + parts.minute;
  }

  get offsetMinutes() {
    return this._offset;
  }

  /**
   * Sets the offset and persists it (used by tests / manual time travel).
   *
   * The offset keeps sub-minute precision: the test harness pins an exact
   * instant, and rounding to whole minutes would make every subsequent
   * wall-clock calculation drift by up to 59 seconds.
   */
  setOffsetMinutes(minutes) {
    const value = Number(minutes) || 0;
    if (!Number.isFinite(value) || Math.abs(value) > MAX_OFFSET_MINUTES) {
      throw new Error(`Clock offset out of range (max ${MAX_OFFSET_MINUTES} minutes).`);
    }
    this._offset = value;
    if (this.db) {
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES ('clock_offset_minutes', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        )
        .run(String(value));
    }
    return this._offset;
  }

  /** Advances the clock by a number of minutes (can be negative). */
  advanceMinutes(minutes) {
    return this.setOffsetMinutes(this._offset + (Number(minutes) || 0));
  }

  /** Jumps forward to the next occurrence of a local wall-clock time. */
  advanceToNextHhmm(zone, hhmm) {
    const parts = this.parts(zone);
    const [hh, mm] = String(hhmm).split(':').map(Number);
    const target = hh * 60 + mm;
    const current = parts.hour * 60 + parts.minute;
    let delta = target - current;
    if (delta <= 0) delta += 1440;
    return this.advanceMinutes(delta);
  }
}

module.exports = { Clock, MAX_OFFSET_MINUTES };
