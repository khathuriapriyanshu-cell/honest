/**
 * HONEST - Centralized API Service Layer
 * 
 * Boundary Enforcement:
 * - This layer executes strictly inside the browser.
 * - All backend communication is routed through standard fetch() calls.
 * - If backend endpoints are unreachable, it reports meaningful error states.
 * - Temporary in-memory mock fallback allows interface verification while
 *   evaluating backend-1, backend-2, and backend-3 implementations.
 */

const ApiService = (function () {
  // Configurable base URL (can be customized via settings)
  let BASE_URL = localStorage.getItem('honest_api_url') || '/api';
  let isBackendConnected = false;
  let onConnectionChangeCallback = null;

  // In-memory temporary seed data used ONLY when backend server is not yet running
  let mockState = {
    date: 'Monday - 5 October',
    isoDate: '2026-10-05',
    honestDays: 12,
    isOffDay: false,
    offDayReason: null,
    nightCheckActive: false,
    hasUnresolvedYesterday: false,
    tasks: [
      { id: 't1', title: '2 hrs Coding', definition: 'At least 45 minutes focused session', category: 'DSA', completed: false, accountabilityTime: '22:30' },
      { id: 't2', title: 'Study 1 Chapter', definition: 'Take handwritten notes, no skimming', category: 'Study', completed: true, accountabilityTime: '22:30' },
      { id: 't3', title: '30 min Workout', definition: 'Full core & stretch routine', category: 'Workout', completed: false, accountabilityTime: '22:30' },
      { id: 't4', title: 'DSA 3 Problems', definition: 'Solve without looking at solutions', category: 'DSA', completed: true, accountabilityTime: '22:30' },
      { id: 't5', title: 'Read 20 Pages', definition: 'Deep reading, no phone in room', category: 'Reading', completed: false, accountabilityTime: '22:30' }
    ],
    unresolvedYesterdayTasks: [
      { id: 'y1', title: '30 min Workout', definition: 'Full cardio run', category: 'Workout' }
    ],
    reflectionsArchive: [
      { id: 'r1', date: 'October 3, 2026', taskName: 'Revision', reason: 'Had a college event and returned late.' },
      { id: 'r2', date: 'October 1, 2026', taskName: 'DSA Practice', reason: 'Too tired after traveling back from lab.' },
      { id: 'r3', date: 'September 28, 2026', taskName: 'Read 20 Pages', reason: 'Did not prioritize it before bed.' }
    ],
    weeklyReport: {
      completedCount: 31,
      totalCount: 37,
      completionRate: 83.7,
      mostConsistent: 'Coding (100%)',
      mostSkipped: 'Workout (57%)',
      commonReason: 'Too tired / got late',
      insight: 'You don\'t need more motivation. You may need a better schedule.'
    },
    scoreStats: {
      honestyScore: 84,
      month: 'October 2026',
      promisesMade: 142,
      completed: 119,
      missed: 23,
      explained: 23,
      unexplained: 0
    },
    patterns: [
      {
        lead: 'Time-of-day discrepancy',
        content: 'You complete coding tasks 91% of the time when scheduled before 7 PM, but only 54% when scheduled after 9 PM.'
      },
      {
        lead: 'Day-of-week pattern',
        content: 'You frequently miss tasks on Thursdays.'
      },
      {
        lead: 'Primary justification',
        content: 'Your most common reason for unfinished tasks is "got late."'
      }
    ],
    settings: {
      accountabilityTime: '22:30',
      dailyReset: '00:00',
      gracePeriod: 15,
      weekStart: 'monday',
      notifications: true,
      theme: 'dark',
      apiUrl: 'http://localhost:3000/api'
    }
  };

  /**
   * Safe fetch wrapper with timeout
   */
  async function request(endpoint, options = {}) {
    const url = `${BASE_URL}${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const defaultHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...defaultHeaders, ...options.headers },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      setConnected(true);

      if (!response.ok) {
        let errorData = {};
        try { errorData = await response.json(); } catch (_) {}
        const error = new Error(errorData.message || `Request failed with status ${response.status}`);
        error.status = response.status;
        error.data = errorData;
        throw error;
      }

      return await response.json();
    } catch (err) {
      clearTimeout(timeoutId);

      // Distinguish network failure vs backend logic error
      if (err.name === 'AbortError' || err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
        setConnected(false);
        // Fallback gracefully to temporary local state
        return handleFallback(endpoint, options);
      }
      throw err;
    }
  }

  function setConnected(status) {
    if (isBackendConnected !== status) {
      isBackendConnected = status;
      if (typeof onConnectionChangeCallback === 'function') {
        onConnectionChangeCallback(isBackendConnected, BASE_URL);
      }
    }
  }

  /**
   * Graceful fallback handler when backend is offline
   */
  async function handleFallback(endpoint, options) {
    const method = (options.method || 'GET').toUpperCase();

    // GET /today
    if (endpoint === '/today' && method === 'GET') {
      return { ...mockState };
    }

    // POST /tasks
    if (endpoint === '/tasks' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      const newTask = {
        id: 'mock-' + Date.now(),
        title: payload.title,
        definition: payload.definition,
        category: payload.category || 'Study',
        repeat: payload.repeat || 'once',
        completed: false,
        accountabilityTime: payload.accountabilityTime || '22:30'
      };
      mockState.tasks.unshift(newTask);
      return newTask;
    }

    // PUT /tasks/:id/complete
    if (endpoint.startsWith('/tasks/') && endpoint.endsWith('/complete') && method === 'PUT') {
      const id = endpoint.split('/')[2];
      const task = mockState.tasks.find(t => t.id === id);
      if (task) task.completed = true;
      return { success: true, task };
    }

    // PUT /tasks/:id/uncomplete
    if (endpoint.startsWith('/tasks/') && endpoint.endsWith('/uncomplete') && method === 'PUT') {
      const id = endpoint.split('/')[2];
      const task = mockState.tasks.find(t => t.id === id);
      if (task) task.completed = false;
      return { success: true, task };
    }

    // DELETE /tasks/:id
    if (endpoint.startsWith('/tasks/') && method === 'DELETE') {
      const id = endpoint.split('/')[2];
      mockState.tasks = mockState.tasks.filter(t => t.id !== id);
      return { success: true };
    }

    // GET /night-check
    if (endpoint === '/night-check' && method === 'GET') {
      const unfinished = mockState.tasks.filter(t => !t.completed);
      return {
        active: unfinished.length > 0,
        unfinishedTasks: unfinished,
        accountabilityTime: mockState.settings.accountabilityTime
      };
    }

    // POST /night-check/reflect
    if (endpoint === '/night-check/reflect' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      mockState.reflectionsArchive.unshift({
        id: 'ref-' + Date.now(),
        date: mockState.date,
        taskName: payload.taskName || 'Unfinished Promises',
        reason: payload.reason
      });
      mockState.hasUnresolvedYesterday = false;
      mockState.unresolvedYesterdayTasks = [];
      return { success: true, message: 'Reason recorded.' };
    }

    // POST /off-day
    if (endpoint === '/off-day' && method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      mockState.isOffDay = true;
      mockState.offDayReason = payload.reason;
      return { success: true, reason: payload.reason };
    }

    // GET /calendar
    if (endpoint.startsWith('/calendar') && method === 'GET') {
      // Return simulated month history map
      return {
        month: 'October 2026',
        history: {
          '2026-10-01': { status: 'explained', completed: 3, total: 4, reflection: 'Too tired after traveling back from lab.' },
          '2026-10-02': { status: 'completed', completed: 5, total: 5 },
          '2026-10-03': { status: 'explained', completed: 4, total: 5, reflection: 'Had a college event and returned late.' },
          '2026-10-04': { status: 'unresolved', completed: 1, total: 4 },
          '2026-10-05': { status: 'active', completed: 2, total: 5 }
        }
      };
    }

    // GET /calendar/:date
    if (endpoint.startsWith('/calendar/day/') && method === 'GET') {
      const dateStr = endpoint.split('/')[3];
      return {
        date: dateStr,
        completed: 4,
        total: 5,
        tasks: [
          { title: 'Coding', completed: true },
          { title: 'DSA', completed: true },
          { title: 'Workout', completed: true },
          { title: 'Reading', completed: true },
          { title: 'Revision', completed: false }
        ],
        reflection: 'Had a college event and returned late.'
      };
    }

    // GET /report/weekly
    if (endpoint === '/report/weekly' && method === 'GET') {
      return mockState.weeklyReport;
    }

    // GET /archive
    if (endpoint.startsWith('/archive') && method === 'GET') {
      return {
        reflections: mockState.reflectionsArchive,
        patternNotice: 'You\'ve used "too tired" 3 times recently.'
      };
    }

    // GET /stats/score
    if (endpoint === '/stats/score' && method === 'GET') {
      return mockState.scoreStats;
    }

    // GET /insights
    if (endpoint === '/insights' && method === 'GET') {
      return { patterns: mockState.patterns };
    }

    // GET /settings
    if (endpoint === '/settings' && method === 'GET') {
      return mockState.settings;
    }

    // PUT /settings
    if (endpoint === '/settings' && method === 'PUT') {
      const payload = JSON.parse(options.body || '{}');
      mockState.settings = { ...mockState.settings, ...payload };
      return { success: true, settings: mockState.settings };
    }

    // GET /notifications
    if (endpoint === '/notifications' && method === 'GET') {
      return {
        notifications: []
      };
    }

    throw new Error(`Endpoint ${endpoint} not found in fallback.`);
  }

  // Public Interface
  return {
    setBaseUrl(newUrl) {
      BASE_URL = newUrl.replace(/\/$/, '');
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
