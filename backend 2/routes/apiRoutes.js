/**
 * HONEST Backend 2 (KBAI) - REST API Routes
 * 
 * Implements strict endpoint contracts expected by the frontend.
 * Provides parameter validation and HTTP status codes.
 */

const express = require('express');
const router = express.Router();
const accountabilityService = require('../services/accountabilityService');
const timeService = require('../services/timeService');

function getTimezone() {
  const settings = accountabilityService.getSettings();
  return settings.timezone;
}

// ----------------------------------------------------
// 1. Today State
// ----------------------------------------------------
router.get('/today', (req, res, next) => {
  try {
    const tz = getTimezone();
    const state = accountabilityService.getTodayState(tz);
    res.json(state);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 2. Tasks & Promises
// ----------------------------------------------------
router.post('/tasks', (req, res, next) => {
  try {
    const { title, definition, category, repeat, selectedDays, reminder, accountabilityTime } = req.body;
    
    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: { code: 'INVALID_TITLE', message: 'Task name is required.' } });
    }

    if (!definition || typeof definition !== 'string' || !definition.trim()) {
      return res.status(400).json({ error: { code: 'INVALID_DEFINITION', message: 'Minimum completion definition is required.' } });
    }

    const validRepeats = ['once', 'daily', 'selected'];
    if (repeat && !validRepeats.includes(repeat)) {
      return res.status(400).json({ error: { code: 'INVALID_REPEAT', message: 'Repeat type must be once, daily, or selected.' } });
    }

    const tz = getTimezone();
    const created = accountabilityService.createTask({
      title: title.trim(),
      definition: definition.trim(),
      category: category ? category.trim() : 'Study',
      repeat: repeat || 'once',
      selectedDays,
      reminder,
      accountabilityTime
    }, tz);

    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

router.put('/tasks/:id/complete', (req, res, next) => {
  try {
    const taskId = req.params.id;
    const tz = getTimezone();
    const today = timeService.getTodayDate(tz);

    accountabilityService.setTaskCompletion(taskId, today, true);
    res.json({ success: true, task: { id: taskId, completed: true } });
  } catch (err) {
    next(err);
  }
});

router.put('/tasks/:id/uncomplete', (req, res, next) => {
  try {
    const taskId = req.params.id;
    const tz = getTimezone();
    const today = timeService.getTodayDate(tz);

    accountabilityService.setTaskCompletion(taskId, today, false);
    res.json({ success: true, task: { id: taskId, completed: false } });
  } catch (err) {
    next(err);
  }
});

router.delete('/tasks/:id', (req, res, next) => {
  try {
    const taskId = req.params.id;
    accountabilityService.deleteTask(taskId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 3. Night Check & Reflection
// ----------------------------------------------------
router.get('/night-check', (req, res, next) => {
  try {
    const tz = getTimezone();
    const settings = accountabilityService.getSettings();
    const todayTasks = accountabilityService.getTasksForDate(timeService.getTodayDate(tz), tz);
    const unfinished = todayTasks.filter(t => !t.completed);

    const active = timeService.isNightCheckActive(
      settings.accountabilityTime,
      settings.dailyReset,
      settings.gracePeriod,
      tz
    ) && unfinished.length > 0;

    res.json({
      active,
      accountabilityTime: settings.accountabilityTime || '22:30',
      unfinishedTasks: unfinished
    });
  } catch (err) {
    next(err);
  }
});

router.post('/night-check/reflect', (req, res, next) => {
  try {
    const { reason, taskName } = req.body;
    if (!reason || typeof reason !== 'string' || !reason.trim()) {
      return res.status(400).json({ error: { code: 'INVALID_REASON', message: 'A reflection reason is required.' } });
    }

    const tz = getTimezone();
    const yesterday = timeService.getYesterdayDate(tz);
    const today = timeService.getTodayDate(tz);

    // Apply reflection to yesterday if unfinished, otherwise today
    const yesterdayTasks = accountabilityService.getTasksForDate(yesterday, tz);
    const yesterdayIncomplete = yesterdayTasks.filter(t => !t.completed);
    const targetDate = yesterdayIncomplete.length > 0 ? yesterday : today;

    const result = accountabilityService.submitReflection(reason.trim(), taskName, targetDate);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 4. Calendar History
// ----------------------------------------------------
router.get('/calendar', (req, res, next) => {
  try {
    const tz = getTimezone();
    const now = timeService.getNow(tz);
    const month = parseInt(req.query.month, 10) || (now.getMonth() + 1);
    const year = parseInt(req.query.year, 10) || now.getFullYear();

    const data = accountabilityService.getCalendarMonth(month, year, tz);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get('/calendar/day/:date', (req, res, next) => {
  try {
    const dateStr = req.params.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: { code: 'INVALID_DATE', message: 'Date must be formatted as YYYY-MM-DD' } });
    }

    const tz = getTimezone();
    const detail = accountabilityService.getCalendarDayDetail(dateStr, tz);
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 5. Weekly Report
// ----------------------------------------------------
router.get('/report/weekly', (req, res, next) => {
  try {
    const tz = getTimezone();
    const report = accountabilityService.getWeeklyReport(tz);
    res.json(report);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 6. Honest Archive
// ----------------------------------------------------
router.get('/archive', (req, res, next) => {
  try {
    const query = req.query.q || '';
    const data = accountabilityService.getArchive(query);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 7. Honest Score & Behavioral Patterns
// ----------------------------------------------------
router.get('/stats/score', (req, res, next) => {
  try {
    const tz = getTimezone();
    const stats = accountabilityService.getHonestyScore(tz);
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

router.get('/insights', (req, res, next) => {
  try {
    const tz = getTimezone();
    const insights = accountabilityService.getInsights(tz);
    res.json(insights);
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 8. Off Day
// ----------------------------------------------------
router.post('/off-day', (req, res, next) => {
  try {
    const { reason } = req.body;
    const validReasons = ['Sick', 'Travel', 'Exams finished', 'Personal day'];
    
    if (!reason || !validReasons.includes(reason)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_OFFDAY_REASON',
          message: 'Reason must be one of: Sick, Travel, Exams finished, Personal day.'
        }
      });
    }

    const tz = getTimezone();
    const result = accountabilityService.declareOffDay(reason, tz);
    res.json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ message: err.message, error: { code: 'OFFDAY_RESTRICTION', message: err.message } });
    }
    next(err);
  }
});

// ----------------------------------------------------
// 9. Settings
// ----------------------------------------------------
router.get('/settings', (req, res, next) => {
  try {
    const settings = accountabilityService.getSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

router.put('/settings', (req, res, next) => {
  try {
    const updated = accountabilityService.updateSettings(req.body);
    res.json({ success: true, settings: updated });
  } catch (err) {
    next(err);
  }
});

// ----------------------------------------------------
// 10. Proactive Notifications
// ----------------------------------------------------
router.get('/notifications', (req, res, next) => {
  try {
    const tz = getTimezone();
    const notifs = accountabilityService.getNotifications(tz);
    res.json(notifs);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
