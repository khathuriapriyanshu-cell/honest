# HONEST backend — API reference

Everything the frontend needs, with no guessing. Base URL by default:

```
http://localhost:3000/api
```

Every route below is also listed live at `GET /api`.

---

## Contents

1. [Conventions](#1-conventions)
2. [Response shapes](#2-response-shapes)
3. [Error codes](#3-error-codes)
4. [Concepts](#4-concepts)
5. [Daily state](#5-daily-state)
6. [Promises (tasks)](#6-promises-tasks)
7. [Completion](#7-completion)
8. [Night check, reflections and notifications](#8-night-check-reflections-and-notifications)
9. [Off days](#9-off-days)
10. [Calendar and history](#10-calendar-and-history)
11. [Reports and analytics](#11-reports-and-analytics)
12. [Settings](#12-settings)
13. [System](#13-system)
14. [Serverless scheduler (cron)](#14-serverless-scheduler-cron)

---

## 1. Conventions

- **JSON in, JSON out.** Send `Content-Type: application/json`.
- **Dates** are ISO calendar dates, `YYYY-MM-DD`, always interpreted in the user's configured
  timezone (`settings.timezone`, `auto` by default).
- **Times** are 24-hour `HH:MM`.
- **Weekdays** are ISO-8601 numbers: `1` = Monday … `7` = Sunday.
- **Timestamps** in responses are UTC ISO-8601 with a `Z`.
- **Task ids** are exposed as strings (`"1"`) for the documented frontend contract, and the numeric
  form is available as `taskId`.
- **The server date is authoritative.** Never derive "today" from the browser; use
  `GET /api/today`, `GET /api/time` or the `isoDate` field.

### Day boundaries

| Setting | Default | Meaning |
| --- | --- | --- |
| `dailyReset` | `00:00` | when one day becomes the next |
| `accountabilityTime` | `22:30` | when the evening check opens |
| `gracePeriod` | `15` minutes | measured **backwards from the daily reset** — the final stretch in which the day can still be finished |

---

## 2. Response shapes

Success:

```json
{ "success": true, "data": { }, "...": "the documented fields are also present at the top level" }
```

Because the frontend reads both flat fields and envelopes, every successful response carries
`success: true`, the documented payload fields **and** the identical payload under `data`.

Error:

```json
{
  "success": false,
  "message": "No promise exists with id 42.",
  "error": { "code": "TASK_NOT_FOUND", "message": "No promise exists with id 42." }
}
```

`error.details` appears when there is something specific and safe to add (for example which
promises were affected). Database internals, SQL and table names are never exposed.

---

## 3. Error codes

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `MISSING_FIELD` | a required field was absent or empty |
| 400 | `INVALID_FIELD` | wrong type, out of range, or wrong shape |
| 400 | `INVALID_TIME` | not a valid `HH:MM` time |
| 400 | `INVALID_DATE` | not a real calendar date (e.g. `2026-02-30`) |
| 400 | `INVALID_REPEAT` | repeat type is not `once`, `daily` or `selected` |
| 400 | `REPEAT_DAYS_REQUIRED` | repeat is `selected` but no weekdays were given |
| 400 | `INVALID_TIMEZONE` | not a recognised IANA timezone |
| 400 | `INVALID_REFLECTION` | the reason is too short or too long |
| 400 | `INVALID_RANGE` | `from` is after `to` |
| 400 | `INVALID_DATE_RANGE` | `endDate` before `startDate` |
| 400 | `MALFORMED_JSON` | the body is not valid JSON |
| 400 | `UNKNOWN_SETTING` | a settings key the API does not define |
| 400 | `COMPLETION_IN_FUTURE` | a promise cannot be completed for a day that has not happened |
| 400 | `TASK_NOT_SCHEDULED` | that promise does not fall on that weekday |
| 400 | `OFF_DAY_TOO_FAR_AHEAD` | off days can be planned at most 30 days ahead |
| 400 | `REFLECTION_IN_FUTURE` | a reflection cannot be recorded for a future day |
| 400 | `NO_UPDATES` | nothing valid was supplied to update |
| 400 | `INVALID_ID` | id is not a positive integer |
| 403 | `OFF_DAY_DEADLINE_PASSED` | the off-day deadline for that day has passed |
| 403 | `OFF_DAY_RETROACTIVE_FORBIDDEN` | that day is already history |
| 403 | `DAY_CLOSED` | a recurring promise cannot be completed for a past day |
| 403 | `UNDO_WINDOW_CLOSED` | a completion can only be undone on the day it was recorded |
| 404 | `TASK_NOT_FOUND` | no such promise |
| 404 | `OFF_DAY_NOT_FOUND` | no active off day for that date |
| 404 | `NOTIFICATION_NOT_FOUND` | no such notification |
| 404 | `ROUTE_NOT_FOUND` | unknown endpoint |
| 409 | `NOTHING_TO_REFLECT_ON` | there is nothing unresolved to explain |
| 409 | `TASK_ALREADY_RESOLVED` | already completed or explained |
| 409 | `TASK_HAS_HISTORY` | refusing to erase a promise with recorded history |
| 409 | `TASK_INACTIVE` | the promise is no longer active |
| 409 | `OFF_DAY_NO_REFLECTION_NEEDED` | the day is off; nothing to explain |
| 409 | `NOT_COMPLETED` | nothing to undo |
| 409 | `OCCURRENCE_HAS_REFLECTION` | the day is locked because it was explained |
| 413 | `PAYLOAD_TOO_LARGE` | body over 256 KB |
| 500 | `DATABASE_ERROR` | the database rejected the write; nothing was saved |
| 500 | `INTERNAL_ERROR` | unexpected; includes `error.details.reference` for reporting |

---

## 4. Concepts

### The three promise states

| State | `state` value | Calendar colour |
| --- | --- | --- |
| Kept | `completed` | 🟢 |
| Missed, honestly explained | `missed_explained` | 🟡 |
| Missed, still unresolved | `missed_unexplained` | 🔴 |

`pending` is used for a promise on the current day that has not been answered yet. On an off day
every promise reports `off_day` and none of them count as unresolved.

### Repeat types

| `repeat` | Behaviour |
| --- | --- |
| `once` | occurs only on `startDate`; once answered it is deactivated automatically and stops appearing on later days |
| `daily` | occurs every day from `startDate` (optionally until `endDate`) |
| `selected` | occurs only on the weekdays in `selectedDays` from `startDate` |

Accepted aliases: `one-time`/`onetime` → `once`, `everyday`/`every_day` → `daily`,
`weekly`/`custom`/`selected-days` → `selected`.

### Which date does a completion belong to?

- **Recurring promise** — the day the backend currently considers active. Inside the grace window
  that is *yesterday*, so finishing a promise at 00:05 records it against yesterday, as it should.
- **One-time promise** — its scheduled date, or today if that date has already passed.

Outside the grace window a recurring promise can never be completed for a past day (`403 DAY_CLOSED`).

---

## 5. Daily state

### `GET /api/today`

The authoritative answer to "what is today?". Drives the Today view.

**Query parameters** — `date` *(optional)*: inspect a specific date instead of today. Exploring a
future date is allowed; it simply reports no history.

**Response `200`**

```json
{
  "success": true,
  "isoDate": "2026-10-05",
  "date": "2026-10-05",
  "today": "2026-10-05",
  "isToday": true,
  "dateLabel": "Monday - 5 October",
  "status": "active",
  "isOffDay": false,
  "offDayReason": null,
  "honestDays": 12,
  "counts": { "total": 5, "completed": 2, "explained": 1, "unresolved": 2, "missed": 3 },
  "tasks": [
    {
      "id": "1",
      "taskId": 1,
      "title": "2 hrs Coding",
      "name": "2 hrs Coding",
      "definition": "At least 45 minutes focused session",
      "minimumCompletion": "At least 45 minutes focused session",
      "category": "DSA",
      "repeat": "daily",
      "repeatDays": [],
      "reminder": "20:00",
      "accountabilityTime": "22:30",
      "completed": false,
      "state": "pending",
      "pending": true,
      "date": "2026-10-05",
      "startDate": "2026-10-05",
      "endDate": null,
      "status": "active",
      "reflectionId": null
    }
  ],
  "accountability": {
    "time": "22:30",
    "gracePeriod": 15,
    "dailyReset": "00:00",
    "timezone": "Asia/Kolkata",
    "localTime": "21:12",
    "serverTimeUtc": "2026-10-05T15:42:00Z",
    "nightCheckActive": false,
    "accountabilityReached": false,
    "carryOverWindowOpen": false,
    "graceMinutesLeft": null,
    "unfinishedCount": 2,
    "accountableCount": 0,
    "windowClosesAt": "00:00"
  },
  "reflection": {
    "required": false,
    "hasUnresolvedYesterday": false,
    "previousDate": "2026-10-04",
    "targetDate": null,
    "unresolvedCount": 0,
    "unresolvedDates": [],
    "targets": [],
    "canStillCompleteYesterday": false,
    "backlog": { "dates": [], "count": 0, "oldestDate": null, "newestDate": null, "tasks": [] }
  },
  "nightCheckActive": false,
  "hasUnresolvedYesterday": false,
  "unresolvedYesterdayTasks": [],
  "canStartNewDay": true,
  "previousDayClosed": true,
  "olderUnresolvedDates": [],
  "honestDaysDetail": { "current": 12, "todayHonest": true, "todayPending": false },
  "notifications": [],
  "settings": { "...": "the same payload as GET /api/settings" },
  "data": { "...": "the same payload" }
}
```

**Business meaning**

- `status`: `active` (today, still in progress) · `completed` · `explained` · `unresolved` ·
  `offday` · `empty`. Today is always `active` — a day in progress is never declared finished.
- `reflection.required` — true when **yesterday** still has unanswered promises. The frontend shows
  *"Yesterday is waiting for an explanation."* and `canStartNewDay` is false.
- `reflection.backlog` — older unsettled days. They cost honest-day credit but do **not** block the
  new day; naming them keeps "Start again" believable while staying honest.
- `accountability.nightCheckActive` — true once the accountability moment has arrived and something
  is still outstanding (today's promises, or yesterday's inside the grace window).

**Errors** — `400 INVALID_DATE` for a malformed `date`.

### `GET /api/day?date=YYYY-MM-DD`

Identical payload for any date. Useful for "what did last Tuesday look like?" before the calendar
detail endpoint is opened.

### `GET /api/time`

The server's own view of the clock. Handy for debugging and for confirming that the backend, not
the browser, owns the date.

```json
{
  "success": true,
  "serverTimeUtc": "2026-10-05T15:42:00.000Z",
  "serverDate": "2026-10-05",
  "serverTime": "21:12",
  "timezone": "Asia/Kolkata",
  "timezoneSetting": "auto",
  "dailyReset": "00:00",
  "accountabilityTime": "22:30",
  "gracePeriod": 15,
  "clockOffsetMinutes": 0,
  "note": "The backend is the source of truth for dates. Do not derive the current day from the browser clock."
}
```

---

## 6. Promises (tasks)

### `GET /api/tasks`

**Query parameters**

| Name | Values | Default |
| --- | --- | --- |
| `status` | `all` · `active` · `inactive` | `all` |
| `repeat` | `once` · `daily` · `selected` | — |
| `category` | any category string | — |

**Response `200`** — `{ "count": 3, "tasks": [ { …promise… } ] }`

```json
{
  "success": true,
  "count": 1,
  "tasks": [
    {
      "id": "1", "taskId": 1,
      "title": "Study Physics", "name": "Study Physics",
      "definition": "At least 45 minutes without phone",
      "minimumCompletion": "At least 45 minutes without phone",
      "minimumCompletionSpec": null,
      "category": "Study",
      "repeat": "daily", "repeatDays": [],
      "reminder": "20:00", "accountabilityTime": "22:30",
      "completed": false, "state": null, "date": "2026-10-05",
      "startDate": "2026-10-05", "endDate": null, "status": "active",
      "reflectionId": null, "historical": null
    }
  ]
}
```

### `POST /api/tasks`

Create a promise.

**Request body**

| Field | Required | Notes |
| --- | --- | --- |
| `title` (or `name`) | yes | 1–200 characters |
| `definition` (or `minimumCompletion`) | no | up to 500 characters; the minimum definition of done, e.g. *"At least 45 minutes"* |
| `minimumCompletionSpec` | no | reserved structured form (JSON) for later use |
| `category` | no | up to 60 characters, defaults to `General` |
| `repeat` | no | `once` · `daily` · `selected`; defaults to `daily` |
| `selectedDays` (or `repeatDays`) | when `repeat` is `selected` | array of 1–7, at least one |
| `reminder` | no | `HH:MM`; drives that promise's reminder notification |
| `accountabilityTime` | no | `HH:MM`; falls back to the global setting |
| `startDate` | no | defaults to today |
| `endDate` | no | optional last date (a semester, a challenge) |

**Request**

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

**Response `201`**

```json
{
  "success": true,
  "task": {
    "id": "1", "taskId": 1,
    "title": "Study Physics",
    "definition": "At least 45 minutes without phone",
    "category": "Study",
    "repeat": "daily",
    "completed": false,
    "accountabilityTime": "22:30",
    "startDate": "2026-10-05", "endDate": null, "status": "active"
  }
}
```

**Errors** — `400 MISSING_FIELD`, `INVALID_REPEAT`, `REPEAT_DAYS_REQUIRED`, `INVALID_TIME`,
`INVALID_DATE`, `INVALID_DATE_RANGE`.

Useful behaviour: a `daily` promise created *today* does not retroactively exist on previous days;
its `startDate` is its creation date unless one is supplied.

### `GET /api/tasks/:id`

One promise plus its state for today (or `null` when it does not fall on today).

**Response `200`** — `{ "success": true, "task": { … }, "today": { …state or null… } }`

**Errors** — `400 INVALID_ID`, `404 TASK_NOT_FOUND`.

### `PUT /api/tasks/:id` · `PATCH /api/tasks/:id`

Update a promise. Both verbs behave identically: any subset of the create fields plus `status`
(`active` / `inactive`).

```json
{ "title": "Study Physics daily", "definition": "50 minutes", "accountabilityTime": "23:00" }
```

**Response `200`** — `{ "success": true, "task": { …updated… }, "today": { …state… } }`

**Important:** editing a recurring promise never rewrites history. The text of every already
answered day is frozen on its occurrence row.

**Errors** — `400 NO_UPDATES`, `REPEAT_DAYS_REQUIRED`, `INVALID_FIELD`, `404 TASK_NOT_FOUND`.

### `DELETE /api/tasks/:id`

Deactivates a promise by default: it stops recurring from the next day, and everything already
recorded stays in the calendar forever.

**Query parameters** — `hard=true` permanently deletes, and is **only** allowed when the promise has
no recorded history at all (created by mistake).

**Response `200`**

```json
{ "success": true, "id": 1, "deleted": true, "mode": "deactivated", "inactiveFrom": "2026-10-06" }
```

`mode` is `deactivated` or `hard`.

**Errors** — `404 TASK_NOT_FOUND`, `409 TASK_HAS_HISTORY`.

---

## 7. Completion

### `PUT /api/tasks/:id/complete`

*"I actually did this."*

**Query parameters / body** — `date` *(optional)*: which date to complete it for. Omit it and the
backend picks the day the promise belongs to (yesterday, inside the grace window).

**Response `200`**

```json
{
  "success": true,
  "task": { "id": "1", "taskId": 1, "title": "2 hrs Coding", "completed": true,
            "state": "completed", "date": "2026-10-05" },
  "occurrence": {
    "id": 7, "taskId": 1, "date": "2026-10-05", "status": "completed",
    "completed": true, "reflected": false,
    "taskName": "2 hrs Coding", "taskDefinition": "At least 45 minutes",
    "completedAt": "2026-10-05T15:42:00Z"
  },
  "date": "2026-10-05",
  "state": "completed",
  "message": "\"2 hrs Coding\" is marked done for 2026-10-05."
}
```

**Business meaning** — this is a persisted write. `occurrence` contains the durable row, including
the promise text frozen at that moment. A one-time promise is retired automatically once answered.

**Errors**

| Code | When |
| --- | --- |
| `400 COMPLETION_IN_FUTURE` | the target date has not happened yet |
| `400 TASK_NOT_SCHEDULED` | that promise does not fall on that weekday |
| `403 DAY_CLOSED` | a recurring promise cannot be completed for a closed past day |
| `404 TASK_NOT_FOUND` | no such promise |
| `409 TASK_INACTIVE` | the promise is deactivated (reactivate it first) |

`POST /api/tasks/:id/complete` is accepted as an alias.

### `PUT /api/tasks/:id/uncomplete`

Undo a completion. Allowed only on the day the completion was recorded — history is not editable.

**Response `200`** — same shape as `complete`, with `"completed": false` and
`"state": "missed_unexplained"`.

**Errors** — `403 UNDO_WINDOW_CLOSED`, `409 NOT_COMPLETED`, `409 OCCURRENCE_HAS_REFLECTION`,
`404 TASK_NOT_FOUND`.

---

## 8. Night check, reflections and notifications

### `GET /api/night-check`

The live evening check. The backend composes the sentence; the frontend only displays it.

**Response `200`**

```json
{
  "success": true,
  "active": true,
  "date": "2026-10-05",
  "accountabilityTime": "22:30",
  "gracePeriod": 15,
  "dailyReset": "00:00",
  "minutesUntilReset": null,
  "carryOverWindowOpen": false,
  "unfinishedTasks": [
    {
      "id": "1", "taskId": 1,
      "title": "2 hrs Coding", "name": "2 hrs Coding",
      "definition": "At least 45 minutes",
      "category": "DSA",
      "accountabilityTime": "22:30",
      "accountableNow": true,
      "pending": true
    }
  ],
  "unfinishedCount": 3,
  "overdueTaskIds": ["1"],
  "overdueCount": 1,
  "message": "Be honest with yourself. You still have 3 unfinished promises today.",
  "reflection": { "...": "the same reflection block as /api/today" },
  "canStillCompleteToday": true,
  "serverTime": "22:31",
  "timezone": "Asia/Kolkata"
}
```

`active` is false when nothing is outstanding, before the accountability moment, on an off day, or
when notifications are switched off. The UI shows *"You still have 3 unfinished promises today."*

### `POST /api/night-check/reflect`

Record an honest reason for one or more missed promises.

**Request body**

| Field | Required | Notes |
| --- | --- | --- |
| `reason` (or `reflection`) | yes | 3–2000 characters; whitespace-only is refused |
| `taskIds` | no | explain specific promises; omit to explain **all** unresolved ones on the date |
| `date` | no | which day; defaults to today, or to yesterday inside the grace window |
| `source` | no | `night_check` · `midnight` · `carry_over` · `manual` |

**Request**

```json
{ "reason": "I got back late from college and club work took longer than expected." }
```

**Response `200`**

```json
{
  "success": true,
  "message": "Reason recorded.",
  "note": "You don't need to justify it to us. You just needed to be honest with yourself.",
  "nextStep": "Start today.",
  "date": "2026-10-05",
  "serverToday": "2026-10-05",
  "carriedOver": false,
  "reflections": [
    {
      "id": "1", "reflectionId": 1,
      "date": "October 5, 2026", "isoDate": "2026-10-05",
      "taskId": "1", "taskName": "2 hrs Coding",
      "reason": "I got back late from college and club work took longer than expected.",
      "source": "night_check",
      "createdAt": "2026-10-05T16:10:00Z"
    }
  ],
  "explainedTaskIds": [1, 3],
  "remainingUnresolved": 0,
  "dayResolved": true,
  "honestDays": 13
}
```

**Business meaning** — every named promise becomes `missed_explained` (🟡), which is *not* the same
as unexplained (🔴). Once `remainingUnresolved` is `0` the day is closed, the honest-day streak is
credited, and the frontend can show *"Reason recorded."* followed by *"Start today."*

Submitting again with a new reason **updates** the existing reflection for that promise and date
rather than creating a duplicate.

**Errors**

| Code | When |
| --- | --- |
| `400 MISSING_FIELD` / `INVALID_REFLECTION` | missing, blank, too short or too long |
| `400 TASK_NOT_ON_DATE` | a `taskIds` entry is not part of that day |
| `400 REFLECTION_IN_FUTURE` | the date has not happened yet |
| `409 NOTHING_TO_REFLECT_ON` | nothing is unresolved on that date |
| `409 TASK_ALREADY_RESOLVED` | that promise is already completed or explained |
| `409 OFF_DAY_NO_REFLECTION_NEEDED` | the day is an off day |

`POST /api/reflections` is accepted as an alias.

### `GET /api/reflections`

**Query parameters** — `from`, `to`, `taskId`, `limit` (max 500).

**Response `200`** — `{ "count": 2, "reflections": [ { …reflection… } ] }`, newest first.

### `GET /api/notifications`

The accountability messages that are true right now. The frontend shows
`notifications[0].message` as the toast if there is one.

```json
{
  "success": true,
  "notifications": [
    {
      "id": "1", "notificationId": 1,
      "kind": "accountability",
      "date": "2026-10-05",
      "message": "Be honest with yourself. You still have 3 unfinished promises today.",
      "payload": { "unfinishedCount": 3, "accountabilityTime": "22:30" },
      "firedAt": "2026-10-05T17:00:00Z",
      "acknowledged": false
    }
  ],
  "count": 1,
  "enabled": true,
  "accountabilityTime": "22:30",
  "gracePeriod": 15,
  "schedule": [
    { "at": "22:30", "kind": "accountability",
      "template": "Be honest with yourself. You still have {n} unfinished promise(s) today." },
    { "at": "23:45", "kind": "grace_warning",
      "template": "{n} minutes left. You can still finish them. Or tell yourself why you did not." },
    { "at": "00:00", "kind": "yesterday_unresolved",
      "template": "Yesterday is waiting for an explanation." }
  ],
  "serverTime": "22:31",
  "timezone": "Asia/Kolkata"
}
```

**Event kinds** — `reminder` (a promise's own reminder time), `accountability`, `grace_warning`,
`yesterday_unresolved`, `carry_over`.

Each event is written to the database with a UNIQUE key, so it fires **exactly once per day**, even
across restarts. `GET /api/notifications` also runs a catch-up tick, so a server that was offline
when an event was due still reports it honestly rather than silently skipping it.

**Query parameters** — `limit` (default 5, max 50). Only unacknowledged events from the last 24
hours are returned, newest first.

### `GET /api/notifications/history`

Every accountability event ever fired (up to `limit`, default 50). Useful for debugging the
timeline and for showing "what the app said and when".

### `POST /api/notifications/:id/ack` · `POST /api/notifications/ack-all`

Mark notifications as read so they stop appearing. **Errors** — `404 NOTIFICATION_NOT_FOUND`.

---

## 9. Off days

An off day suspends that day's promises without penalty: nothing counts as missed, nothing needs a
reason, the honest-day streak survives.

**The critical rule: an off day can never be activated retroactively.** The deadline is the end of
the day it applies to (the configured `offDayCutoff`, defaulting to the daily reset). It is enforced
from the server clock and the user's timezone — never from anything the client sends.

### `POST /api/off-day`

**Request body**

| Field | Required | Notes |
| --- | --- | --- |
| `reason` | yes | 2–120 characters; suggested values: `Sick`, `Travel`, `Exams finished`, `Personal day` |
| `date` | no | defaults to today; may be planned up to 30 days ahead |

**Response `200` (today)**

```json
{
  "success": true,
  "reason": "Sick",
  "offDay": {
    "id": 1, "date": "2026-10-05", "reason": "Sick", "status": "active",
    "activatedAt": "2026-10-05T16:30:00Z", "deadlineAt": "2026-10-05T18:30:00.000Z"
  },
  "date": "2026-10-05",
  "deadlineAt": "2026-10-05T18:30:00.000Z",
  "isOffDay": true,
  "suspendedPromises": 5,
  "message": "2026-10-05 is an off day: Sick. Promises for that day are suspended without penalty."
}
```

**Response `403` (deadline passed — the message the frontend surfaces verbatim)**

```json
{
  "success": false,
  "message": "An off day can no longer be activated for yesterday. That day is already part of your history.",
  "error": {
    "code": "OFF_DAY_DEADLINE_PASSED",
    "message": "An off day can no longer be activated for yesterday. That day is already part of your history.",
    "details": {
      "date": "2026-10-05",
      "deadlineAt": "2026-10-06T18:30:00.000Z",
      "deadlineLocal": "2026-10-06 00:00 (Asia/Kolkata)",
      "serverToday": "2026-10-06",
      "rule": "An off day cannot be activated retroactively after its deadline."
    }
  }
}
```

**Errors** — `400 MISSING_FIELD`, `INVALID_DATE`, `OFF_DAY_TOO_FAR_AHEAD`;
`403 OFF_DAY_DEADLINE_PASSED`, `OFF_DAY_RETROACTIVE_FORBIDDEN`.

Re-requesting an off day for a date that is still open updates its reason rather than failing.

### `GET /api/off-day`

Current status, including whether today can still be marked off.

```json
{
  "success": true,
  "today": "2026-10-05",
  "date": "2026-10-05",
  "isOffDay": false,
  "offDayReason": null,
  "offDay": null,
  "canActivateToday": true,
  "deadline": {
    "localTime": "00:00",
    "instantUtc": "2026-10-06T18:30:00.000Z",
    "rule": "An off day cannot be activated retroactively after its deadline."
  },
  "allowedReasons": ["Sick", "Travel", "Exams finished", "Personal day"]
}
```

**Query parameters** — `date` *(optional)* to ask about another day.

### `GET /api/off-days`

**Query parameters** — `from`, `to`.

**Response `200`** — `{ "count": 2, "offDays": [ { …offDay… } ] }`

### `DELETE /api/off-day/:date`

Revoke a declared off day (useful for a future day that is no longer needed).

**Response `200`** — `{ "success": true, "date": "2026-10-10", "revoked": true, "revokedAt": "…" }`

**Errors** — `400 INVALID_DATE`, `404 OFF_DAY_NOT_FOUND`.

---

## 10. Calendar and history

### `GET /api/calendar?month=10&year=2026`

Per-day status for a month. Days with nothing recorded are **omitted** rather than invented, and
future days are never reported.

**Query parameters** — `month` (1–12) and `year`; both default to the current month.

**Response `200`**

```json
{
  "success": true,
  "month": "October 2026",
  "monthNumber": 10,
  "year": 2026,
  "monthStart": "2026-10-01",
  "monthEnd": "2026-10-31",
  "today": "2026-10-05",
  "timezone": "Asia/Kolkata",
  "history": {
    "2026-10-01": { "status": "explained", "completed": 3, "total": 4, "missed": 1,
                    "explained": 1, "unresolved": 0,
                    "reflection": "Too tired after traveling back from lab." },
    "2026-10-02": { "status": "completed", "completed": 5, "total": 5, "missed": 0,
                    "explained": 0, "unresolved": 0 },
    "2026-10-04": { "status": "unresolved", "completed": 1, "total": 4, "missed": 3,
                    "explained": 0, "unresolved": 3 },
    "2026-10-05": { "status": "active", "completed": 2, "total": 5, "missed": 3,
                    "explained": 0, "unresolved": 3 }
  },
  "summary": {
    "daysTracked": 4, "honestDays": 2,
    "completedDays": 1, "explainedDays": 1, "unresolvedDays": 1,
    "activeDays": 1, "offDays": 0, "emptyDays": 0
  }
}
```

**Status values and their colours**

| `status` | Meaning | Colour |
| --- | --- | --- |
| `completed` | every promise kept | 🟢 |
| `explained` | misses, all honestly explained | 🟡 |
| `unresolved` | at least one promise unexplained | 🔴 |
| `active` | today, still in progress | ⚪ (in progress) |
| `offday` | declared off | ⚪ |
| `empty` | nothing was promised | ⚪ (usually omitted) |

The summary is counted from the same map that is returned, so the totals can never disagree with
the day cells.

**Errors** — `400 INVALID_FIELD` for an out-of-range month or year.

### `GET /api/calendar/day/:date`

Detailed history for one day — the day-detail panel.

**Response `200`**

```json
{
  "success": true,
  "date": "2026-10-03",
  "dateLabel": "Saturday - 3 October",
  "status": "explained",
  "completed": 4,
  "total": 5,
  "missed": 1,
  "explained": 1,
  "unresolved": 0,
  "tasks": [
    { "id": "1", "taskId": 1, "title": "Coding", "name": "Coding", "category": "DSA",
      "definition": "At least 45 minutes", "completed": true, "explained": false,
      "unresolved": false, "state": "completed",
      "completedAt": "2026-10-03T18:20:00Z", "reflectedAt": null },
    { "id": "5", "taskId": 5, "title": "Revision", "name": "Revision", "category": "Study",
      "definition": null, "completed": false, "explained": true,
      "unresolved": false, "state": "missed_explained",
      "completedAt": null, "reflectedAt": "2026-10-04T02:15:00Z" }
  ],
  "reflection": "Had a college event and returned late.",
  "reflections": [ { "id": "3", "date": "October 3, 2026", "isoDate": "2026-10-03",
                     "taskId": "5", "taskName": "Revision",
                     "reason": "Had a college event and returned late." } ],
  "isOffDay": false,
  "offDay": null,
  "isHonestDay": true,
  "timezone": "Asia/Kolkata"
}
```

`reflection` is a single convenience string (reasons joined with ` | `) for the frontend's
one-paragraph panel; `reflections` is the structured list.

**Errors** — `400 INVALID_DATE`, `400 DATE_IN_FUTURE`.

### `GET /api/history?from=&to=`

Flat per-day history for a range, for exports or charts.

**Response `200`**

```json
{
  "success": true,
  "from": "2026-10-01",
  "to": "2026-10-05",
  "timezone": "Asia/Kolkata",
  "days": [
    { "date": "2026-10-01", "status": "explained", "completed": 3, "total": 4,
      "missed": 1, "explained": 1, "unresolved": 0, "isOffDay": false, "isHonestDay": true }
  ]
}
```

**Errors** — `400 INVALID_DATE`, `400 INVALID_RANGE`.

### `GET /api/archive?q=`

The Honest Archive: every recorded reason, newest first, with optional keyword search and a pattern
notice when one reason keeps recurring.

**Query parameters**

| Name | Meaning |
| --- | --- |
| `q` (or `query`) | case-insensitive match against the reason or the promise name |
| `from`, `to` | restrict to a date range |
| `limit` | max results (default 200, max 500) |

**Response `200`**

```json
{
  "success": true,
  "query": "tired",
  "count": 2,
  "totalMatching": 2,
  "total": 18,
  "reflections": [
    { "id": "4", "reflectionId": 4,
      "date": "October 3, 2026", "isoDate": "2026-10-03",
      "taskId": "5", "taskName": "Revision",
      "reason": "Had a college event and returned late.",
      "source": "night_check",
      "createdAt": "2026-10-04T02:15:00Z" }
  ],
  "patternNotice": "You've used \"too tired\" 8 times this month.",
  "pattern": { "reason": "too tired", "count": 8 },
  "empty": false,
  "emptyMessage": null
}
```

`patternNotice` is `null` when no reason has repeated twice or more this month. Reasons are compared
on normalised text, so `"Too tired."` and `"too tired"` count as the same reason.

---

## 11. Reports and analytics

All analytics are computed from persisted occurrences and reflections. With no data they return real
zeros and honest labels — never sample values.

### `GET /api/report/weekly`

The Weekly Honesty Report for the week containing `date` (or today), using the `weekStart` setting.

**Query parameters** — `date` *(optional)*.

**Response `200`**

```json
{
  "success": true,
  "weekStart": "2026-09-28",
  "weekEnd": "2026-10-04",
  "weekStartDay": "monday",
  "completedCount": 31,
  "totalCount": 37,
  "missedCount": 6,
  "explainedCount": 6,
  "unexplainedCount": 0,
  "completionRate": 83.8,
  "mostConsistent": "Coding (100%)",
  "mostSkipped": "Workout (57.1%)",
  "commonReason": "Too tired / got late",
  "commonReasonCount": 4,
  "reasonCount": 2,
  "daysTracked": 7,
  "insight": "31 of 37 promises were kept and every miss was explained. Honesty is holding up - the next lever is scheduling, not effort.",
  "empty": false
}
```

**Business meaning**

- `completionRate` is `completed / total` rounded to one decimal.
- `mostConsistent` / `mostSkipped` require a promise to have been recorded **at least twice** —
  a single data point is not a pattern, so they report `"None yet"` instead of guessing.
- Off days are excluded from the denominators: a suspended promise is neither kept nor broken.
- `insight` is generated from the real numbers and never shames the user.

### `GET /api/stats/score`

The Honest Score with its full breakdown, so the number is auditable.

**Query parameters** — `from`, `to` *(optional)*; default is the current calendar month.

**Response `200`**

```json
{
  "success": true,
  "honestyScore": 84,
  "hasData": true,
  "month": "October 2026",
  "monthStart": "2026-10-01",
  "monthEnd": "2026-10-31",
  "range": { "from": "2026-10-01", "to": "2026-10-31" },
  "promisesMade": 142,
  "completed": 119,
  "missed": 23,
  "explained": 23,
  "unexplained": 0,
  "completionRate": 83.8,
  "breakdown": {
    "completionScore": 83.8,
    "explanationScore": 100,
    "followThroughScore": 100,
    "noUnansweredBonus": 100,
    "weights": { "completion": 0.55, "explanation": 0.3, "followThrough": 0.1, "noUnanswered": 0.05 }
  },
  "offDaysExcluded": 2,
  "formula": "round(0.55*completion + 0.30*explanation + 0.10*followThrough + 0.05*noUnansweredBonus), all terms 0-100"
}
```

**The formula** (also documented in `services/statsService.js` beside the weights):

```
completionScore   = 100 * completed / (completed + missed)
explanationScore  = 100 * explained / missed                    (no misses -> 100)
followThrough     = 100 * explained / (explained + unexplained)
noUnansweredBonus = 100 when unexplained === 0, else 0

HONEST SCORE = round( 0.55*completionScore + 0.30*explanationScore
                    + 0.10*followThrough  + 0.05*noUnansweredBonus )
```

Always an integer 0–100, deterministic, and monotonic: completing a promise never lowers it,
explaining a miss never lowers it, and ignoring a miss never raises it. With no data,
`honestyScore` is `0` and `hasData` is `false` — the frontend shows its empty state instead of a
fabricated score.

### `GET /api/stats/honest-days`

```json
{
  "success": true,
  "current": 12,
  "todayHonest": true,
  "todayPending": false,
  "month": { "label": "October 2026", "honestDays": 9, "trackedDays": 5 },
  "lifetime": { "honestDays": 41, "trackedDays": 63, "since": "2026-08-04" },
  "definition": "An honest day is a day where every promise was kept, or every missed promise was honestly explained. An off day also counts. This is not a plain completion streak."
}
```

An **honest day** is not a completion streak: it is a day where everything was kept **or** every
miss was explained **or** the day was declared off. Days with nothing promised are neutral and are
skipped. Today does not break the streak while it is still in progress.

### `GET /api/insights`

Deterministic behavioural patterns. Each is backed by counts, and a claim is only made when the data
supports it — otherwise `patterns` is empty and `emptyMessage` explains why.

**Query parameters** — `days` (look-back window, default 90, max 365).

**Response `200`**

```json
{
  "success": true,
  "patterns": [
    { "lead": "Time-of-day discrepancy",
      "content": "You complete promises 91% of the time when they are scheduled before 7 PM, but only 54% when they are scheduled in the evening (34 early promises, 21 later ones).",
      "data": { "beforeRate": 91, "afterRate": 54, "beforeTotal": 34, "afterTotal": 21 } },
    { "lead": "Day-of-week pattern",
      "content": "Thursday is your hardest day: 5 of 9 promises (56%) were not completed.",
      "data": { "weekday": "Thursday", "missed": 5, "total": 9 } },
    { "lead": "Primary justification",
      "content": "Your most common reason for unfinished promises is \"Too tired / got late\" (8 times in the last 90 days).",
      "data": { "reason": "Too tired / got late", "count": 8 } },
    { "lead": "Honesty coverage",
      "content": "All 24 promises in this period are accounted for: 15 completed and 9 honestly explained. Nothing is left unresolved.",
      "data": { "completed": 15, "explained": 9, "unexplained": 0, "total": 24 } }
  ],
  "empty": false,
  "range": { "from": "2026-07-07", "to": "2026-10-05" },
  "timezone": "Asia/Kolkata",
  "emptyMessage": null
}
```

**Pattern thresholds** (in `services/insightService.js`, easy to tune)

| Pattern | Requires |
| --- | --- |
| Time-of-day discrepancy | ≥ 3 promises on each side of 7 PM and a ≥ 25 point gap |
| Day-of-week pattern | ≥ 8 occurrences on that weekday, ≥ 3 missed, and a ≥ 50% miss rate |
| Primary justification | the same normalised reason ≥ 3 times in the window |
| Honesty coverage / Unresolved | ≥ 10 promises in the window |

---

## 12. Settings

### `GET /api/settings`

```json
{
  "success": true,
  "accountabilityTime": "22:30",
  "dailyReset": "00:00",
  "gracePeriod": 15,
  "notifications": true,
  "weekStart": "monday",
  "theme": "dark",
  "timezone": "auto",
  "timezoneResolved": "Asia/Kolkata",
  "offDayCutoff": "00:00",
  "serverDate": "2026-10-05",
  "serverTime": "21:12"
}
```

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `accountabilityTime` | `HH:MM` | `22:30` | when the evening check opens |
| `dailyReset` | `HH:MM` | `00:00` | when one day becomes the next |
| `gracePeriod` | 0–240 minutes | `15` | the final stretch, measured backwards from `dailyReset` |
| `notifications` | boolean | `true` | whether accountability events are produced |
| `weekStart` | `monday` · `sunday` | `monday` | affects weekly reports and week grouping |
| `theme` | `dark` · `light` | `dark` | stored for the client |
| `timezone` | IANA name or `auto` | `auto` | drives **every** date-sensitive rule |
| `offDayCutoff` | `HH:MM` or empty | empty → `dailyReset` | the deadline for declaring an off day |

`timezoneResolved`, `serverDate` and `serverTime` are read-only conveniences computed by the server.

### `PUT /api/settings` · `PATCH /api/settings`

Send a partial or complete object. Only the fields above are accepted; anything else is rejected
(`400 UNKNOWN_SETTING`) rather than silently ignored, so a frontend typo is caught immediately.

```json
{ "accountabilityTime": "23:00", "gracePeriod": 20, "weekStart": "sunday",
  "theme": "light", "notifications": true, "timezone": "Asia/Kolkata" }
```

**Response `200`** — `{ "success": true, "settings": { …full settings… } }`

**Errors** — `400 MISSING_FIELD`, `INVALID_TIME`, `INVALID_FIELD`, `INVALID_TIMEZONE`,
`UNKNOWN_SETTING`.

**Business meaning** — a settings change takes effect for subsequent requests immediately, including
the timezone. Nothing is written unless every supplied field validates.

---

## 13. System

### `GET /api`

The endpoint index as JSON — the same routes documented here.

```json
{
  "success": true,
  "name": "HONEST backend",
  "version": "1.0.0",
  "environment": "production",
  "endpoints": { "daily": [], "promises": [], "accountability": [], "history": [], "analytics": [], "configuration": [] }
}
```

### `GET /api/health` · `GET /health`

Identical payloads, for uptime monitors and App Center health checks. **Always HTTP 200** — a monitor
reads the body, and `status: "degraded"` with a reason is more useful than a bare 500.

```json
{
  "success": true,
  "status": "ok",
  "database": "ok",
  "schemaVersion": 3,
  "timestamp": "2026-02-14T09:15:22.104Z",
  "serverTime": "2026-02-14T09:15:22.104Z",
  "uptimeSeconds": 412,
  "environment": "production",
  "timezone": "Asia/Calcutta",
  "databaseDriver": "libsql",
  "databaseLabel": "remote libSQL (libsql://honest-org.turso.io)",
  "databaseIsEphemeral": false,
  "schedulerMode": "on_demand",
  "lastSchedulerRun": "2026-02-14T09:10:00.000Z"
}
```

| Field | Meaning |
| --- | --- |
| `status` | `ok`, or `degraded` when the database cannot be reached |
| `database` | `ok` or `unavailable` |
| `databaseError` | present only when the probe failed (never contains SQL or schema details) |
| `schemaVersion` | the live schema version read from the database |
| `timestamp` | server time, for monitor drift detection |
| `databaseDriver` | `local` (built-in `node:sqlite`) or `libsql` (remote Turso) |
| `databaseIsEphemeral` | `true` when the data will not survive the instance (warn and fix) |
| `schedulerMode` | `timer` (in-process interval) or `on_demand` (external cron) |
| `lastSchedulerRun` | when the accountability tick last executed |

---

## 14. Serverless scheduler (cron)

### `GET /api/cron/tick` · `POST /api/cron/tick`

On a serverless platform (Vercel) the process does not live long enough for an in-process timer, so
an external scheduler drives the accountability engine instead. `vercel.json` registers this
endpoint as a Vercel Cron job; GitHub Actions, cron-job.org or any monitor can call it too.

**Additive by design.** Every read endpoint already computes the current accountability state on
demand, so the product stays correct even if this endpoint is never called — the cron exists so
notifications (the 22:30 check, the "15 minutes left" warning, "Yesterday is waiting for an
explanation.") appear on time rather than on the next request.

**Authentication** — `CRON_SECRET`, supplied in any of three ways:

| Mechanism | Example |
| --- | --- |
| Vercel Cron (automatic) | `Authorization: Bearer $CRON_SECRET` |
| Header | `curl -H "x-cron-secret: $CRON_SECRET" .../api/cron/tick` |
| Query parameter | `.../api/cron/tick?secret=$CRON_SECRET` |

The comparison is constant-time. When `CRON_SECRET` is **not** configured the endpoint stays open,
reports `"required": false`, and flags itself in `issues` so the omission is visible.

**Response `200`**

```json
{
  "success": true,
  "tick": {
    "ranAt": "2026-02-14T09:10:00.412Z",
    "serverDate": "2026-02-14",
    "serverTime": "14:40",
    "timezone": "Asia/Calcutta",
    "durationMs": 38
  },
  "authorized": { "required": true, "via": "bearer" },
  "scheduler": { "mode": "on_demand", "ran": true, "created": 0, "evaluated": 0, "notificationsEnabled": true },
  "events": { "evaluated": 1, "created": 1, "notificationsEnabled": true },
  "accountability": {
    "isoDate": "2026-02-14",
    "status": "active",
    "isOffDay": false,
    "counts": { "total": 3, "completed": 1, "explained": 1, "unresolved": 1, "missed": 2 },
    "nightCheckActive": false,
    "hasUnresolvedYesterday": false,
    "canStartNewDay": true,
    "honestDays": 12
  },
  "pendingNotifications": [
    { "id": "7", "kind": "accountability", "message": "Be honest with yourself. You still have 1 unfinished promise today." }
  ],
  "issues": []
}
```

**Business meaning** — one call:

1. runs the accountability tick (idempotent: the UNIQUE `dedupe_key` means an event fires exactly
   once per day, however often this is called);
2. records the run so `/health` can report `lastSchedulerRun`;
3. reports the live accountability state;
4. audits for problems an operator should know about.

**Audit `issues[].code`**

| Code | Meaning |
| --- | --- |
| `CRON_SECRET_NOT_SET` | the endpoint is publicly callable |
| `EPHEMERAL_DATABASE` | the database will not survive an instance recycle — configure Turso |
| `NOTIFICATIONS_DISABLED` | settings have notifications switched off, so nothing will fire |
| `UNEXPLAINED_PAST_DAYS` | `n` past days still hold an unexplained promise (includes up to 10 dates) |

**Errors**

| Status | Code | When |
| --- | --- | --- |
| 401 | `CRON_UNAUTHORIZED` | missing or incorrect secret (with `details.reason`: `missing_secret` / `invalid_secret`) |

Scheduling examples:

```cron
# Vercel: vercel.json → crons[]  (Vercel injects CRON_SECRET automatically)
*/10 * * * *

# GitHub Actions
- cron: '*/10 * * * *'
  # run: curl -fsS -H "x-cron-secret: ${{ secrets.CRON_SECRET }}" https://APP/api/cron/tick
```

> Vercel Hobby accounts only permit daily cron schedules. The API is unaffected either way: reads
> recalculate accountability on demand, so nothing is silently missed.

---

## Appendix — worked end-to-end example

A complete evening, exactly as the frontend performs it.

```http
GET /api/today
→ 200 { "isoDate": "2026-10-05", "counts": { "total": 3, "unresolved": 3 }, "nightCheckActive": true }
```

```http
PUT /api/tasks/1/complete
→ 200 { "task": { "id": "1", "completed": true }, "state": "completed" }
```

```http
PUT /api/tasks/2/complete
→ 200 { "task": { "id": "2", "completed": true }, "state": "completed" }
```

```http
GET /api/night-check
→ 200 { "active": true, "unfinishedCount": 1,
        "message": "Be honest with yourself. You still have 1 unfinished promise today." }
```

```http
POST /api/night-check/reflect
{ "reason": "I got back late from college and club work took longer than expected." }
→ 200 { "message": "Reason recorded.",
        "note": "You don't need to justify it to us. You just needed to be honest with yourself.",
        "nextStep": "Start today.",
        "remainingUnresolved": 0, "dayResolved": true, "honestDays": 13 }
```

```http
GET /api/calendar/day/2026-10-05
→ 200 { "status": "active", "completed": 2, "total": 3, "explained": 1, "unresolved": 0,
        "reflection": "I got back late from college and club work took longer than expected." }
```

The next morning:

```http
GET /api/today
→ 200 { "isoDate": "2026-10-06", "hasUnresolvedYesterday": false, "canStartNewDay": true }
```

If that reflection had **not** been submitted:

```http
GET /api/today
→ 200 { "isoDate": "2026-10-06", "hasUnresolvedYesterday": true, "canStartNewDay": false,
        "reflection": { "required": true, "previousDate": "2026-10-05",
                        "targets": [ { "id": "3", "title": "30 min Workout" } ] } }
```

And the frontend shows *"Yesterday is waiting for an explanation."* until it is answered — enforced
by the backend, not by the browser.
