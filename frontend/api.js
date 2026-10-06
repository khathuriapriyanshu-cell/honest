/**
 * HONEST - Centralized API Service Layer
 * 
 * Works seamlessly in both:
 * 1. Online Mode: Connected to Express/Vercel backend REST APIs
 * 2. Standalone Mobile Mode: 100% offline, persistent on-device SQLite/LocalStorage engine
 */

const ApiService = (function () {
  const STORAGE_KEY = 'honest_local_state_v3';
  let BASE_URL = (localStorage.getItem('honest_api_url') || '').trim();
  let isBackendConnected = false;
  let onConnectionChangeCallback = null;

  // Real today's formatted date
  function getTodayDateStrings() {
    const now = new Date();
    const options = { weekday: 'long', day: 'numeric', month: 'long' };
    return {
      date: now.toLocaleDateString('en-US', options),
      isoDate: now.toISOString().split('T')[0]
    };
  }

  const initialDates = getTodayDateStrings();

  // On-device persistent local state (used on mobile / offline)
  let localState = {
    date: initialDates.date,
    isoDate: initialDates.isoDate,
    lastActiveDate: initialDates.isoDate,
    yesterdayDate: null,
    honestDays: 0,
    isOffDay: false,
    offDayReason: null,
    nightCheckActive: false,
    hasUnresolvedYesterday: false,
    tasks: [
      { id: 't1', title: '2 hrs Coding', name: '2 hrs Coding', definition: 'At least 45 minutes focused session', category: 'Focus', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't2', title: 'Study 1 Chapter', name: 'Study 1 Chapter', definition: 'Take handwritten notes, no skimming', category: 'Study', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't3', title: '30 min Workout', name: '30 min Workout', definition: 'Full core & stretch routine', category: 'Health', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't4', title: 'DSA 3 Problems', name: 'DSA 3 Problems', definition: 'Solve without looking at solutions', category: 'Focus', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't5', title: 'Read 20 Pages', name: 'Read 20 Pages', definition: 'Deep reading, no phone in room', category: 'Reading', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() }
    ],
    unresolvedYesterdayTasks: [],
    calendarHistory: {
      '2026-10-01': { status: 'explained', completed: 3, total: 4, tasks: [{ title: 'Coding', completed: true }, { title: 'Study', completed: true }, { title: 'Reading', completed: true }, { title: 'Workout', completed: false }], reflection: 'Too tired after traveling back from lab.' },
      '2026-10-02': { status: 'completed', completed: 5, total: 5, tasks: [{ title: 'Coding', completed: true }, { title: 'Study', completed: true }, { title: 'Workout', completed: true }, { title: 'DSA', completed: true }, { title: 'Reading', completed: true }], reflection: null },
      '2026-10-03': { status: 'explained', completed: 4, total: 5, tasks: [{ title: 'Coding', completed: true }, { title: 'Study', completed: true }, { title: 'DSA', completed: true }, { title: 'Reading', completed: true }, { title: 'Workout', completed: false }], reflection: 'Had a college event and returned late.' },
      '2026-10-04': { status: 'unresolved', completed: 2, total: 4, tasks: [{ title: 'Coding', completed: true }, { title: 'Reading', completed: true }, { title: 'DSA', completed: false }, { title: 'Workout', completed: false }], reflection: null }
    },
    reflectionsArchive: [
      { id: 'r1', date: 'October 3, 2026', taskName: 'Workout', reason: 'Had a college event and returned late.', timestamp: new Date(Date.now() - 86400000 * 2).toISOString() },
      { id: 'r2', date: 'October 1, 2026', taskName: 'Workout', reason: 'Too tired after traveling back from lab.', timestamp: new Date(Date.now() - 86400000 * 4).toISOString() }
    ],
    weeklyReport: {
      completedCount: 14,
      totalCount: 18,
      completionRate: 77.8,
      mostConsistent: 'Coding (100%)',
      mostSkipped: 'Workout (50%)',
      commonReason: 'Got back late / exhausted',
      insight: 'You don\'t need more motivation. You may need an earlier schedule.'
    },
    scoreStats: {
      honestyScore: 86,
      month: 'October 2026',
      promisesMade: 18,
      completed: 14,
      missed: 4,
      explained: 4,
      unexplained: 0
    },
    patterns: [
      { lead: 'Time-of-day discrepancy', content: 'You complete coding tasks 91% of the time when done before 7 PM, but only 54% after 9 PM.' },
      { lead: 'Day-of-week pattern', content: 'You frequently miss tasks on Thursdays.' },
      { lead: 'Primary justification', content: 'Your most common recorded reason for unfinished tasks is "got late."' }
    ],
    settings: {
      accountabilityTime: '22:30',
      dailyReset: '00:00',
      gracePeriod: 15,
      weekStart: 'monday',
      notifications: true,
      theme: 'dark',
      apiUrl: ''
    }
  };

  // Date Rollover & Day Lock Check
  function checkDateRollover() {
    const curDates = getTodayDateStrings();
    const todayIso = curDates.isoDate;

    if (!localState.lastActiveDate) {
      localState.lastActiveDate = todayIso;
      savePersistedState();
      return;
    }

    if (localState.lastActiveDate !== todayIso) {
      // Date has changed! Check if yesterday had incomplete tasks
      const prevDate = localState.lastActiveDate;
      const prevTasks = Array.isArray(localState.tasks) ? [...localState.tasks] : [];
      const incomplete = prevTasks.filter(t => !t.completed);

      localState.calendarHistory = localState.calendarHistory || {};

      if (incomplete.length > 0) {
        // Yesterday was NOT finished: activate Day Lock
        localState.hasUnresolvedYesterday = true;
        localState.unresolvedYesterdayTasks = incomplete;
        localState.yesterdayDate = prevDate;

        localState.calendarHistory[prevDate] = {
          status: 'unresolved',
          completed: prevTasks.filter(t => t.completed).length,
          total: prevTasks.length,
          tasks: prevTasks.map(t => ({ title: t.title || t.name, completed: !!t.completed })),
          reflection: null
        };
      } else {
        // All tasks were finished yesterday
        localState.hasUnresolvedYesterday = false;
        localState.unresolvedYesterdayTasks = [];
        localState.yesterdayDate = null;
        localState.honestDays = (localState.honestDays || 0) + 1;

        localState.calendarHistory[prevDate] = {
          status: 'completed',
          completed: prevTasks.length,
          total: prevTasks.length,
          tasks: prevTasks.map(t => ({ title: t.title || t.name, completed: true })),
          reflection: null
        };
      }

      // Reset recurring tasks for the new active day
      localState.tasks = prevTasks.map(t => {
        if (t.repeat === 'everyday' || t.repeat === 'daily') {
          return { ...t, completed: false };
        }
        return t;
      }).filter(t => t.repeat !== 'once' || !t.completed);

      localState.lastActiveDate = todayIso;
      localState.date = curDates.date;
      localState.isoDate = todayIso;
      savePersistedState();
    }
  }

  // Load persisted state from device storage
  function loadPersistedState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        localState = { ...localState, ...parsed };
      }
    } catch (_) {}

    checkDateRollover();
  }

  function savePersistedState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
    } catch (_) {}
  }

  // Initialize immediately
  loadPersistedState();

  function setConnected(status) {
    if (isBackendConnected !== status) {
      isBackendConnected = status;
      if (typeof onConnectionChangeCallback === 'function') {
        onConnectionChangeCallback(isBackendConnected, BASE_URL);
      }
    }
  }

  /**
   * Safe fetch with automatic local fallback
   */
  async function request(endpoint, options = {}) {
    const isMobileNative = window.location.protocol === 'capacitor:' || 
                           window.location.protocol === 'file:' ||
                           (window.location.hostname === 'localhost' && (!window.location.port || window.location.port === '80'));

    // If on native mobile and no custom remote server URL is set, run local mode directly
    if (isMobileNative && (!BASE_URL || BASE_URL === '/api')) {
      setConnected(false);
      return handleFallback(endpoint, options);
    }

    const apiUrl = BASE_URL ? (BASE_URL.replace(/\/$/, '') + endpoint) : (`/api${endpoint}`);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    try {
      const response = await fetch(apiUrl, {
        ...options,
        headers: { ...defaultHeaders, ...options.headers },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      // Verify that response is valid JSON
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        setConnected(false);
        return handleFallback(endpoint, options);
      }

      if (!response.ok) {
        let errorData = {};
        try { errorData = await response.json(); } catch (_) {}
        const error = new Error(errorData.message || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.data = errorData;
        throw error;
      }

      setConnected(true);
      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);
      setConnected(false);
      return handleFallback(endpoint, options);
    }
  }

  /**
   * Complete on-device standalone engine
   */
  async function handleFallback(endpoint, options) {
    const method = (options.method || 'GET').toUpperCase();
    checkDateRollover();

    // Current time evaluation for Daily Check Time
    const now = new Date();
    const curMins = now.getHours() * 60 + now.getMinutes();
    const [accH, accM] = (localState.settings.accountabilityTime || '22:30').split(':').map(Number);
    const accMins = (accH || 22) * 60 + (accM || 30);
    const incompleteTasks = localState.tasks.filter(t => !t.completed);

    // Night check is active if current time is past Daily Check Time and incomplete tasks exist
    localState.nightCheckActive = (curMins >= accMins && incompleteTasks.length > 0);

    // GET /today
    if (endpoint === '/today' && method === 'GET') {
      const completed = localState.tasks.filter(t => t.completed).length;
      return {
        ...localState,
        completedCount: completed,
        totalCount: localState.tasks.length,
        nightCheckActive: localState.nightCheckActive
      };
    }

    // POST /tasks
    if (endpoint === '/tasks' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      const newTask = {
        id: 'task-' + Date.now(),
        title: payload.title || payload.name || 'Untitled Promise',
        name: payload.title || payload.name || 'Untitled Promise',
        description: payload.description || '',
        definition: payload.definition || payload.description || '',
        category: payload.category || 'Study',
        repeat: payload.repeat || 'everyday',
        repeatDays: payload.repeatDays || [],
        completed: false,
        reminderTime: payload.reminderTime || null,
        accountabilityTime: payload.accountabilityTime || localState.settings.accountabilityTime || '22:30',
        createdAt: new Date().toISOString()
      };
      localState.tasks.unshift(newTask);
      savePersistedState();
      return newTask;
    }

    // PUT /tasks/:id/complete
    if (endpoint.startsWith('/tasks/') && endpoint.endsWith('/complete') && method === 'PUT') {
      const id = endpoint.split('/')[2];
      const task = localState.tasks.find(t => t.id === id);
      if (task) {
        task.completed = true;
        savePersistedState();
      }
      return { success: true, task };
    }

    // PUT /tasks/:id/uncomplete
    if (endpoint.startsWith('/tasks/') && endpoint.endsWith('/uncomplete') && method === 'PUT') {
      const id = endpoint.split('/')[2];
      const task = localState.tasks.find(t => t.id === id);
      if (task) {
        task.completed = false;
        savePersistedState();
      }
      return { success: true, task };
    }

    // PUT /tasks/:id
    if (endpoint.startsWith('/tasks/') && method === 'PUT') {
      const id = endpoint.split('/')[2];
      const payload = JSON.parse(options.body || '{}');
      const idx = localState.tasks.findIndex(t => t.id === id);
      if (idx !== -1) {
        localState.tasks[idx] = {
          ...localState.tasks[idx],
          ...payload,
          title: payload.title || payload.name || localState.tasks[idx].title,
          name: payload.title || payload.name || localState.tasks[idx].title,
          category: payload.category || localState.tasks[idx].category || 'Study',
          reminderTime: payload.reminderTime !== undefined ? payload.reminderTime : localState.tasks[idx].reminderTime
        };
        savePersistedState();
        return localState.tasks[idx];
      }
      return { success: true };
    }

    // DELETE /tasks/:id
    if (endpoint.startsWith('/tasks/') && method === 'DELETE') {
      const id = endpoint.split('/')[2];
      localState.tasks = localState.tasks.filter(t => t.id !== id);
      savePersistedState();
      return { success: true };
    }

    // GET /night-check
    if (endpoint === '/night-check' && method === 'GET') {
      const unfinished = localState.tasks.filter(t => !t.completed);
      return {
        active: unfinished.length > 0 && curMins >= accMins,
        unfinishedTasks: unfinished,
        accountabilityTime: localState.settings.accountabilityTime
      };
    }

    // POST /night-check/reflect
    if (endpoint === '/night-check/reflect' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      const refDate = localState.yesterdayDate || localState.date;
      const missedNames = (localState.unresolvedYesterdayTasks || []).map(t => t.title || t.name).join(', ') || 'Incomplete Promises';

      const newRef = {
        id: 'ref-' + Date.now(),
        date: refDate,
        taskName: payload.taskName || missedNames,
        reason: payload.reason,
        timestamp: new Date().toISOString()
      };
      localState.reflectionsArchive.unshift(newRef);

      // Update calendar entry for that date to explained
      localState.calendarHistory = localState.calendarHistory || {};
      if (localState.yesterdayDate && localState.calendarHistory[localState.yesterdayDate]) {
        localState.calendarHistory[localState.yesterdayDate].status = 'explained';
        localState.calendarHistory[localState.yesterdayDate].reflection = payload.reason;
      }

      localState.hasUnresolvedYesterday = false;
      localState.unresolvedYesterdayTasks = [];
      localState.yesterdayDate = null;
      localState.honestDays = (localState.honestDays || 0) + 1;
      savePersistedState();
      return { success: true, message: 'Reflection recorded.', reflection: newRef };
    }

    // POST /off-day
    if (endpoint === '/off-day' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      localState.isOffDay = true;
      localState.offDayReason = payload.reason;
      savePersistedState();
      return { success: true, reason: payload.reason };
    }

    // GET /calendar
    if (endpoint.startsWith('/calendar') && !endpoint.includes('/day/') && method === 'GET') {
      const curCompleted = localState.tasks.filter(t => t.completed).length;
      const historyMap = { ...(localState.calendarHistory || {}) };

      // Set today's current status
      historyMap[localState.isoDate] = {
        status: (curCompleted === localState.tasks.length && localState.tasks.length > 0) ? 'completed' : 'active',
        completed: curCompleted,
        total: localState.tasks.length
      };

      return {
        month: 'October 2026',
        history: historyMap
      };
    }

    // GET /calendar/day/:date or /calendar/:date (YYYY-MM-DD)
    if ((endpoint.startsWith('/calendar/day/') || /^\/calendar\/\d{4}-\d{2}-\d{2}/.test(endpoint)) && method === 'GET') {
      const parts = endpoint.split('/');
      const dateStr = parts[parts.length - 1];

      // If clicked on today
      if (dateStr === localState.isoDate) {
        const curCompleted = localState.tasks.filter(t => t.completed).length;
        return {
          date: dateStr,
          completed: curCompleted,
          total: localState.tasks.length,
          tasks: localState.tasks.map(t => ({
            title: t.title || t.name,
            name: t.title || t.name,
            completed: !!t.completed
          })),
          reflection: null
        };
      }

      // If clicked on a saved historical date
      if (localState.calendarHistory && localState.calendarHistory[dateStr]) {
        const entry = localState.calendarHistory[dateStr];
        return {
          date: dateStr,
          completed: entry.completed || 0,
          total: entry.total || (entry.tasks ? entry.tasks.length : 0),
          tasks: entry.tasks || [],
          reflection: entry.reflection || null
        };
      }

      // Any other date
      return {
        date: dateStr,
        completed: 0,
        total: 0,
        tasks: [],
        reflection: null
      };
    }

    // GET /report/weekly
    if (endpoint === '/report/weekly' && method === 'GET') {
      return localState.weeklyReport;
    }

    // GET /archive
    if (endpoint.startsWith('/archive') && method === 'GET') {
      const query = endpoint.includes('?q=') ? decodeURIComponent(endpoint.split('?q=')[1]).toLowerCase() : '';
      const filtered = query
        ? localState.reflectionsArchive.filter(r => (r.reason || '').toLowerCase().includes(query) || (r.taskName || '').toLowerCase().includes(query))
        : localState.reflectionsArchive;
      return {
        reflections: filtered,
        patternNotice: filtered.length >= 2 ? 'You often note being tired in the evenings.' : null
      };
    }

    // GET /stats/score
    if (endpoint === '/stats/score' && method === 'GET') {
      return localState.scoreStats;
    }

    // GET /insights
    if (endpoint === '/insights' && method === 'GET') {
      return { patterns: localState.patterns };
    }

    // GET /settings
    if (endpoint === '/settings' && method === 'GET') {
      return {
        ...localState.settings,
        apiUrl: BASE_URL || ''
      };
    }

    // PUT /settings
    if (endpoint === '/settings' && method === 'PUT') {
      const payload = JSON.parse(options.body || '{}');
      localState.settings = { ...localState.settings, ...payload };
      if (typeof payload.apiUrl !== 'undefined') {
        BASE_URL = (payload.apiUrl || '').trim();
        localStorage.setItem('honest_api_url', BASE_URL);
      }
      savePersistedState();
      return { success: true, settings: localState.settings };
    }

    // GET /notifications
    if (endpoint === '/notifications' && method === 'GET') {
      return { notifications: [] };
    }

    return { success: true };
  }

  // Public Interface
  return {
    setBaseUrl(newUrl) {
      BASE_URL = (newUrl || '').trim().replace(/\/$/, '');
      localStorage.setItem('honest_api_url', BASE_URL);
    },
    getBaseUrl() {
      return BASE_URL;
    },
    isConnected() {
      return isBackendConnected;
    },
    onConnectionChange(callback) {
      onConnectionChangeCallback = callback;
    },

    // Daily & Tasks API
    async getTodayState() {
      return request('/today');
    },
    async createTask(taskData) {
      return request('/tasks', {
        method: 'POST',
        body: JSON.stringify(taskData)
      });
    },
    async completeTask(taskId) {
      return request(`/tasks/${taskId}/complete`, {
        method: 'PUT'
      });
    },
    async uncompleteTask(taskId) {
      return request(`/tasks/${taskId}/uncomplete`, {
        method: 'PUT'
      });
    },
    async deleteTask(taskId) {
      return request(`/tasks/${taskId}`, {
        method: 'DELETE'
      });
    },
    async updateTask(taskId, taskData) {
      return request(`/tasks/${taskId}`, {
        method: 'PUT',
        body: JSON.stringify(taskData)
      });
    },

    // Night Check & Reflection API
    async getNightCheckState() {
      return request('/night-check');
    },
    async submitReflection(reflectionData) {
      return request('/night-check/reflect', {
        method: 'POST',
        body: JSON.stringify(reflectionData)
      });
    },

    // Calendar API
    async getCalendarMonth(month, year) {
      return request(`/calendar?month=${month}&year=${year}`);
    },
    async getCalendarDay(dateStr) {
      return request(`/calendar/day/${dateStr}`);
    },

    // Reports & Analytics API
    async getWeeklyReport() {
      return request('/report/weekly');
    },
    async getArchive(query = '') {
      const q = query ? `?q=${encodeURIComponent(query)}` : '';
      return request(`/archive${q}`);
    },
    async getHonestyScore() {
      return request('/stats/score');
    },
    async getInsights() {
      return request('/insights');
    },

    // Off Day API
    async activateOffDay(reason) {
      return request('/off-day', {
        method: 'POST',
        body: JSON.stringify({ reason })
      });
    },

    // Settings API
    async getSettings() {
      return request('/settings');
    },
    async updateSettings(settingsData) {
      return request('/settings', {
        method: 'PUT',
        body: JSON.stringify(settingsData)
      });
    },

    // Notifications API
    async getNotifications() {
      return request('/notifications');
    }
  };
})();
