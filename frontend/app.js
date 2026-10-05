/**
 * HONEST - Application Controller (V1 Core Loop)
 * 
 * Core Loop:
 * Add Task -> Toggle Done -> Night Check -> Missed Task -> Explain -> Save -> New Day
 */

document.addEventListener('DOMContentLoaded', () => {
  // ==========================================
  // State
  // ==========================================
  let currentView = 'view-today';
  let calendarYear = 2026;
  let calendarMonth = 10;
  let todayState = null;
  let selectedTask = null; // for task details modal

  // ==========================================
  // DOM Elements
  // ==========================================
  // Navigation & Views
  const navTabs = document.querySelectorAll('.nav-tab');
  const viewPanels = document.querySelectorAll('.view-panel');
  const themeToggle = document.getElementById('theme-toggle');
  const errorBanner = document.getElementById('app-error-banner');
  const errorText = document.getElementById('app-error-text');
  const errorRetryBtn = document.getElementById('app-error-retry');
  const errorDismissBtn = document.getElementById('app-error-dismiss');
  const globalNotification = document.getElementById('global-notification');
  const notificationViewUnfinished = document.getElementById('notification-view-unfinished');
  const notificationClose = document.getElementById('notification-close');

  // Today View Elements
  const todayDateDisplay = document.getElementById('today-date-display');
  const todayCompletionCount = document.getElementById('today-completion-count');
  const honestDaysNumber = document.getElementById('honest-days-number');
  const taskList = document.getElementById('task-list');
  const tasksLoading = document.getElementById('tasks-loading');
  const tasksEmpty = document.getElementById('tasks-empty');
  const tasksContainerWrap = document.getElementById('tasks-container-wrap');
  const nightCheckPromptBanner = document.getElementById('night-check-prompt-banner');
  const nightCheckPromptText = document.getElementById('night-check-prompt-text');
  const btnNightCheckOpen = document.getElementById('btn-night-check-open');
  const btnOpenAddTask = document.getElementById('btn-open-add-task');
  const btnEmptyAddTask = document.getElementById('btn-empty-add-task');

  // Day Lock Elements (Midnight Lock)
  const dayLockContainer = document.getElementById('day-lock-container');
  const lockUnfinishedList = document.getElementById('lock-unfinished-list');
  const formDayLock = document.getElementById('form-day-lock');
  const lockReasonInput = document.getElementById('lock-reason-input');
  const lockSuccessView = document.getElementById('lock-success-view');
  const btnLockStartNewDay = document.getElementById('btn-lock-start-new-day');

  // Add Task Modal
  const modalAddTask = document.getElementById('modal-add-task');
  const modalAddTaskClose = document.getElementById('modal-add-task-close');
  const modalAddTaskCancel = document.getElementById('modal-add-task-cancel');
  const formAddTask = document.getElementById('form-add-task');
  const taskRepeatRadios = document.querySelectorAll('input[name="task-repeat"]');
  const taskSelectedDaysWrap = document.getElementById('task-selected-days-wrap');

  // Task Details Modal
  const modalTaskDetail = document.getElementById('modal-task-detail');
  const modalTaskDetailClose = document.getElementById('modal-task-detail-close');
  const btnDetailClose = document.getElementById('btn-detail-close');
  const taskDetailTitle = document.getElementById('task-detail-title');
  const detailPropDescription = document.getElementById('detail-prop-description');
  const detailPropRepeat = document.getElementById('detail-prop-repeat');
  const detailPropReminder = document.getElementById('detail-prop-reminder');
  const detailPropCreated = document.getElementById('detail-prop-created');
  const btnDetailEditTask = document.getElementById('btn-detail-edit-task');
  const btnDetailDeleteTask = document.getElementById('btn-detail-delete-task');

  // Edit Task Modal
  const modalEditTask = document.getElementById('modal-edit-task');
  const modalEditTaskClose = document.getElementById('modal-edit-task-close');
  const modalEditTaskCancel = document.getElementById('modal-edit-task-cancel');
  const formEditTask = document.getElementById('form-edit-task');
  const editTaskId = document.getElementById('edit-task-id');
  const editTaskTitle = document.getElementById('edit-task-title');
  const editTaskDescription = document.getElementById('edit-task-description');
  const editTaskReminder = document.getElementById('edit-task-reminder');
  const editTaskRepeatRadios = document.querySelectorAll('input[name="edit-task-repeat"]');
  const editSelectedDaysWrap = document.getElementById('edit-selected-days-wrap');

  // Night Check Modal
  const modalNightCheck = document.getElementById('modal-night-check');
  const modalNightClose = document.getElementById('modal-night-close');
  const btnNightClose = document.getElementById('btn-night-close');
  const nightCheckTasksList = document.getElementById('night-check-tasks-list');

  // Calendar Elements
  const calendarGrid = document.getElementById('calendar-grid');
  const calendarMonthLabel = document.getElementById('calendar-month-label');
  const calendarPrevMonth = document.getElementById('calendar-prev-month');
  const calendarNextMonth = document.getElementById('calendar-next-month');
  const calendarDayDetail = document.getElementById('calendar-day-detail');
  const calendarDayDetailClose = document.getElementById('calendar-day-detail-close');
  const dayDetailDate = document.getElementById('day-detail-date');
  const dayDetailRatio = document.getElementById('day-detail-ratio');
  const dayDetailTasks = document.getElementById('day-detail-tasks');
  const dayDetailReflectionBox = document.getElementById('day-detail-reflection-box');
  const dayDetailReflectionText = document.getElementById('day-detail-reflection-text');

  // Archive / Past Reflections Elements
  const archiveSearchInput = document.getElementById('archive-search-input');
  const archiveLoading = document.getElementById('archive-loading');
  const archiveEmpty = document.getElementById('archive-empty');
  const archiveList = document.getElementById('archive-list');

  // Settings Elements
  const settingsForm = document.getElementById('settings-form');
  const settingAccountabilityTime = document.getElementById('setting-accountability-time');
  const settingDailyReset = document.getElementById('setting-daily-reset');
  const settingUsername = document.getElementById('setting-username');
  const settingNotifications = document.getElementById('setting-notifications');
  const settingTheme = document.getElementById('setting-theme');
  const settingsStatusMsg = document.getElementById('settings-status-msg');

  // ==========================================
  // Initialization
  // ==========================================
  initTheme();
  initNavigation();
  initModals();
  initFormListeners();
  loadTodayData();

  // ==========================================
  // Theme Management
  // ==========================================
  function initTheme() {
    const savedTheme = localStorage.getItem('honest_theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);
    if (settingTheme) settingTheme.value = savedTheme;

    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const nextTheme = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', nextTheme);
      localStorage.setItem('honest_theme', nextTheme);
      if (settingTheme) settingTheme.value = nextTheme;
    });
  }

  // ==========================================
  // Error Banner
  // ==========================================
  function showError(msg) {
    errorText.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideError() {
    errorBanner.classList.add('hidden');
  }

  errorDismissBtn.addEventListener('click', hideError);
  errorRetryBtn.addEventListener('click', () => {
    hideError();
    loadCurrentViewData();
  });

  notificationClose.addEventListener('click', () => {
    globalNotification.classList.add('hidden');
  });

  notificationViewUnfinished.addEventListener('click', openNightCheckModal);

  // ==========================================
  // Navigation
  // ==========================================
  function initNavigation() {
    navTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const targetView = tab.getAttribute('data-view');
        switchView(targetView);
      });
    });
  }

  function switchView(viewId) {
    currentView = viewId;
    navTabs.forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('data-view') === viewId);
    });
    viewPanels.forEach(panel => {
      panel.classList.toggle('active', panel.id === viewId);
    });

    loadCurrentViewData();
  }

  function loadCurrentViewData() {
    switch (currentView) {
      case 'view-today':
        loadTodayData();
        break;
      case 'view-calendar':
        loadCalendarData(calendarMonth, calendarYear);
        break;
      case 'view-archive':
        loadArchive();
        break;
      case 'view-settings':
        loadSettings();
        break;
    }
  }

  // ==========================================
  // VIEW 1: TODAY (HOME / DASHBOARD)
  // ==========================================
  async function loadTodayData() {
    tasksLoading.classList.remove('hidden');
    taskList.innerHTML = '';
    tasksEmpty.classList.add('hidden');

    try {
      todayState = await ApiService.getTodayState();
      renderTodayHeader(todayState);

      // Handle Midnight / Day Lock: if previous day is unresolved, lock dashboard
      if (todayState.hasUnresolvedYesterday) {
        showDayLockScreen(todayState);
      } else {
        hideDayLockScreen();
        renderTasks(todayState.tasks || []);
        evaluateNightCheck(todayState);
      }
    } catch (err) {
      showError('Unable to load today\'s tasks: ' + err.message);
    } finally {
      tasksLoading.classList.add('hidden');
    }
  }

  function renderTodayHeader(state) {
    todayDateDisplay.textContent = formatHumanDate(state.date) || state.dateLabel || state.date || 'Today';
    honestDaysNumber.textContent = state.honestDays ?? 0;

    const tasks = state.tasks || [];
    const completed = tasks.filter(t => t.completed).length;
    todayCompletionCount.textContent = `${completed} / ${tasks.length} completed`;
  }

  function renderTasks(tasks) {
    taskList.innerHTML = '';
    const total = tasks.length;
    const completed = tasks.filter(t => t.completed).length;
    todayCompletionCount.textContent = `${completed} / ${total} completed`;

    if (total === 0) {
      tasksEmpty.classList.remove('hidden');
      return;
    }
    tasksEmpty.classList.add('hidden');

    tasks.forEach(task => {
      const li = document.createElement('li');
      li.className = `task-item ${task.completed ? 'completed' : ''}`;
      li.setAttribute('data-id', task.id);

      const repeatLabel = task.repeat === 'daily' ? 'Every day' : task.repeat === 'selected' ? 'Specific days' : 'One time';
      const descHtml = task.definition ? `<div class="task-desc">${escapeHtml(task.definition)}</div>` : '';
      const reminderHtml = task.reminder ? `<span class="task-meta-tag">⏰ ${escapeHtml(task.reminder)}</span>` : '';

      li.innerHTML = `
        <div class="task-clickable-body" title="Click to view details or edit">
          <div class="task-title">${escapeHtml(task.title || task.name)}</div>
          ${descHtml}
          <div class="task-meta-line">
            <span class="task-meta-tag">${repeatLabel}</span>
            ${reminderHtml}
          </div>
        </div>
        <div class="task-toggle-wrapper">
          <span class="toggle-state-badge">${task.completed ? 'ON' : 'OFF'}</span>
          <label class="task-switch" title="Toggle ON/OFF">
            <input type="checkbox" ${task.completed ? 'checked' : ''} aria-label="Toggle completion">
            <span class="task-slider"></span>
          </label>
        </div>
      `;

      // 1. Click task body -> Open Task Detail Modal
      const clickableBody = li.querySelector('.task-clickable-body');
      clickableBody.addEventListener('click', () => {
        openTaskDetailModal(task);
      });

      // 2. Toggle ON / OFF Switch
      const toggleInput = li.querySelector('.task-switch input');
      const stateBadge = li.querySelector('.toggle-state-badge');

      toggleInput.addEventListener('change', async (e) => {
        const isNowCompleted = e.target.checked;
        stateBadge.textContent = isNowCompleted ? 'ON' : 'OFF';
        li.classList.toggle('completed', isNowCompleted);
        task.completed = isNowCompleted;

        // Update counts immediately
        const newCompleted = tasks.filter(t => t.completed).length;
        todayCompletionCount.textContent = `${newCompleted} / ${tasks.length} completed`;

        try {
          if (isNowCompleted) {
            await ApiService.completeTask(task.id);
          } else {
            await ApiService.uncompleteTask(task.id);
          }
          evaluateNightCheck(todayState);
        } catch (err) {
          // Revert on error
          e.target.checked = !isNowCompleted;
          stateBadge.textContent = !isNowCompleted ? 'ON' : 'OFF';
          li.classList.toggle('completed', !isNowCompleted);
          task.completed = !isNowCompleted;
          showError('Failed to update task toggle: ' + err.message);
        }
      });

      taskList.appendChild(li);
    });
  }

  function evaluateNightCheck(state) {
    const tasks = state.tasks || [];
    const incomplete = tasks.filter(t => !t.completed);

    if (state.nightCheckActive && incomplete.length > 0) {
      nightCheckPromptBanner.classList.remove('hidden');
      nightCheckPromptText.textContent = `You still have ${incomplete.length} unfinished ${incomplete.length === 1 ? 'task' : 'tasks'} today.`;
      globalNotification.classList.remove('hidden');
    } else {
      nightCheckPromptBanner.classList.add('hidden');
      globalNotification.classList.add('hidden');
    }
  }

  // ==========================================
  // MIDNIGHT / DAY LOCK SCREEN
  // ==========================================
  function showDayLockScreen(state) {
    dayLockContainer.classList.remove('hidden');
    tasksContainerWrap.classList.add('hidden');

    lockUnfinishedList.innerHTML = '';
    const unfinished = state.unresolvedYesterdayTasks || [];
    if (unfinished.length === 0) {
      const li = document.createElement('li');
      li.className = 'lock-task-item';
      li.textContent = '❌ Unfinished promises from yesterday';
      lockUnfinishedList.appendChild(li);
    } else {
      unfinished.forEach(t => {
        const li = document.createElement('li');
        li.className = 'lock-task-item';
        li.textContent = `❌ ${t.title || t.name}`;
        lockUnfinishedList.appendChild(li);
      });
    }

    formDayLock.classList.remove('hidden');
    lockSuccessView.classList.add('hidden');
    lockReasonInput.value = '';
  }

  function hideDayLockScreen() {
    dayLockContainer.classList.add('hidden');
    tasksContainerWrap.classList.remove('hidden');
  }

  formDayLock.addEventListener('submit', async (e) => {
    e.preventDefault();
    const reason = lockReasonInput.value.trim();
    if (!reason) return;

    try {
      await ApiService.submitReflection({ reason });
      formDayLock.classList.add('hidden');
      lockSuccessView.classList.remove('hidden');
    } catch (err) {
      showError('Failed to record reflection: ' + err.message);
    }
  });

  btnLockStartNewDay.addEventListener('click', () => {
    hideDayLockScreen();
    loadTodayData();
  });

  // ==========================================
  // TASK DETAIL & EDIT MODALS
  // ==========================================
  function openTaskDetailModal(task) {
    selectedTask = task;
    taskDetailTitle.textContent = task.title || task.name;
    detailPropDescription.textContent = task.definition || 'None';
    detailPropRepeat.textContent = task.repeat === 'daily' ? 'Every day' : task.repeat === 'selected' ? 'Specific days' : 'One time';
    detailPropReminder.textContent = task.reminder || 'None';
    detailPropCreated.textContent = task.startDate || task.createdDate || task.date || 'Today';

    openModal(modalTaskDetail);
  }

  btnDetailClose.addEventListener('click', () => closeModal(modalTaskDetail));
  modalTaskDetailClose.addEventListener('click', () => closeModal(modalTaskDetail));

  btnDetailDeleteTask.addEventListener('click', async () => {
    if (!selectedTask) return;
    if (!confirm(`Delete task "${selectedTask.title || selectedTask.name}"?`)) return;

    try {
      await ApiService.deleteTask(selectedTask.id);
      closeModal(modalTaskDetail);
      loadTodayData();
    } catch (err) {
      showError('Failed to delete task: ' + err.message);
    }
  });

  btnDetailEditTask.addEventListener('click', () => {
    if (!selectedTask) return;
    closeModal(modalTaskDetail);

    // Prefill Edit Modal
    editTaskId.value = selectedTask.id;
    editTaskTitle.value = selectedTask.title || selectedTask.name;
    editTaskDescription.value = selectedTask.definition || '';
    editTaskReminder.value = selectedTask.reminder || '';

    const repeatVal = selectedTask.repeat || 'daily';
    const matchingRadio = document.querySelector(`input[name="edit-task-repeat"][value="${repeatVal}"]`);
    if (matchingRadio) matchingRadio.checked = true;

    editSelectedDaysWrap.classList.toggle('hidden', repeatVal !== 'selected');
    if (repeatVal === 'selected' && Array.isArray(selectedTask.selectedDays)) {
      document.querySelectorAll('input[name="edit-selected-day"]').forEach(cb => {
        cb.checked = selectedTask.selectedDays.includes(parseInt(cb.value, 10));
      });
    }

    openModal(modalEditTask);
  });

  modalEditTaskClose.addEventListener('click', () => closeModal(modalEditTask));
  modalEditTaskCancel.addEventListener('click', () => closeModal(modalEditTask));

  editTaskRepeatRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      editSelectedDaysWrap.classList.toggle('hidden', radio.value !== 'selected');
    });
  });

  formEditTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = editTaskId.value;
    const title = editTaskTitle.value.trim();
    const description = editTaskDescription.value.trim();
    const reminder = editTaskReminder.value || null;
    const repeatRadio = document.querySelector('input[name="edit-task-repeat"]:checked');
    const repeat = repeatRadio ? repeatRadio.value : 'daily';

    let selectedDays = [];
    if (repeat === 'selected') {
      const checkedBoxes = document.querySelectorAll('input[name="edit-selected-day"]:checked');
      selectedDays = Array.from(checkedBoxes).map(cb => parseInt(cb.value, 10));
    }

    const payload = {
      title,
      definition: description || null,
      repeat,
      selectedDays,
      reminder
    };

    try {
      await ApiService.updateTask(id, payload);
      closeModal(modalEditTask);
      loadTodayData();
    } catch (err) {
      showError('Failed to update task: ' + err.message);
    }
  });

  // ==========================================
  // ADD TASK MODAL
  // ==========================================
  btnOpenAddTask.addEventListener('click', () => openModal(modalAddTask));
  btnEmptyAddTask.addEventListener('click', () => openModal(modalAddTask));
  modalAddTaskClose.addEventListener('click', () => closeModal(modalAddTask));
  modalAddTaskCancel.addEventListener('click', () => closeModal(modalAddTask));

  taskRepeatRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      taskSelectedDaysWrap.classList.toggle('hidden', radio.value !== 'selected');
    });
  });

  formAddTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-input-title').value.trim();
    const description = document.getElementById('task-input-description').value.trim();
    const reminder = document.getElementById('task-input-reminder').value || null;
    const repeatRadio = document.querySelector('input[name="task-repeat"]:checked');
    const repeat = repeatRadio ? repeatRadio.value : 'daily';

    let selectedDays = [];
    if (repeat === 'selected') {
      const checkedBoxes = document.querySelectorAll('input[name="selected-day"]:checked');
      selectedDays = Array.from(checkedBoxes).map(cb => parseInt(cb.value, 10));
    }

    const payload = {
      title,
      definition: description || 'Complete as intended',
      repeat,
      selectedDays,
      reminder,
      category: 'General',
      accountabilityTime: '22:30'
    };

    try {
      await ApiService.createTask(payload);
      closeModal(modalAddTask);
      formAddTask.reset();
      taskSelectedDaysWrap.classList.add('hidden');
      loadTodayData();
    } catch (err) {
      showError('Could not save task: ' + err.message);
    }
  });

  // ==========================================
  // NIGHT CHECK MODAL (UNFINISHED TASKS)
  // ==========================================
  btnNightCheckOpen.addEventListener('click', openNightCheckModal);
  modalNightClose.addEventListener('click', () => closeModal(modalNightCheck));
  btnNightClose.addEventListener('click', () => closeModal(modalNightCheck));

  async function openNightCheckModal() {
    try {
      const data = await ApiService.getNightCheckState();
      const unfinished = data.unfinishedTasks || data.data?.unfinishedTasks || [];

      nightCheckTasksList.innerHTML = '';
      if (unfinished.length === 0) {
        const li = document.createElement('li');
        li.className = 'night-check-row';
        li.textContent = 'All tasks completed for today!';
        nightCheckTasksList.appendChild(li);
      } else {
        unfinished.forEach(t => {
          const li = document.createElement('li');
          li.className = 'night-check-row';
          li.innerHTML = `
            <span class="night-task-name">❌ ${escapeHtml(t.title || t.name)}</span>
            <button class="btn-complete-task" data-id="${t.id || t.taskId}">Complete</button>
          `;

          const completeBtn = li.querySelector('.btn-complete-task');
          completeBtn.addEventListener('click', async () => {
            try {
              await ApiService.completeTask(t.id || t.taskId);
              li.remove();
              loadTodayData();
              if (nightCheckTasksList.children.length === 0) {
                closeModal(modalNightCheck);
              }
            } catch (err) {
              showError('Failed to complete task: ' + err.message);
            }
          });

          nightCheckTasksList.appendChild(li);
        });
      }

      openModal(modalNightCheck);
    } catch (err) {
      showError('Failed to load unfinished tasks: ' + err.message);
    }
  }

  // ==========================================
  // VIEW 2: CALENDAR
  // ==========================================
  async function loadCalendarData(month, year) {
    calendarMonthLabel.textContent = getMonthName(month) + ' ' + year;
    calendarGrid.innerHTML = '';
    calendarDayDetail.classList.add('hidden');

    try {
      const data = await ApiService.getCalendarMonth(month, year);
      const historyMap = data.history || data.data?.history || {};
      renderCalendarGrid(month, year, historyMap);
    } catch (err) {
      showError('Failed to load calendar: ' + err.message);
    }
  }

  function renderCalendarGrid(month, year, historyMap) {
    calendarGrid.innerHTML = '';
    const firstDay = new Date(year, month - 1, 1);
    const lastDay = new Date(year, month, 0);
    const daysInMonth = lastDay.getDate();

    let startDayOfWeek = (firstDay.getDay() + 6) % 7; // Mon = 0
    const prevMonthDays = new Date(year, month - 1, 0).getDate();

    // Leading padding
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const cell = document.createElement('div');
      cell.className = 'calendar-day-cell other-month';
      cell.textContent = prevMonthDays - i;
      calendarGrid.appendChild(cell);
    }

    const today = new Date();
    const isCurrentMonthYear = (today.getFullYear() === year && today.getMonth() + 1 === month);

    for (let day = 1; day <= daysInMonth; day++) {
      const dateString = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const dayData = historyMap[dateString];

      const cell = document.createElement('div');
      cell.className = 'calendar-day-cell';
      if (isCurrentMonthYear && today.getDate() === day) {
        cell.classList.add('is-today');
      }

      cell.innerHTML = `<span>${day}</span>`;

      if (dayData) {
        const dot = document.createElement('span');
        dot.className = 'day-status-indicator';
        if (dayData.status === 'completed') dot.classList.add('dot-completed');
        else if (dayData.status === 'explained') dot.classList.add('dot-explained');
        else if (dayData.status === 'unresolved') dot.classList.add('dot-unresolved');
        cell.appendChild(dot);
      }

      cell.addEventListener('click', () => {
        showDayDetails(dateString);
      });

      calendarGrid.appendChild(cell);
    }
  }

  async function showDayDetails(dateString) {
    try {
      const details = await ApiService.getCalendarDay(dateString);
      calendarDayDetail.classList.remove('hidden');

      const dateObj = new Date(dateString);
      dayDetailDate.textContent = `${dateObj.getDate()} ${getMonthName(dateObj.getMonth() + 1)}`;
      dayDetailRatio.textContent = `${details.completed || 0} / ${details.total || 0} completed`;

      dayDetailTasks.innerHTML = '';
      (details.tasks || details.items || []).forEach(t => {
        const row = document.createElement('li');
        row.className = 'history-task-row';
        row.innerHTML = `
          <span>${escapeHtml(t.title || t.name)}</span>
          <span class="${t.completed ? 'text-accent' : 'text-danger'}">${t.completed ? '✅ Completed' : '❌ Missed'}</span>
        `;
        dayDetailTasks.appendChild(row);
      });

      if (details.reflection) {
        dayDetailReflectionBox.classList.remove('hidden');
        dayDetailReflectionText.textContent = `"${details.reflection}"`;
      } else {
        dayDetailReflectionBox.classList.add('hidden');
      }

      calendarDayDetail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      showError('Failed to load day details: ' + err.message);
    }
  }

  calendarDayDetailClose.addEventListener('click', () => {
    calendarDayDetail.classList.add('hidden');
  });

  calendarPrevMonth.addEventListener('click', () => {
    calendarMonth--;
    if (calendarMonth < 1) {
      calendarMonth = 12;
      calendarYear--;
    }
    loadCalendarData(calendarMonth, calendarYear);
  });

  calendarNextMonth.addEventListener('click', () => {
    calendarMonth++;
    if (calendarMonth > 12) {
      calendarMonth = 1;
      calendarYear++;
    }
    loadCalendarData(calendarMonth, calendarYear);
  });

  // ==========================================
  // VIEW 3: PAST REFLECTIONS (HISTORY)
  // ==========================================
  async function loadArchive(query = '') {
    archiveLoading.classList.remove('hidden');
    archiveEmpty.classList.add('hidden');
    archiveList.innerHTML = '';

    try {
      const data = await ApiService.getArchive(query);
      const reflections = data.reflections || data.items || [];

      if (reflections.length === 0) {
        archiveEmpty.classList.remove('hidden');
        return;
      }

      reflections.forEach(item => {
        const card = document.createElement('div');
        card.className = 'archive-card';
        card.innerHTML = `
          <div class="archive-meta">
            <span class="archive-date">${escapeHtml(item.date)}</span>
            <span class="archive-task-name">${escapeHtml(item.taskName || 'Missed Commitment')}</span>
          </div>
          <div class="archive-reason">"${escapeHtml(item.reason)}"</div>
        `;
        archiveList.appendChild(card);
      });
    } catch (err) {
      showError('Failed to load reflections: ' + err.message);
    } finally {
      archiveLoading.classList.add('hidden');
    }
  }

  archiveSearchInput.addEventListener('input', (e) => {
    loadArchive(e.target.value.trim());
  });

  // ==========================================
  // VIEW 4: SETTINGS
  // ==========================================
  async function loadSettings() {
    try {
      const s = await ApiService.getSettings();
      if (s.accountabilityTime) settingAccountabilityTime.value = s.accountabilityTime;
      if (s.dailyReset) settingDailyReset.value = s.dailyReset;
      if (s.notifications !== undefined) settingNotifications.checked = s.notifications;
      if (s.theme) settingTheme.value = s.theme;

      const savedUser = localStorage.getItem('honest_username') || 'Student';
      settingUsername.value = savedUser;
    } catch (err) {
      showError('Failed to load settings: ' + err.message);
    }
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    settingsStatusMsg.textContent = 'Saving...';

    localStorage.setItem('honest_username', settingUsername.value.trim() || 'Student');

    const payload = {
      accountabilityTime: settingAccountabilityTime.value,
      dailyReset: settingDailyReset.value,
      notifications: settingNotifications.checked,
      theme: settingTheme.value
    };

    try {
      await ApiService.updateSettings(payload);
      settingsStatusMsg.textContent = 'Settings saved.';
      setTimeout(() => { settingsStatusMsg.textContent = ''; }, 3000);
    } catch (err) {
      showError('Failed to save settings: ' + err.message);
      settingsStatusMsg.textContent = '';
    }
  });

  // ==========================================
  // Modal Utilities
  // ==========================================
  function initModals() {
    // Backdrop click closes modal
    document.querySelectorAll('.modal-backdrop').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
      });
    });
  }

  function openModal(modalEl) {
    modalEl.classList.remove('hidden');
  }

  function closeModal(modalEl) {
    modalEl.classList.add('hidden');
  }

  function initFormListeners() {}

  // ==========================================
  // General Helpers
  // ==========================================
  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getMonthName(m) {
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return months[m - 1] || '';
  }

  function formatHumanDate(dateStr) {
    if (!dateStr) return '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    const [y, m, d] = dateStr.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return `${days[date.getDay()]} - ${d} ${months[date.getMonth()]}`;
  }
});
