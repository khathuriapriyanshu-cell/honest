/**
 * HONEST Backend 2 (KBAI) - Timezone & Date Service
 * 
 * The backend is the authoritative source for dates and time logic.
 * Respects configured timezone ('automatic' or specific IANA string).
 */

function resolveTimezone(tzSetting) {
  if (!tzSetting || tzSetting === 'automatic') {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }
  return tzSetting;
}

/**
 * Returns current date object in target timezone
 */
function getNow(timezone) {
  const tz = resolveTimezone(timezone);
  const now = new Date();
  const tzString = now.toLocaleString('en-US', { timeZone: tz });
  return new Date(tzString);
}

/**
 * Returns 'YYYY-MM-DD' for today in target timezone
 */
function getTodayDate(timezone) {
  const now = getNow(timezone);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns 'YYYY-MM-DD' for yesterday in target timezone
 */
function getYesterdayDate(timezone) {
  const now = getNow(timezone);
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns 'HH:MM' string for current time in target timezone
 */
function getCurrentTime(timezone) {
  const now = getNow(timezone);
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Formats date into 'Monday - 5 October' format
 */
function formatDisplayDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  
  const dayName = days[date.getDay()];
  const monthName = months[date.getMonth()];
  
  return `${dayName} - ${day} ${monthName}`;
}

/**
 * Converts 'HH:MM' string to minutes past midnight
 */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return (hours * 60) + minutes;
}

/**
 * Evaluates whether Night Check is active:
 * Night Check activates at accountabilityTime (e.g. 22:30 = 10:30 PM)
 * and continues until dailyReset + gracePeriod (e.g. 00:00 + 15 min).
 */
function isNightCheckActive(accountabilityTime, dailyReset, gracePeriodMinutes, timezone) {
  const currentTimeStr = getCurrentTime(timezone);
  const currentMinutes = parseTimeToMinutes(currentTimeStr);
  const accMinutes = parseTimeToMinutes(accountabilityTime || '22:30');
  const grace = parseInt(gracePeriodMinutes, 10) || 15;

  // Evening window: between accountability time and 23:59
  if (currentMinutes >= accMinutes) {
    return true;
  }
  // Post-midnight grace window: between 00:00 and 00:00 + grace
  if (currentMinutes <= grace) {
    return true;
  }
  return false;
}

/**
 * Evaluates whether an Off Day can still be declared:
 * CRITICAL RULE: An off day cannot be activated retroactively for a past date,
 * nor can it be activated today after the accountability check deadline!
 */
function isOffDayEligible(targetDate, accountabilityTime, timezone) {
  const today = getTodayDate(timezone);
  
  // Retroactive check
  if (targetDate < today) {
    return {
      eligible: false,
      reason: 'An off day can no longer be activated for past dates.'
    };
  }

  // Same day check: cannot activate after accountability time
  if (targetDate === today) {
    const currentTimeStr = getCurrentTime(timezone);
    const currentMinutes = parseTimeToMinutes(currentTimeStr);
    const accMinutes = parseTimeToMinutes(accountabilityTime || '22:30');

    if (currentMinutes >= accMinutes) {
      return {
        eligible: false,
        reason: 'An off day can no longer be activated after the accountability deadline (10:30 PM).'
      };
    }
  }

  return { eligible: true };
}

module.exports = {
  resolveTimezone,
  getNow,
  getTodayDate,
  getYesterdayDate,
  getCurrentTime,
  formatDisplayDate,
  parseTimeToMinutes,
  isNightCheckActive,
  isOffDayEligible
};
