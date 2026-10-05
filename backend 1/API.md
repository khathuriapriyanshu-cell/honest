# HONEST — Backend API Documentation

Base URL: `http://localhost:3000/api`

Two endpoint families live side by side:

- **Canonical** — designed for this backend (envelope below, rich data).
- **Frontend aliases** — same logic, flat top-level projection matching
  `E:\APPP\frontend\API_SPECIFICATION.md` (`/today`, `/night-check`,
  `/off-day`, `/report/weekly`, `/stats/score`, `/archive`, `/insights`,
  `/notifications`, `/calendar?month=&year=`, `/calendar/day/:date`).

Every success response carries the full payload under `data` and (for
endpoints the bundled frontend calls) a flat projection at the top level:

```json
{ "success": true, "data": { ... }, "...flat keys": "..." }
```

Every error response:

```json
{
  "success": false,
  "error": { "code": "ERROR_CODE", "message": "Human readable message" },
  "message": "Human readable message (duplicate for the bundled frontend)"
}
```

Validation errors add `"details": [{ "field": "...", "message": "..." }]`.

The backend is the source of truth for time: every date-sensitive response is
computed from the server clock + the timezone setting. Browser time is never
trusted. A day D spans `[daily reset on D, daily reset on D+1)` in the user
timezone.

## Endpoint index

| Method | URL | Purpose |
|---|---|---|
| GET | `/health` | Liveness + server time |
| GET | `/time` | Authoritative now/date/phase/deadlines |
| GET | `/today` | Today's full state (frontend: today screen) |
| GET | `/today/tasks` | Today's occurrences only |
| GET | `/today/summary` | Compact counts + yesterday + messages |
| GET/POST | `/tasks` | List / create promises |
| GET/PATCH/DELETE | `/tasks/:id` | Detail / update / deactivate (soft) |
| POST | `/tasks/:id/restore` | Reactivate a deactivated task |
| PUT/POST | `/tasks/:id/complete` | Mark done (today, while open) |
| PUT/POST | `/tasks/:id/uncomplete` | Undo a completion |
| GET | `/calendar?from=&to=` | Range summaries (canonical) |
| GET | `/calendar?month=10&year=2026` | Month map (frontend) |
| GET | `/calendar/:date`, `/calendar/day/:date` | One day, full / flat |
| GET/POST | `/reflections` | List / submit reflections |
| DELETE | `/reflections/:id` | Delete a reflection |
| GET | `/night-check` | Accountability check (frontend) |
| POST | `/night-check/reflect` | Reflect flow (frontend) |
| GET/POST | `/off-days` | List / activate off day (explicit date) |
| DELETE | `/off-days/:id` | Remove an off day (before deadline) |
| POST/DELETE | `/off-day` | Frontend alias (activates today) |
| GET | `/reports/weekly`, `/report/weekly` | Weekly honesty report |
| GET | `/honesty/score?window=30d\|month\|all` | Honest Score + breakdown |
| GET | `/honesty/days?month=YYYY-MM` or `from/to` | Honest Days (streaks) |
| GET | `/stats/score` | Frontend alias of honesty score (month) |
| GET | `/insights` | Behavioral patterns (from real data) |
| GET | `/archive?q=` | Searchable reflection archive |
| GET/PUT/PATCH | `/settings` | Read / update settings |
| GET | `/accountability/state` | Phase machine state |
| GET | `/accountability/events` | Durable accountability event log |
| GET | `/notifications` | Active time-based messages |

## Core endpoints

### GET /today

The today screen in one call. Phase is one of
`open | accountability | grace_ended | final_warning`.

```json
{
  "success": true,
  "data": {
    "now": "2026-10-05T16:33:20.860Z",
    "timezone": "Asia/Calcutta",
    "todayDate": "2026-10-05",
    "localTime": "22:03",
    "phase": "open",
    "deadlines": {
      "accountabilityAt": "...", "graceEndAt": "...",
      "finalWarningAt": "...", "resetAt": "..."
    },
    "offDay": null,
    "offDayWindow": { "canActivateToday": true, "deadlineAt": "..." },
    "counts": { "promised": 2, "completed": 1, "missed": 0, "explained": 0,
                "unexplained": 0, "incomplete": 1, "excused": 0,
                "unfinishedPromises": 1 },
    "tasks": [ { "taskId": 1, "name": "Study Physics", "category": "Study",
                 "status": "completed", "completedAt": "...", "overdue": false,
                 "minimumCompletion": { "text": "At least 45 minutes",
                                        "value": 45, "unit": "minutes" },
                 "reflection": null } ],
    "yesterday": { "date": "2026-10-04", "status": "no_promises",
                   "resolved": true, "reflectionRequired": false,
                   "counts": {}, "unexplainedTasks": [] },
    "canStartToday": true,
    "honestDays": 0,
    "messages": { "phase": { "title": "Keep going.", "body": "..." } }
  }
}
```

Frontend flat keys on the same response: `date` ("Monday - 5 October"),
`isoDate`, `honestDays`, `isOffDay`, `offDayReason`, `nightCheckActive`,
`hasUnresolvedYesterday`, `unresolvedYesterdayTasks`, `tasks[]`
(`{id,title,definition,category,completed,status,overdue,accountabilityTime}`),
`phase`, `canStartToday`, `message`.

### POST /tasks

```json
{
  "name": "Study Physics",              // or "title" (frontend alias)
  "category": "Study",                  // default "general"
  "repeatType": "daily",                // one_time | daily | selected_days
                                        // ("once"/"selected" also accepted)
  "selectedDays": [1,3],                // 0=Sun..6=Sat, selected_days only
  "startDate": "2026-10-05",            // default today; past rejected
  "endDate": "2026-10-31",              // optional
  "reminderTime": "20:00",              // optional HH:MM
  "accountabilityTime": "22:30",        // optional per-task override
  "minimumCompletion": {                // optional; or use "definition" text
    "text": "At least 45 minutes", "value": 45, "unit": "minutes"
  }
}
```

`201 Created` → `{ "success": true, "data": { "task": { ... } } }` with
schedules + recentCompletions. Flat `task` projection included.
Errors: `VALIDATION_ERROR` (details array), `DATE_IN_PAST`.

### PATCH /tasks/:id

Same fields, all optional. Changing the repeat rule keeps history intact:
the old schedule row is closed and a new row starts from `effectiveFrom`
(default today, past rejected). Keys: also accepts `title`, `repeat`,
`definition`, `reminder` (frontend aliases).
Errors: `TASK_NOT_FOUND`, `VALIDATION_ERROR`, `DATE_IN_PAST`.

### DELETE /tasks/:id — soft delete

Deactivates. Schedule closes yesterday; today's completed occurrences remain
visible and all history/report data is preserved. `POST /tasks/:id/restore`
reactivates.

### PUT /tasks/:id/complete

Body (all optional): `{ "date": "YYYY-MM-DD", "minutes": 45, "note": "..." }`.
Default date is today. Re-completing updates minutes/note and keeps the
original `completedAt`.
Errors: `TASK_NOT_FOUND`, `DAY_CLOSED` (409 — the date's reset has passed;
record a reflection instead), `TASK_NOT_SCHEDULED` (409),
`DATE_IN_FUTURE`, `VALIDATION_ERROR`.

### PUT /tasks/:id/uncomplete

Removes the completion record for `{ "date": "..." }` (default today). Undo is
allowed for past dates too — correcting a false record is honesty; day status
is simply recomputed. Errors: `COMPLETION_NOT_FOUND`.

### GET /calendar?month=10&year=2026 (frontend)

```json
{ "month": "October 2026",
  "history": { "2026-10-05": { "status": "completed", "completed": 2,
                               "total": 2, "reflection": null, "offDay": false } } }
```

Status values: `completed` (green), `explained` (yellow), `unresolved` (red),
`active` (today, still open), `off`, `none`, `future`.
Canonical alternative: `GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`
(max 366 days) returns `data.days[]`.

### GET /calendar/day/:date (and canonical /calendar/:date)

Full day detail: `status`, `counts`, `tasks[]` (each with `status` =
completed / missed_explained / missed_unexplained / incomplete / excused and
its `reflection`), `dayReflection`, `offDay`, `honestDay`.
Errors: `INVALID_DATE`.

### POST /reflections

```json
{ "date": "2026-10-05", "taskIds": [3], "reason": "Had a college event and returned late." }
```

Explains the given missed/incomplete promises (upsert per task+date).
`taskIds` omitted → day-level note (does NOT resolve a red day).
Errors: `DATE_IN_FUTURE`, `TASK_NOT_SCHEDULED` (409),
`REFLECTION_FOR_COMPLETED` (409), `OFF_DAY_REFLECTION` (409),
`TASK_NOT_FOUND`, `VALIDATION_ERROR`.
Success includes the day summary after the update and the product message:
*"Reason recorded. You don't need to justify it to us. You just needed to be
honest with yourself."* → *Start today.*

### GET /night-check · POST /night-check/reflect

`GET` → `{ active, accountabilityTime, gracePeriodMinutes, unfinishedTasks[],
yesterday }` — `active` is true from the accountability time until reset when
unfinished promises exist (and it is not an off day).

`POST /night-check/reflect` with `{ "reason": "...", "date"?, "taskIds"? }`:
without a date it targets yesterday while unresolved, otherwise today;
without taskIds it explains every promise that owes a reason. This is the
frontend's reflect button. Errors: `NOTHING_TO_REFLECT` (409), plus the
reflection errors above.

### POST /off-days

```json
{ "date": "2026-10-05", "reason": "Sick", "note": "..." }
```

`reason` ∈ Sick / Travel / Exams finished / Personal day (free text ≤ 100
chars also accepted). **Deadline rule (backend-enforced):** an off day can
only be activated before that date's accountability time + grace period. Past
that, the day is history. Errors: `OFF_DAY_DEADLINE_PASSED` (409),
`OFF_DAY_EXISTS` (409), `VALIDATION_ERROR`. Frontend alias `POST /off-day`
activates for **today**.

`DELETE /off-days/:id` removes one before its deadline → `OFF_DAY_LOCKED`
after. `GET /off-days?from=&to=` lists.

### GET /report/weekly (also /reports/weekly)

Week (Monday- or Sunday-start per settings) containing today or `?date=`:

```json
{ "completedCount": 13, "totalCount": 16, "completionRate": 81.3,
  "mostConsistent": "Coding (100%)", "mostSkipped": "Workout (50%)",
  "commonReason": "Too tired / got late", "insight": "..." }
```

Canonical `data` adds `week`, `totals` (incl. explained/unexplained),
`days[]`, per-task `tasks[]`, `mostCommonReason`. Off days are excluded from
totals; `mostConsistent`/`mostSkipped` require ≥ 2 scheduled days. All values
are computed from the database — empty data yields `null`s, never fakes.

### GET /honesty/score?window=30d|month|all

Deterministic formula (documented in `services/honestyService.js`, tunable
via `HONESTY_WEIGHTS`):

```
score = round(100 * (0.5 * completionRate + 0.3 * explanationRate + 0.2 * consistencyRate))
completionRate  = completed / promised          (window)
explanationRate = explained / missed   (no misses -> 1)
consistencyRate = honest days / countable days
```

Only CLOSED days (through yesterday) are scored. No data → `score: null`.
`data` includes the full breakdown, weights and formula string.
`GET /stats/score` is the frontend alias (current month).

### GET /honesty/days?month=YYYY-MM (or ?from=&to=)

```json
{ "current": 2, "best": 4, "today": "green_so_far",
  "monthly": { "month": "2026-10", "honestDays": 6, "greenDays": 4,
               "yellowDays": 2, "offDays": 1, "redDays": 1, "noPromiseDays": 3 },
  "history": [ { "date": "2026-10-05", "status": "green", "honest": true } ] }
```

An Honest Day = all promises completed (green) **or** every miss honestly
explained (yellow). Red days break the streak; off days / no-promise days
neither count nor break it.

### GET /archive?q=tired

Searchable reflections (`reason`/task name match), newest first, with a
`patternNotice` when one reason repeats in the last 31 days.

### GET /insights

Patterns computed from real history only (day-of-week miss spikes, most
skipped promise, recurring reason). Little data → short/empty list.

### GET/PUT /settings

```json
{ "accountabilityTime": "22:30", "dailyReset": "00:00", "gracePeriod": 15,
  "weekStart": "monday", "notifications": true, "theme": "dark", "timezone": "auto" }
```

Accepts canonical keys too (`dailyResetTime`, `gracePeriodMinutes`,
`weekStarts`, `notificationsEnabled`). `timezone`: `"auto"` or any IANA name
— all daily logic (task dates, midnight, accountability, grace, reports)
uses it. Unknown keys are ignored. Cross-field rule:
`reset < accountability ≤ reset+24h − 2×grace` → `INVALID_SETTINGS` otherwise.
PUT and PATCH are equivalent.

### GET /accountability/state · /notifications · /accountability/events

- `state`: phase, phaseLevel, deadlines, unfinishedPromises, nightCheckActive,
  yesterday-resolution and the kind phase messages ("Be honest with yourself.
  You still have 3 unfinished promises today.").
- `notifications`: the messages active right now (`yesterday-reflection`,
  `accountability-check`, `final-warning`) — backend-computed; the frontend
  just displays them.
- `events`: durable audit trail (`day_rolled`, `accountability_check`,
  `final_warning`), one row per (type, date), written by the 30 s server tick.

### GET /health · /time

Server time, effective timezone, today's date, phase, deadlines. `/health`
also reports the backend version.

## Error codes

`VALIDATION_ERROR` (400) · `INVALID_JSON` (400) · `INVALID_DATE` (400) ·
`INVALID_SETTINGS` (400) · `DATE_IN_PAST` (400) · `DATE_IN_FUTURE` (400) ·
`RANGE_TOO_LARGE` (400) · `TASK_NOT_FOUND` (404) · `COMPLETION_NOT_FOUND` (404) ·
`REFLECTION_NOT_FOUND` (404) · `OFF_DAY_NOT_FOUND` (404) · `NOT_FOUND` (404) ·
`DAY_CLOSED` (409) · `TASK_NOT_SCHEDULED` (409) · `REFLECTION_FOR_COMPLETED` (409) ·
`NOTHING_TO_REFLECT` (409) · `OFF_DAY_REFLECTION` (409) ·
`OFF_DAY_DEADLINE_PASSED` (409) · `OFF_DAY_EXISTS` (409) · `OFF_DAY_LOCKED` (409) ·
`PAYLOAD_TOO_LARGE` (413) · `INTERNAL_ERROR` (500)
