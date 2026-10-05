/**
 * HONEST Backend 2 (KBAI) - Core Accountability & Business Logic Engine
 * 
 * Strict Philosophy:
 * - "The app is a mirror, not a bully."
 * - Zero fake/hallucinated data.
 * - Deterministic Honest Score & Honest Days calculations.
 * - SQLite persistent source of truth.
 */

const { getDatabase } = require('../database');
const timeService = require('./timeService');
const crypto = require('node:crypto');

function getSettings() {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    if (row.key === 'gracePeriod') settings[row.key] = parseInt(row.value, 10);
    else if (row.key === 'notifications') settings[row.key] = row.value === 'true';
    else settings[row.key] = row.value;
  }
  return settings;
}

function updateSettings(newSettings) {
  const db = getDatabase();
  const updateStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  
  for (const [key, value] of Object.entries(newSettings)) {
    updateStmt.run(key, String(value));
  }
  return getSettings();
}

/**
 * Returns tasks applicable to a given date
 */
function getTasksForDate(targetDate, timezone) {
  const db = getDatabase();
  const [year, month, day] = targetDate.split('-').map(Number);
  const targetDateObj = new Date(year, month - 1, day);
  const dayOfWeek = targetDateObj.getDay(); // 0 is Sunday, 1 is Monday...

  // Fetch active tasks created on or before targetDate
  const tasks = db.prepare(`
    SELECT * FROM tasks 
    WHERE created_date <= ? AND (is_active = 1 OR id IN (SELECT task_id FROM task_completions WHERE date = ?))
    ORDER BY created_at ASC
  `).all(targetDate, targetDate);

  // Filter tasks by recurrence rules
  const applicableTasks = tasks.filter(task => {
    if (task.repeat_type === 'once') {
      return task.created_date === targetDate;
    }
    if (task.repeat_type === 'daily') {
      return true;
    }
    if (task.repeat_type === 'selected') {
      if (!task.selected_days) return false;
      try {
        const days = JSON.parse(task.selected_days);
        return days.includes(dayOfWeek);
      } catch (_) {
        return false;
      }
    }
    return false;
  });

  // Attach completion states
  const compStmt = db.prepare('SELECT completed FROM task_completions WHERE task_id = ? AND date = ?');

  return applicableTasks.map(task => {
    const comp = compStmt.get(task.id, targetDate);
    const completed = comp ? Boolean(comp.completed) : false;
    return {
      id: task.id,
      title: task.title,
      definition: task.minimum_completion_definition,
      category: task.category,
      repeat: task.repeat_type,
      selectedDays: task.selected_days ? JSON.parse(task.selected_days) : null,
      reminder: task.reminder_time,
      accountabilityTime: task.accountability_time,
      completed
    };
  });
}

/**
 * Creates a promise/task
 */
function createTask(data, timezone) {
  const db = getDatabase();
  const id = 'task_' + crypto.randomBytes(6).toString('hex');
  const now = new Date();
  const createdDate = timeService.getTodayDate(timezone);

  const stmt = db.prepare(`
    INSERT INTO tasks (
      id, title, category, repeat_type, selected_days, reminder_time,
      accountability_time, minimum_completion_definition, created_date, created_at, is_active
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const selectedDaysJson = Array.isArray(data.selectedDays) ? JSON.stringify(data.selectedDays) : null;

  stmt.run(
    id,
    data.title,
    data.category || 'Personal',
    data.repeat || 'once',
    selectedDaysJson,
    data.reminder || null,
    data.accountabilityTime || '22:30',
    data.definition || 'Complete as intended',
    createdDate,
    now.toISOString()
  );

  return {
    id,
    title: data.title,
    definition: data.definition || 'Complete as intended',
    category: data.category || 'Personal',
    repeat: data.repeat || 'once',
    selectedDays: data.selectedDays || null,
    reminder: data.reminder || null,
    accountabilityTime: data.accountabilityTime || '22:30',
    completed: false
  };
}

/**
 * Toggles task completion for a date
 */
function setTaskCompletion(taskId, dateStr, completed) {
  const db = getDatabase();
  const existing = db.prepare('SELECT id FROM task_completions WHERE task_id = ? AND date = ?').get(taskId, dateStr);
  const nowIso = new Date().toISOString();

  if (existing) {
    db.prepare('UPDATE task_completions SET completed = ?, completed_at = ? WHERE task_id = ? AND date = ?')
      .run(completed ? 1 : 0, nowIso, taskId, dateStr);
  } else {
    const id = 'comp_' + crypto.randomBytes(6).toString('hex');
    db.prepare('INSERT INTO task_completions (id, task_id, date, completed, completed_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, taskId, dateStr, completed ? 1 : 0, nowIso);
  }

  return { success: true, taskId, completed };
}

/**
 * Deletes or deactivates a task
 */
function deleteTask(taskId) {
  const db = getDatabase();
  // Check if task has historical completions
  const history = db.prepare('SELECT COUNT(*) as count FROM task_completions WHERE task_id = ?').get(taskId);
  if (history && history.count > 0) {
    // Preserve historical integrity: soft delete
    db.prepare('UPDATE tasks SET is_active = 0 WHERE id = ?').run(taskId);
  } else {
    // Hard delete
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
  }
  return { success: true };
}

/**
 * Checks if a specific date was an Off Day
 */
function getOffDay(dateStr) {
  const db = getDatabase();
  return db.prepare('SELECT reason, declared_at FROM off_days WHERE date = ?').get(dateStr);
}

/**
 * Declares an Off Day (with strict deadline enforcement)
 */
function declareOffDay(reason, timezone) {
  const settings = getSettings();
  const today = timeService.getTodayDate(timezone);
  const eligibility = timeService.isOffDayEligible(today, settings.accountabilityTime, timezone);

  if (!eligibility.eligible) {
    const err = new Error(eligibility.reason);
    err.status = 400;
    throw err;
  }

  const db = getDatabase();
  const id = 'off_' + crypto.randomBytes(6).toString('hex');
  const nowIso = new Date().toISOString();

  db.prepare('INSERT OR REPLACE INTO off_days (id, date, reason, declared_at) VALUES (?, ?, ?, ?)')
    .run(id, today, reason, nowIso);

  return { success: true, date: today, reason };
}

/**
 * Submits an honest reflection for missed commitments
 */
function submitReflection(reason, taskName, targetDate) {
  const db = getDatabase();
  const id = 'ref_' + crypto.randomBytes(6).toString('hex');
  const nowIso = new Date().toISOString();

  db.prepare('INSERT INTO reflections (id, date, task_name, reason, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, targetDate, taskName || 'Unfinished Promises', reason, nowIso);

  return { success: true, message: 'Reason recorded.' };
}

/**
 * Computes Honest Days count (consecutive fulfilled or honestly explained days)
 */
function calculateHonestDays(timezone) {
  const db = getDatabase();
  const settings = getSettings();
  const today = timeService.getTodayDate(timezone);
  
  // Collect all distinct dates with activity
  const dates = db.prepare(`
    SELECT DISTINCT date FROM task_completions
    UNION
    SELECT DISTINCT created_date as date FROM tasks
    UNION
    SELECT DISTINCT date FROM off_days
    ORDER BY date DESC
  `).all().map(r => r.date).filter(d => d < today); // evaluate past days only

  let count = 0;
  for (const dateStr of dates) {
    const offDay = db.prepare('SELECT id FROM off_days WHERE date = ?').get(dateStr);
    if (offDay) {
      count++;
      continue;
    }

    const tasks = getTasksForDate(dateStr, timezone);
    if (tasks.length === 0) continue;

    const incomplete = tasks.filter(t => !t.completed);
    if (incomplete.length === 0) {
      count++;
    } else {
      const reflection = db.prepare('SELECT id FROM reflections WHERE date = ?').get(dateStr);
      if (reflection) {
        count++;
      } else {
        // Break on first unexplained day
        break;
      }
    }
  }

  // Include today if all tasks are complete
  const todayTasks = getTasksForDate(today, timezone);
  if (todayTasks.length > 0 && todayTasks.every(t => t.completed)) {
    count++;
  }

  return count;
}

/**
 * Resolves full state for Today view
 */
function getTodayState(timezone) {
  const settings = getSettings();
  const todayDate = timeService.getTodayDate(timezone);
  const yesterdayDate = timeService.getYesterdayDate(timezone);
  const db = getDatabase();

  const offDayRecord = getOffDay(todayDate);
  const isOffDay = Boolean(offDayRecord);
  const offDayReason = offDayRecord ? offDayRecord.reason : null;

  const tasks = getTasksForDate(todayDate, timezone);
  const incompleteCount = tasks.filter(t => !t.completed).length;

  const nightCheckActive = timeService.isNightCheckActive(
    settings.accountabilityTime,
    settings.dailyReset,
    settings.gracePeriod,
    timezone
  ) && incompleteCount > 0;

  // Unresolved yesterday evaluation:
  // Did yesterday have incomplete tasks without a recorded reflection?
  const yesterdayTasks = getTasksForDate(yesterdayDate, timezone);
  const yesterdayIncomplete = yesterdayTasks.filter(t => !t.completed);
  const yesterdayReflection = db.prepare('SELECT id FROM reflections WHERE date = ?').get(yesterdayDate);
  const yesterdayOffDay = getOffDay(yesterdayDate);

  const hasUnresolvedYesterday = (
    !yesterdayOffDay && 
    yesterdayIncomplete.length > 0 && 
    !yesterdayReflection
  );

  const honestDays = calculateHonestDays(timezone);

  return {
    date: timeService.formatDisplayDate(todayDate),
    isoDate: todayDate,
    honestDays,
    isOffDay,
    offDayReason,
    nightCheckActive,
    hasUnresolvedYesterday,
    tasks
  };
}

/**
 * Resolves calendar history for month and year
 */
function getCalendarMonth(month, year, timezone) {
  const db = getDatabase();
  const today = timeService.getTodayDate(timezone);
  const mStr = String(month).padStart(2, '0');
  const daysInMonth = new Date(year, month, 0).getDate();
  const history = {};

  for (let day = 1; day <= daysInMonth; day++) {
    const dStr = String(day).padStart(2, '0');
    const dateStr = `${year}-${mStr}-${dStr}`;

    const offDay = db.prepare('SELECT id FROM off_days WHERE date = ?').get(dateStr);
    if (offDay) {
      history[dateStr] = { status: 'offday' };
      continue;
    }

    const tasks = getTasksForDate(dateStr, timezone);
    if (tasks.length === 0) continue;

    const completed = tasks.filter(t => t.completed).length;
    const total = tasks.length;
    const reflection = db.prepare('SELECT reason FROM reflections WHERE date = ?').get(dateStr);

    let status = 'unresolved';
    if (completed === total) {
      status = 'completed';
    } else if (reflection) {
      status = 'explained';
    } else if (dateStr === today) {
      status = 'active';
    }

    history[dateStr] = {
      status,
      completed,
      total,
      reflection: reflection ? reflection.reason : null
    };
  }

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return {
    month: `${months[month - 1]} ${year}`,
    history
  };
}

/**
 * Returns detail for a specific calendar day
 */
function getCalendarDayDetail(dateStr, timezone) {
  const db = getDatabase();
  const tasks = getTasksForDate(dateStr, timezone);
  const completedCount = tasks.filter(t => t.completed).length;
  const reflection = db.prepare('SELECT reason FROM reflections WHERE date = ?').get(dateStr);

  return {
    date: dateStr,
    completed: completedCount,
    total: tasks.length,
    tasks: tasks.map(t => ({ title: t.title, completed: t.completed })),
    reflection: reflection ? reflection.reason : null
  };
}

/**
 * Calculates 7-day Weekly Honesty Report from real SQLite records
 */
function getWeeklyReport(timezone) {
  const db = getDatabase();
  const today = timeService.getTodayDate(timezone);
  const now = timeService.getNow(timezone);

  let totalCount = 0;
  let completedCount = 0;
  let missedCount = 0;
  const categoryStats = {};
  const missedTasksMap = {};

  // Analyze past 7 days
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    const tasks = getTasksForDate(dateStr, timezone);
    for (const t of tasks) {
      totalCount++;
      if (!categoryStats[t.category]) {
        categoryStats[t.category] = { total: 0, completed: 0 };
      }
      categoryStats[t.category].total++;

      if (t.completed) {
        completedCount++;
        categoryStats[t.category].completed++;
      } else {
        missedCount++;
        missedTasksMap[t.title] = (missedTasksMap[t.title] || 0) + 1;
      }
    }
  }

  const completionRate = totalCount > 0 ? Number(((completedCount / totalCount) * 100).toFixed(1)) : 0;

  // Identify most consistent category
  let mostConsistent = 'None';
  let bestRate = -1;
  for (const [cat, stat] of Object.entries(categoryStats)) {
    if (stat.total >= 2) {
      const rate = stat.completed / stat.total;
      if (rate > bestRate) {
        bestRate = rate;
        mostConsistent = `${cat} (${Math.round(rate * 100)}%)`;
      }
    }
  }

  // Identify most skipped task
  let mostSkipped = 'None';
  let maxMissed = 0;
  for (const [title, count] of Object.entries(missedTasksMap)) {
    if (count > maxMissed) {
      maxMissed = count;
      mostSkipped = `${title} (${count} missed)`;
    }
  }

  // Most common reason from reflections in past 7 days
  const reflections = db.prepare(`
    SELECT reason FROM reflections 
    WHERE date >= date(?, '-7 days')
  `).all(today);

  let commonReason = reflections.length > 0 ? reflections[0].reason : null;

  // Genuine insight derived from data
  let insight = "Continue logging daily promises to reveal schedule insights.";
  if (totalCount > 0) {
    if (completionRate < 60) {
      insight = "You don't need more motivation. You may need a lighter, more focused schedule.";
    } else if (completionRate >= 80) {
      insight = "Consistency is strong. Keep commitments realistic to maintain steady progress.";
    } else {
      insight = "Reflect honestly on the promises you repeatedly postpone.";
    }
  }

  return {
    completedCount,
    totalCount,
    completionRate,
    mostConsistent,
    mostSkipped,
    commonReason,
    insight
  };
}

/**
 * Searches past reflections and identifies repeat phrases
 */
function getArchive(searchQuery) {
  const db = getDatabase();
  let query = 'SELECT * FROM reflections ORDER BY date DESC';
  let params = [];

  if (searchQuery) {
    query = 'SELECT * FROM reflections WHERE reason LIKE ? OR task_name LIKE ? ORDER BY date DESC';
    const wild = `%${searchQuery}%`;
    params = [wild, wild];
  }

  const rows = db.prepare(query).all(...params);

  // Pattern detection: look for recurring justification tokens
  let patternNotice = null;
  const reasonText = rows.map(r => r.reason.toLowerCase()).join(' ');
  const commonPatterns = ['tired', 'late', 'exam', 'travel', 'busy', 'forgot'];
  
  for (const pat of commonPatterns) {
    const occurrences = (reasonText.match(new RegExp(pat, 'g')) || []).length;
    if (occurrences >= 3) {
      patternNotice = `You've cited reasons relating to "${pat}" ${occurrences} times recently.`;
      break;
    }
  }

  return {
    patternNotice,
    reflections: rows.map(r => ({
      id: r.id,
      date: r.date,
      taskName: r.task_name,
      reason: r.reason
    }))
  };
}

/**
 * Computes deterministic Honesty Score & Monthly stats
 * 
 * FORMULA:
 * TotalPromises = all scheduled occurrences this month
 * Completed = completed occurrences
 * Missed = TotalPromises - Completed
 * Explained = Missed tasks covered by a reflection
 * Unexplained = Missed - Explained
 * 
 * CompletionWeight = 60 * (Completed / TotalPromises)
 * HonestyWeight = 40 * (Explained / Missed) (or 40 if 0 missed)
 * Penalty = Unexplained > 0 ? 15 * (Unexplained / TotalPromises) : 0
 * Score = Math.max(0, Math.min(100, Math.round(CompletionWeight + HonestyWeight - Penalty)))
 */
function getHonestyScore(timezone) {
  const db = getDatabase();
  const now = timeService.getNow(timezone);
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const mStr = String(month).padStart(2, '0');
  const todayDate = timeService.getTodayDate(timezone);
  const [todayY, todayM, todayD] = todayDate.split('-').map(Number);
  const maxDay = (year === todayY && month === todayM) ? Math.min(todayD, daysInMonth) : daysInMonth;

  let promisesMade = 0;
  let completed = 0;
  let missed = 0;
  let explained = 0;
  let unexplained = 0;

  for (let day = 1; day <= maxDay; day++) {
    const dateStr = `${year}-${mStr}-${String(day).padStart(2, '0')}`;
    const tasks = getTasksForDate(dateStr, timezone);
    if (tasks.length === 0) continue;

    const dayReflection = db.prepare('SELECT id FROM reflections WHERE date = ?').get(dateStr);

    for (const t of tasks) {
      promisesMade++;
      if (t.completed) {
        completed++;
      } else {
        missed++;
        if (dayReflection) explained++;
        else unexplained++;
      }
    }
  }

  let honestyScore = 100;
  if (promisesMade > 0) {
    const compRatio = completed / promisesMade;
    const honestyRatio = missed === 0 ? 1 : explained / missed;
    const penalty = unexplained > 0 ? (15 * (unexplained / promisesMade)) : 0;
    honestyScore = Math.max(0, Math.min(100, Math.round((60 * compRatio) + (40 * honestyRatio) - penalty)));
  }

  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  return {
    honestyScore,
    month: `${months[month - 1]} ${year}`,
    promisesMade,
    completed,
    missed,
    explained,
    unexplained
  };
}

/**
 * Returns behavioral pattern insights
 */
function getInsights(timezone) {
  const db = getDatabase();
  const patterns = [];

  // 1. Time-of-day discrepancy check
  const earlyComps = db.prepare(`
    SELECT COUNT(*) as count FROM task_completions 
    WHERE completed = 1 AND strftime('%H', completed_at) < '19'
  `).get();
  
  const lateComps = db.prepare(`
    SELECT COUNT(*) as count FROM task_completions 
    WHERE completed = 1 AND strftime('%H', completed_at) >= '21'
  `).get();

  if (earlyComps && lateComps && (earlyComps.count > 0 || lateComps.count > 0)) {
    patterns.push({
      lead: 'Time-of-day completion',
      content: `Recorded completions before 7 PM (${earlyComps.count}) versus after 9 PM (${lateComps.count}). Tasks set earlier in the day carry higher execution reliability.`
    });
  }

  // 2. Day-of-week pattern check
  const dayComps = db.prepare(`
    SELECT strftime('%w', date) as dow, COUNT(*) as count 
    FROM task_completions WHERE completed = 0 
    GROUP BY dow ORDER BY count DESC LIMIT 1
  `).get();

  if (dayComps && dayComps.count > 1) {
    const days = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    patterns.push({
      lead: 'Day-of-week pattern',
      content: `You miss promises most frequently on ${days[Number(dayComps.dow)]}.`
    });
  }

  if (patterns.length === 0) {
    patterns.push({
      lead: 'Schedule Calibration',
      content: 'Logging your daily promises and reflections continuously builds behavioral patterns over time.'
    });
  }

  return { patterns };
}

/**
 * Returns proactive accountability notifications based on current time
 */
function getNotifications(timezone) {
  const settings = getSettings();
  const currentTime = timeService.getCurrentTime(timezone);
  const currentMinutes = timeService.parseTimeToMinutes(currentTime);
  const accMinutes = timeService.parseTimeToMinutes(settings.accountabilityTime);
  const resetMinutes = timeService.parseTimeToMinutes(settings.dailyReset || '00:00');

  const notifications = [];
  const todayTasks = getTasksForDate(timeService.getTodayDate(timezone), timezone);
  const incomplete = todayTasks.filter(t => !t.completed).length;

  if (incomplete > 0 && currentMinutes >= accMinutes && currentMinutes < (accMinutes + 75)) {
    notifications.push({
      id: 'notif_evening',
      message: `Be honest with yourself. You still have ${incomplete} unfinished ${incomplete === 1 ? 'promise' : 'promises'} today.`
    });
  }

  return { notifications };
}

module.exports = {
  getSettings,
  updateSettings,
  getTasksForDate,
  createTask,
  setTaskCompletion,
  deleteTask,
  getOffDay,
  declareOffDay,
  submitReflection,
  getTodayState,
  getCalendarMonth,
  getCalendarDayDetail,
  getWeeklyReport,
  getArchive,
  getHonestyScore,
  calculateHonestDays,
  getInsights,
  getNotifications
};
