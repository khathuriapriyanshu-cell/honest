# HONEST - Backend 2 (KBAI)

> **"BE HONEST WITH YOURSELF."**  
> *Plan -> Promise -> Do -> Admit -> Reflect -> Start Again*

Production-grade, zero-mock, persistent REST API backend for the HONEST accountability platform.

---

## 1. Project Structure & Files Created
Inside `E:\APPP\backend-2` (also accessible via junction `E:\APPP\backend 2`):

- [**`server.js`**](file:///E:/APPP/backend-2/server.js) - Express application entry point with CORS, JSON body parsers, health check, route mounting, and centralized error handling.
- [**`database.js`**](file:///E:/APPP/backend-2/database.js) - SQLite persistence layer using Node.js native `node:sqlite` (`DatabaseSync`). Auto-initializes schema, foreign keys, and WAL journal mode.
- [**`services/timeService.js`**](file:///E:/APPP/backend-2/services/timeService.js) - Authoritative backend time engine. Manages timezone resolutions, date conversions ("Monday - 5 October"), accountability windows, and off-day cutoff checks.
- [**`services/accountabilityService.js`**](file:///E:/APPP/backend-2/services/accountabilityService.js) - Business logic engine: recurring task resolution, completion toggles, night check, unresolved yesterday closures, deterministic Honest Days and Honest Score calculations, weekly reports, and archive search.
- [**`routes/apiRoutes.js`**](file:///E:/APPP/backend-2/routes/apiRoutes.js) - Full REST API endpoint definitions with input validation and HTTP status codes.
- [**`test.js`**](file:///E:/APPP/backend-2/test.js) - Automated 27-point test suite verifying persistence, recurrence logic, retroactive off-day rejections, and report calculations.
- [**`package.json`**](file:///E:/APPP/backend-2/package.json) - Node.js configuration declaring minimal dependencies (`express`, `cors`).

---

## 2. SQLite Database Schema
The database is persisted in `honest.db`:

```sql
-- Settings
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Promises / Tasks
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  repeat_type TEXT NOT NULL, -- 'once', 'daily', 'selected'
  selected_days TEXT,        -- JSON array e.g. '[1,2,3,4,5]'
  reminder_time TEXT,        -- 'HH:MM'
  accountability_time TEXT NOT NULL DEFAULT '22:30',
  minimum_completion_definition TEXT NOT NULL,
  created_date TEXT NOT NULL, -- 'YYYY-MM-DD'
  created_at TEXT NOT NULL,   -- ISO timestamp
  is_active INTEGER NOT NULL DEFAULT 1
);

-- Task Daily Completions
CREATE TABLE task_completions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  date TEXT NOT NULL,        -- 'YYYY-MM-DD'
  completed INTEGER NOT NULL DEFAULT 1,
  completed_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(task_id, date)
);

-- Reflections (Honest Reasons)
CREATE TABLE reflections (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,        -- 'YYYY-MM-DD'
  task_name TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Off Days / No Excuse Days
CREATE TABLE off_days (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE, -- 'YYYY-MM-DD'
  reason TEXT NOT NULL,
  declared_at TEXT NOT NULL
);
```

---

## 3. How to Start the Backend

### Installation (Already performed):
```powershell
cd E:\APPP\backend-2
npm install
```

### Running the Server:
```powershell
npm start
# or: node server.js
```
The server will start on `http://localhost:3000` (API root: `http://localhost:3000/api`).

### Running Automated Verification Tests:
```powershell
npm test
# or: node test.js
```

---

## 4. REST API Endpoints Summary

| Method | URL | Description |
| :--- | :--- | :--- |
| `GET` | `/api/today` | Authoritative today's date, tasks, night check state, off day, Honest Days |
| `POST` | `/api/tasks` | Create promise (one-time, daily, selected days) with minimum completion definition |
| `PUT` | `/api/tasks/:id/complete` | Record completion ("I actually did this") |
| `PUT` | `/api/tasks/:id/uncomplete` | Revert task completion |
| `DELETE` | `/api/tasks/:id` | Remove task (preserves historical completions via soft-delete if history exists) |
| `GET` | `/api/night-check` | Retrieve active night check state and unfinished tasks |
| `POST` | `/api/night-check/reflect` | Submit honest reflection for missed commitments |
| `GET` | `/api/calendar` | Monthly status map (`completed`, `explained`, `unresolved`, `offday`) |
| `GET` | `/api/calendar/day/:date` | Specific day breakdown and recorded reflection |
| `GET` | `/api/report/weekly` | 7-day completion rate, consistency, and intelligent schedule insight |
| `GET` | `/api/archive` | Search reflection history & detect recurring excuse patterns |
| `GET` | `/api/stats/score` | Monthly stats & deterministic Honesty Score (0-100) |
| `GET` | `/api/insights` | Behavioral pattern observations (time-of-day, day-of-week) |
| `POST` | `/api/off-day` | Declare off day (enforces strict pre-deadline cutoff) |
| `GET` / `PUT` | `/api/settings` | Retrieve and update user preferences and accountability timing |
| `GET` | `/api/notifications` | Scheduled time-based prompts |

---

## 5. Important Business Rules Implemented
1. **No Shaming**: Language is neutral, objective, and mature.
2. **Authoritative Dates**: All date evaluations use the configured timezone, never trusting client clock.
3. **Off-Day Cutoff Rule**: An off day cannot be activated retroactively for past dates or after 10:30 PM on the current day. Returns HTTP 400.
4. **Honest Days**: A day qualifies if all tasks were completed OR any missed tasks were honestly explained with a reflection OR it was an off day.
5. **Deterministic Honesty Score**:
   ```
   CompletionRatio = completed / promisesMade
   HonestyRatio = missed === 0 ? 1 : explained / missed
   Penalty = unexplained > 0 ? 15 * (unexplained / promisesMade) : 0
   HonestyScore = Math.round(60 * CompletionRatio + 40 * HonestyRatio - Penalty)
   ```
6. **No Fake Data**: When the database is clean, real empty states are returned.
