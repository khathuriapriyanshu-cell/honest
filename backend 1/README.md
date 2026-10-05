# HONEST — Backend

**Be honest with yourself.**

Backend for the HONEST student accountability app. Node.js + Express + SQLite,
one dependency (Express), zero native modules (uses Node's built-in
`node:sqlite`).

> Plan → Promise → Do → Admit → Reflect → Start Again

The product principle baked into every endpoint: **completion is good, and
honesty is also valuable.** A completed task and a missed-but-explained task
are two different successful states; a missed-and-unexplained task is the only
unresolved one. The backend never shames — messages are factual and kind.

## Quick start

```bash
npm install
npm start          # http://localhost:3000  (the frontend's default)
npm test           # 33 tests: dates, tasks, daily cycle, midnight, timezone,
                   #            grace, off-day, reports, honesty, persistence
```

Options: `PORT=4000 node server.js` · `HONEST_DB_PATH=./data/honest.sqlite node server.js`

The database file (`database/honest.sqlite`) is created and all tables are
initialized automatically on first boot. Data persists across restarts.

## Project structure

```
backend-1/
├── server.js                  entry point: boot + 30s accountability tick
├── app.js                     app factory (tests inject a controlled clock)
├── package.json
├── API.md                     full API documentation
├── database/
│   ├── db.js                  SQLite driver wrapper (prepared statements)
│   └── schema.js              tables + default settings
├── routes/                    HTTP layer (thin; one file per resource)
├── services/                  business logic (the actual product rules)
├── middleware/errorHandler.js consistent JSON errors
├── utils/                     dates (timezone math), validation, errors
└── test/                      node:test suites (injectable clock)
```

## How it works

**Dates & timezone.** `utils/dates.js` does all timezone math via `Intl`
(DST-safe, no dependencies). The settings' timezone (`"auto"` = server zone)
decides today's date, midnight, the accountability deadline, the grace window,
reports — everything. The server clock is the only authority; the browser
clock is never consulted.

**Tasks & schedules.** A task's repeat rule lives in versioned `task_schedules`
rows. Editing the rule closes the old row and opens a new one from today, so
past dates keep their original schedule — later edits never rewrite history,
and completions stay put. DELETE is a soft deactivate; history is preserved.

**Accountability state machine.** Within a day: `open` → `accountability`
(at the accountability time, default 22:30) → `grace_ended` (grace expired,
default 15 min) → `final_warning` (last grace minutes before the daily reset,
default 00:00). At midnight the new day computes yesterday's state: any
unexplained miss ⇒ yesterday is unresolved ⇒ `canStartToday: false` until the
misses get reflections. All of it is computed live from SQLite + clock on
every request, so correctness never depends on a timer. A 30 s tick
additionally records phase transitions into an `events` audit table
(deduplicated per type+date).

**Off days.** Activatable only before that date's deadline (accountability +
grace). After it, the backend rejects retroactive off days — history stays
honest.

**Honest Days & Honest Score.** An Honest Day = green (all completed) or
yellow (all misses explained). The score is a deterministic, documented
formula (`0.5·completion + 0.3·explanation + 0.2·consistency`) tunable in
`services/honestyService.js`. No fake numbers anywhere: empty data returns
`null`/empty states.

## Business rules the backend enforces (frontend cannot bypass)

1. Completions only while a day is open — after its reset, only a reflection.
2. Reflections only for actually-scheduled, not-completed promises.
3. Off days never retroactive past their deadline (and locked once passed).
4. Schedule edits and task starts cannot affect dates before today.
5. Tasks cannot start in the past.
6. All inputs validated server-side; all SQL parameterized.
7. Settings keep the phase machine well-ordered (`reset < accountability`).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (frontend default) |
| `HONEST_DB_PATH` | `database/honest.sqlite` | SQLite file location |

## Frontend integration

The bundled frontend (`E:\APPP\frontend`) works as-is: its documented
endpoints are implemented with the same field names, errors carry a top-level
`message`, and CORS is open. See [API.md](API.md) for every endpoint,
including which responses carry a flat frontend projection alongside the
canonical `data` payload.
