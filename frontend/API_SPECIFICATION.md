# HONEST - API Specification & Contract

This document specifies the exact REST API contract expected by the HONEST frontend application (`E:\APPP\frontend`).

The backend implementations (`backend-1`, `backend-2`, `backend-3`) should implement these endpoints with JSON responses.

---

## Base URL
By default, the frontend requests `http://localhost:3000/api` (configurable in app settings).

---

## 1. Today State
### `GET /api/today`
Returns the status of today's promises, off day status, and pending accountability events.

**Response Status:** `200 OK`
```json
{
  "date": "Monday - 5 October",
  "isoDate": "2026-10-05",
  "honestDays": 12,
  "isOffDay": false,
  "offDayReason": null,
  "nightCheckActive": false,
  "hasUnresolvedYesterday": false,
  "tasks": [
    {
      "id": "t1",
      "title": "2 hrs Coding",
      "definition": "At least 45 minutes focused session",
      "category": "DSA",
      "completed": false,
      "accountabilityTime": "22:30"
    }
  ]
}
```

---

## 2. Tasks & Promises
### `POST /api/tasks`
Creates a new promise.

**Request Body:**
```json
{
  "title": "Study Physics",
  "definition": "At least 45 minutes without phone",
  "category": "Study",
  "repeat": "daily",
  "selectedDays": [1, 2, 3, 4, 5],
  "reminder": "20:00",
  "accountabilityTime": "22:30"
}
```
**Response Status:** `201 Created` / `200 OK`
```json
{
  "id": "task_101",
  "title": "Study Physics",
  "definition": "At least 45 minutes without phone",
  "category": "Study",
  "completed": false,
  "accountabilityTime": "22:30"
}
```

### `PUT /api/tasks/:id/complete`
Marks a task as completed ("I actually did this").

**Response Status:** `200 OK`
```json
{
  "success": true,
  "task": {
    "id": "t1",
    "completed": true
  }
}
```

### `PUT /api/tasks/:id/uncomplete`
Unmarks a task's completed state.

**Response Status:** `200 OK`
```json
{
  "success": true,
  "task": {
    "id": "t1",
    "completed": false
  }
}
```

### `DELETE /api/tasks/:id`
Deletes a task.

**Response Status:** `200 OK`
```json
{
  "success": true
}
```

---

## 3. Night Check & Midnight Reflection
### `GET /api/night-check`
Returns status for today's evening check.

**Response Status:** `200 OK`
```json
{
  "active": true,
  "accountabilityTime": "22:30",
  "unfinishedTasks": [
    {
      "id": "t1",
      "title": "2 hrs Coding",
      "definition": "At least 45 minutes"
    }
  ]
}
```

### `POST /api/night-check/reflect`
Submits an honest reflection for missed commitments.

**Request Body:**
```json
{
  "reason": "Had a college event and returned late."
}
```
**Response Status:** `200 OK`
```json
{
  "success": true,
  "message": "Reason recorded."
}
```

---

## 4. Calendar History
### `GET /api/calendar?month=10&year=2026`
Returns summary status for days in the requested month.

**Response Status:** `200 OK`
```json
{
  "month": "October 2026",
  "history": {
    "2026-10-01": { "status": "explained", "completed": 3, "total": 4 },
    "2026-10-02": { "status": "completed", "completed": 5, "total": 5 },
    "2026-10-03": { "status": "explained", "completed": 4, "total": 5 },
    "2026-10-04": { "status": "unresolved", "completed": 1, "total": 4 },
    "2026-10-05": { "status": "active", "completed": 2, "total": 5 }
  }
}
```

### `GET /api/calendar/day/:date`
Returns task breakdown and recorded reflection for a specific date (YYYY-MM-DD).

**Response Status:** `200 OK`
```json
{
  "date": "2026-10-03",
  "completed": 4,
  "total": 5,
  "tasks": [
    { "title": "Coding", "completed": true },
    { "title": "DSA", "completed": true },
    { "title": "Workout", "completed": true },
    { "title": "Reading", "completed": true },
    { "title": "Revision", "completed": false }
  ],
  "reflection": "Had a college event and returned late."
}
```

---

## 5. Weekly Report
### `GET /api/report/weekly`
Returns 7-day summary metrics and backend-generated behavioral insight.

**Response Status:** `200 OK`
```json
{
  "completedCount": 31,
  "totalCount": 37,
  "completionRate": 83.7,
  "mostConsistent": "Coding (100%)",
  "mostSkipped": "Workout (57%)",
  "commonReason": "Too tired / got late",
  "insight": "You don't need more motivation. You may need a better schedule."
}
```

---

## 6. Honest Archive & Search
### `GET /api/archive?q=tired`
Returns historical reflections with optional keyword filter, and pattern notices.

**Response Status:** `200 OK`
```json
{
  "patternNotice": "You've used 'too tired' 8 times this month.",
  "reflections": [
    {
      "id": "r1",
      "date": "October 3, 2026",
      "taskName": "Revision",
      "reason": "Had a college event and returned late."
    }
  ]
}
```

---

## 7. Honest Score & Behavioral Patterns
### `GET /api/stats/score`
**Response Status:** `200 OK`
```json
{
  "honestyScore": 84,
  "month": "October 2026",
  "promisesMade": 142,
  "completed": 119,
  "missed": 23,
  "explained": 23,
  "unexplained": 0
}
```

### `GET /api/insights`
**Response Status:** `200 OK`
```json
{
  "patterns": [
    {
      "lead": "Time-of-day discrepancy",
      "content": "You complete coding tasks 91% of the time when scheduled before 7 PM, but only 54% when scheduled after 9 PM."
    },
    {
      "lead": "Day-of-week pattern",
      "content": "You frequently miss tasks on Thursdays."
    }
  ]
}
```

---

## 8. Off Day
### `POST /api/off-day`
Requests activation of an off day.

**Request Body:**
```json
{
  "reason": "Sick"
}
```
- If allowed: `200 OK` with `{ "success": true, "reason": "Sick" }`
- If deadline passed: `400 Bad Request` or `403 Forbidden` with:
```json
{
  "message": "An off day can no longer be activated for yesterday."
}
```

---

## 9. Settings
### `GET /api/settings`
**Response Status:** `200 OK`
```json
{
  "accountabilityTime": "22:30",
  "dailyReset": "00:00",
  "gracePeriod": 15,
  "weekStart": "monday",
  "notifications": true,
  "theme": "dark"
}
```

### `PUT /api/settings`
**Request Body:** Partial or complete settings object.
**Response Status:** `200 OK`
```json
{
  "success": true,
  "settings": { ... }
}
```

---

## 10. Proactive Notifications
### `GET /api/notifications`
Returns active time-based notification messages determined by the backend scheduler.

**Response Status:** `200 OK`
```json
{
  "notifications": [
    {
      "id": "n1",
      "message": "Be honest with yourself. You still have 3 unfinished promises today."
    }
  ]
}
```
