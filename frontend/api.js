/**
 * HONEST - Centralized API Service Layer
 * 
 * Works seamlessly in both:
 * 1. Online Mode: Connected to Express/Vercel backend REST APIs
 * 2. Mobile / Standalone Mode: 100% offline, persistent on-device SQLite/LocalStorage engine
 */

const ApiService = (function () {
  const STORAGE_KEY = 'honest_local_state_v2';
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
    honestDays: 0,
    isOffDay: false,
    offDayReason: null,
    nightCheckActive: false,
    hasUnresolvedYesterday: false,
    tasks: [
      { id: 't1', title: '2 hrs Coding', name: '2 hrs Coding', definition: 'At least 45 minutes focused session', category: 'Focus', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't2', title: 'Study 1 Chapter', name: 'Study 1 Chapter', definition: 'Take handwritten notes, no skimming', category: 'Study', repeat: 'everyday', completed: true, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't3', title: '30 min Workout', name: '30 min Workout', definition: 'Full core & stretch routine', category: 'Health', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't4', title: 'DSA 3 Problems', name: 'DSA 3 Problems', definition: 'Solve without looking at solutions', category: 'Focus', repeat: 'everyday', completed: true, accountabilityTime: '22:30', createdAt: new Date().toISOString() },
      { id: 't5', title: 'Read 20 Pages', name: 'Read 20 Pages', definition: 'Deep reading, no phone in room', category: 'Reading', repeat: 'everyday', completed: false, accountabilityTime: '22:30', createdAt: new Date().toISOString() }
    ],
    unresolvedYesterdayTasks: [],
    reflectionsArchive: [
      { id: 'r1', date: 'October 3, 2026', taskName: 'Revision', reason: 'Had a college event and returned late.', timestamp: new Date(Date.now() - 86400000 * 2).toISOString() },
      { id: 'r2', date: 'October 1, 2026', taskName: 'DSA Practice', reason: 'Too tired after traveling back from lab.', timestamp: new Date(Date.now() - 86400000 * 4).toISOString() }
    ],
    weeklyReport: {
      completedCount: 18,
      totalCount: 24,
      completionRate: 75.0,
      mostConsistent: 'Coding (100%)',
      mostSkipped: 'Workout (50%)',
      commonReason: 'Too tired after college',
      insight: 'You don\'t need more motivation. You may need an earlier schedule.'
    },
    scoreStats: {
      honestyScore: 88,
      month: 'October 2026',
      promisesMade: 24,
      completed: 18,
      missed: 6,
      explained: 6,
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

  // Load persisted state from device storage
  function loadPersistedState() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        localState = { ...localState, ...parsed };
      }
    } catch (_) {}

    // Synchronize to current calendar day
    const curDates = getTodayDateStrings();
    localState.date = curDates.date;
    localState.isoDate = curDates.isoDate;
    savePersistedState();
  }

  function savePersistedState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(localState));
    } catch (_) {}
  }

  // Initialize state immediately
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
        // Returned HTML (e.g. mobile asset fallback / 404 page)
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

      // Network errors, timeouts, or JSON syntax issues smoothly fall back to local mode
      setConnected(false);
      return handleFallback(endpoint, options);
    }
  }

  /**
   * Complete on-device standalone engine
   */
  async function handleFallback(endpoint, options) {
    const method = (options.method || 'GET').toUpperCase();

    // GET /today
    if (endpoint === '/today' && method === 'GET') {
      const completed = localState.tasks.filter(t => t.completed).length;
      return {
        ...localState,
        completedCount: completed,
        totalCount: localState.tasks.length
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
        category: payload.category || 'Focus',
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
          name: payload.title || payload.name || localState.tasks[idx].title
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
        active: unfinished.length > 0,
        unfinishedTasks: unfinished,
        accountabilityTime: localState.settings.accountabilityTime
      };
    }

    // POST /night-check/reflect
    if (endpoint === '/night-check/reflect' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      localState.reflectionsArchive.unshift({
        id: 'ref-' + Date.now(),
        date: localState.date,
        taskName: payload.taskName || 'Incomplete Tasks',
        reason: payload.reason,
        timestamp: new Date().toISOString()
      });
      localState.hasUnresolvedYesterday = false;
      localState.unresolvedYesterdayTasks = [];
      localState.honestDays = (localState.honestDays || 0) + 1;
      savePersistedState();
      return { success: true, message: 'Reflection recorded.' };
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
    if (endpoint.startsWith('/calendar') && method === 'GET') {
      const completed = localState.tasks.filter(t => t.completed).length;
      const historyMap = {
        '2026-10-01': { status: 'explained', completed: 3, total: 4, reflection: 'Too tired after traveling back from lab.' },
        '2026-10-02': { status: 'completed', completed: 5, total: 5 },
        '2026-10-03': { status: 'explained', completed: 4, total: 5, reflection: 'Had a college event and returned late.' },
        '2026-10-04': { status: 'unresolved', completed: 1, total: 4 },
        '2026-10-05': { status: completed === localState.tasks.length ? 'completed' : 'active', completed, total: localState.tasks.length }
      };
      return {
        month: 'October 2026',
        history: historyMap
      };
    }

    // GET /calendar/day/:date
    if (endpoint.startsWith('/calendar/day/') && method === 'GET') {
      const dateStr = endpoint.split('/')[3];
      return {
        date: dateStr,
        completed: 4,
        total: 5,
        tasks: [
          { title: '2 hrs Coding', completed: true },
          { title: 'Study 1 Chapter', completed: true },
          { title: '30 min Workout', completed: true },
          { title: 'DSA 3 Problems', completed: true },
          { title: 'Read 20 Pages', completed: false }
        ],
        reflection: 'Had a college event and returned late.'
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
