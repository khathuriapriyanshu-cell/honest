# HONEST — backend

**BE HONEST WITH YOURSELF.**

The backend for HONEST, a student accountability application built around one loop:

> **Plan → Promise → Do → Admit → Reflect → Start Again**

This is not a generic to-do clone. The product's central distinction is:

- a task that was **completed** is one successful outcome, and
- a task that was **missed but honestly explained** is a *different, also legitimate* outcome from
  a task that was **missed and never looked at**.

The backend preserves that distinction in the database, in the API and in every statistic it
computes. It never shames the user, never invents data, and never trusts the browser for anything
it can determine itself.

This is the implementation assigned to `backend-3` (`E:\APPP\backend-3`, also reachable as
`E:\appp\backend 3`).

---

## Quick start

```powershell
cd "E:\APPP\backend-3"
npm install          # express + cors (SQLite is built into Node)
npm start            # http://localhost:3000/api
```

Then open <http://localhost:3000/api> for the live endpoint index, or
<http://localhost:3000/health> for a health check.

Requirements: **Node.js 22.5 or newer** (the built-in `node:sqlite` module is used, so there is no
native build step and no third-party database dependency).

```powershell
npm test                      # full behaviour suite (~930 assertions)
npm test -- honest days       # only tests whose name contains "honest days"
node scripts/verify-api.js    # contract check against an already-running server
npm run reset-db              # delete the database and start from a clean slate
npm run audit                 # report unused imports / orphan exports
```

Other scripts:

| Command | Purpose |
| --- | --- |
| `npm start` | start the API server |
| `npm run dev` | start with file watching (`node --watch`) |
| `npm test` | run the behaviour test suite |
| `npm run verify` | end-to-end contract check against a running server |
| `npm run smoke` | boot on a temporary database and print real responses |
| `npm run audit` | static hygiene checks |
| `npm run reset-db` | remove the SQLite file so the next start recreates it |

### Environment variables

Every variable is documented inline in [`.env.example`](.env.example) (copy it to `.env` for local
development).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port (the frontend expects 3000) |
| `NODE_ENV` | `development` | `production` enables production diagnostics |
| `HONEST_DB` | `./data/honest.db` | SQLite path, `:memory:`, `file:` URL, or a libSQL URL |
| `TURSO_DATABASE_URL` | — | remote libSQL/Turso endpoint (takes priority over `HONEST_DB`) |
| `TURSO_AUTH_TOKEN` | — | Turso auth token |
| `HONEST_TIMEZONE` | `automatic` | IANA zone for every date-sensitive rule |
| `ALLOWED_ORIGINS` | `*` | comma separated CORS allow-list with wildcard patterns |
| `CRON_SECRET` | — | protects `GET /api/cron/tick` on serverless platforms |
| `HONEST_DISABLE_SCHEDULER` | — | `1` disables the in-process accountability timer |
| `HONEST_SCHEDULER_INTERVAL_MS` | `30000` | in-process tick interval |
| `HONEST_DB_PERSISTENT` | — | `1` trusts a local path even where it looks temporary |
| `HONEST_FRONTEND_DIR` | `E:\APPP\frontend` if it exists | optional folder served statically |
| `HONEST_SQL_LOG` | — | `1` logs every SQL statement (debugging) |
| `HONEST_TIME_OFFSET_MIN` | `0` | shifts "now" by N minutes (simulation only) |

---

## Deployment

The backend runs unmodified in three shapes. All three expose the same REST API.

### 1. Long-running process (local, Docker, VPS, Render, Railway, Fly.io)

```bash
npm install
npm start          # or: docker run -p 3000:3000 -v honest-data:/app/data honest-backend
```

The in-process scheduler ticks every 30 seconds, so accountability notifications appear on time
without any external trigger. Point `HONEST_DB` at a mounted volume (for example
`/var/data/honest.db`) so the database survives redeploys.

### 2. Vercel (serverless) with a hosted database

Serverless filesystems are wiped between invocations, so a local SQLite file **cannot** be the
database. Use Turso (hosted libSQL — the same SQLite engine):

1. Create a database at <https://turso.tech> and copy its URL and token.
2. In Vercel → **Settings → Environment Variables**, add:
   - `TURSO_DATABASE_URL` = `libsql://<database>-<org>.turso.io`
   - `TURSO_AUTH_TOKEN` = `eyJhbGciOi...`
   - `CRON_SECRET` = a long random string (`openssl rand -hex 32`)
   - `ALLOWED_ORIGINS` = e.g. `https://*.vercel.app,capacitor://localhost,https://localhost`
   - `NODE_ENV` = `production`
3. Deploy. `vercel.json` builds `api/index.js` as the function and rewrites every path to it, so
   `/api/...` works exactly as it does locally.

The scheduler is automatically switched to **on-demand** mode on Vercel (`VERCEL` is detected), and
`vercel.json` registers a cron that calls `/api/cron/tick` every 10 minutes. Vercel sends
`CRON_SECRET` automatically as a bearer token; any other scheduler can send
`x-cron-secret: <secret>` or `?secret=<secret>`:

```bash
# GitHub Actions, cron-job.org, UptimeRobot, etc.
curl -fsS -H "x-cron-secret: $CRON_SECRET" https://your-app.vercel.app/api/cron/tick
```

> Vercel Hobby accounts only allow **daily** cron jobs. Deploying the `*/10` schedule may require a
> Pro plan; on Hobby, either relax the schedule or trigger the endpoint from GitHub Actions. The API
> itself is unaffected either way — every read endpoint recalculates the accountability state on
> demand, so the product stays correct even if the cron never runs.

### 3. Any other serverless platform

`api/index.js` exports the Express app itself, so it works as a function handler anywhere
(AWS Lambda via `serverless-http`, Netlify Functions, Cloudflare-style Node runtimes). Serverless
detection covers `VERCEL`, `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY`, `CF_PAGES` and
`FUNCTIONS_WORKER_RUNTIME`.

### Health and readiness

For uptime monitors and App Center health checks:

```bash
curl -s https://your-app.vercel.app/health
curl -s https://your-app.vercel.app/api/health     # identical payload
```

```json
{
  "success": true,
  "status": "ok",
  "database": "ok",
  "schemaVersion": 3,
  "timestamp": "2026-02-14T09:15:22.104Z",
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

Both routes always answer **HTTP 200**: monitors care about the body, and `status: "degraded"` with
`database: "unavailable"` is far more useful than a bare 500.

### Database drivers

| Configuration | Driver | Use |
| --- | --- | --- |
| nothing, or `HONEST_DB=./data/honest.db` | built-in `node:sqlite` | local, Docker, VPS, persistent volumes |
| `HONEST_DB=:memory:` | built-in `node:sqlite` | tests (nothing is persisted) |
| `TURSO_DATABASE_URL` / `HONEST_DB=libsql://…` | libSQL over HTTP | Vercel and other serverless platforms |

Both drivers speak the same synchronous API, so **the REST API, the business rules and the test
suite are identical** whichever one is active. The remote driver is documented in
`database/drivers/libsql.js`; connection pragmas are answered locally, and every statement batch
travels to Turso as a single pipeline request.

If `HONEST_DB` points at a directory that is neither writable nor creatable, the backend falls back
to a temporary file and **prints a loud warning** rather than crashing — the API stays up, and the
warning tells you exactly what to configure.


---

## Where the truth lives

The backend is the single source of truth for:

| Concern | Why the backend owns it |
| --- | --- |
| **"today"** | resolved from the server clock in the user's configured timezone — never the browser clock |
| **which promises belong to a date** | recurrence rules (`once`, `daily`, `selected` weekdays) are evaluated server-side |
| **completed vs missed-explained vs missed-unexplained** | derived from durable occurrence rows, not from client state |
| **daily closure & midnight rollover** | the previous day must be answered before the new day is considered started |
| **accountability time & grace period** | computed from settings + timezone; the frontend only displays the result |
| **off-day eligibility** | the non-retroactive deadline is enforced against the server clock |
| **history, weekly reports, Honest Score, Honest Days** | calculated from persisted rows; nothing is hardcoded |
| **notification scheduling** | the backend decides which accountability events exist and records them once each |

The frontend may *displays* these things. It may not decide them.

---

## Project structure

```
backend-3/
├── server.js                  entry point for a long-running process
├── api/
│   └── index.js               Vercel / serverless entry point (exports the Express app)
├── bootstrap.js               application lifecycle: lazy database, scheduler, banner
├── vercel.json                Vercel build, routing and cron configuration
├── .env.example               every environment variable, documented
├── app.js                     Express assembly, CORS, health, endpoint index
├── package.json
├── API.md                     full API reference (start here to integrate)
├── README.md                  this file
├── config/
│   ├── env.js                 environment parsing + database target resolution
│   └── cors.js                ALLOWED_ORIGINS parsing and origin matching
├── database/
│   ├── schema.js              the DDL, with the reasoning behind each table
│   ├── db.js                  open/migrate/seed, driver selection
│   ├── helpers.js             tiny query/transaction wrappers (all SQL parameterised)
│   └── drivers/
│       ├── index.js           driver registry (local vs libSQL)
│       ├── libsql.js          remote libSQL/Turso driver, node:sqlite-compatible
│       ├── libsqlChild.js     the process that performs the HTTP round trip
│       └── libsqlProtocol.js  Hrana request/response encoding (pure, unit tested)
├── services/                  the business rules — no HTTP knowledge in here
│   ├── taskService.js         promises: create/update/deactivate + recurrence resolution
│   ├── occurrenceService.js   the durable "what happened on this date" record
│   ├── dayService.js          daily state: today's promises, closure, night check windows
│   ├── reflectionService.js   reasons: submission, attribution, archive queries
│   ├── offDayService.js       off days and the non-retroactive deadline rule
│   ├── historyService.js      calendar month/day/range history
│   ├── statsService.js        weekly report, Honest Score, Honest Days
│   ├── insightService.js      archive search + deterministic behavioural patterns
│   ├── notificationService.js accountability events (idempotent, restart-safe)
│   └── settingsService.js     validated settings + resolved runtime configuration
├── routes/                    thin HTTP layer: validate, call a service, shape the response
│   ├── dayRoutes.js  taskRoutes.js  nightCheckRoutes.js  calendarRoutes.js
│   ├── reportRoutes.js  settingsRoutes.js  offDayRoutes.js  notificationRoutes.js
│   ├── cronRoutes.js          the secured serverless scheduler endpoint
│   └── helpers.js             shared payload builders
├── middleware/
│   ├── respond.js             the `{ success, ... }` envelope
│   └── errorHandler.js        the single place errors become documented JSON
├── scheduler/
│   └── scheduler.js           the accountability tick (timer or on-demand)
├── utils/
│   ├── time.js                timezone + calendar-date mathematics
│   ├── clock.js               injectable "now" (also used to simulate midnight in tests)
│   ├── cronAuth.js            constant-time CRON_SECRET verification
│   ├── validate.js            input validation for every field the API accepts
│   └── errors.js              typed application errors with stable codes
├── scripts/
│   ├── smoke.js               boots the app on a temp database and prints real responses
│   ├── verify-api.js          end-to-end contract check against a running server
│   ├── start-probe.js         used by the process-level test
│   ├── audit-unused.js        static hygiene: unused imports
│   ├── audit-exports.js       static hygiene: orphan exports
│   └── reset-db.js            delete the database safely
└── tests/                     the behaviour suite (see "Tests" below)
```

The rule used throughout: **routes do not contain business logic, and services do not contain
HTTP concerns.** Services receive `{ db, clock }` explicitly instead of importing a global, which
is what lets the test suite run the entire application against a temporary database with a
simulated clock.

---

## Database

SQLite, created automatically on first start at `data/honest.db` (WAL mode, foreign keys on).
All state survives restarts; nothing meaningful is kept in memory.

| Table | Holds |
| --- | --- |
| `tasks` | the promise: name, category, repeat type, selected weekdays, reminder, accountability time, minimum completion definition (+ reserved structured form), start/end dates, status, inactive-from, frozen snapshot |
| `task_occurrences` | one row per (promise, date) that was actually answered: `completed` / `missed_explained` / `missed_unexplained`, plus the promise text **frozen at answer time** |
| `reflections` | the honest reason: date, promise, frozen name, reason text, source, timestamp |
| `off_days` | declared off days with reason, activation instant and the deadline that was in force |
| `notification_log` | every accountability event the scheduler fired, with a UNIQUE `dedupe_key` so each fires once per day |
| `settings` | single-user key/value configuration |
| `meta` | schema version and the persisted clock offset |

Design notes worth knowing:

- **Timestamps are UTC ISO strings; calendar dates are `YYYY-MM-DD` strings already expressed in
  the user's timezone.** Day grouping is therefore a string comparison and can never drift.
- **History is immutable in practice.** When a promise is answered, its name, definition and
  category are copied onto the occurrence. Editing or deactivating a recurring promise later
  cannot rewrite what an earlier day said.
- **Deleting is deactivation by default.** A promise with recorded history cannot be erased at all
  (`409 TASK_HAS_HISTORY`) — history stays honest.
- Migrations are additive and idempotent: an existing database is upgraded in place, never dropped.

---

## How the daily loop works

```
        ┌────────────────────────────────────────────────────────────┐
        │  the backend resolves "today" in the user's timezone        │
        │  and decides which promises fall on it (recurrence rules)   │
        └────────────────────────────────────────────────────────────┘
                          │
   complete ──────────────┼────────────── leave unanswered
        │                                  │
        ▼                                  ▼
  occurrence.status                  at the accountability time
  = completed                        the night check opens with the real count
                                           │
                                           ├── finish it (allowed until the daily reset,
                                           │   and for yesterday during the grace window)
                                           │
                                           └── or submit a reflection
                                                   │
                                                   ▼
                                        occurrence.status = missed_explained
                                                   │
                                                   ▼
   after the daily reset ──► the previous day must be answered before the new day starts
                              ("Yesterday is waiting for an explanation.")
```

Two windows matter:

- **accountability time** (default `22:30`) — the night check becomes active with the real number
  of unfinished promises.
- **grace period** (default 15 minutes) — measured backwards from the daily reset (default `00:00`),
  which is exactly why "15 minutes left" is accurate. Inside this window yesterday's promises can
  still be *completed*; after it, a past day can only be *explained*.

---

## Honest Score

The score is deterministic, bounded 0–100, and documented in `services/statsService.js` next to the
weights. Summarised:

```
completionScore   = 100 * completed / (completed + missed)
explanationScore  = 100 * explained / missed                     (no misses -> 100)
followThrough     = 100 * explained / (explained + unexplained)
noUnansweredBonus = 100 when unexplained === 0, else 0

HONEST SCORE = round( 0.55*completionScore
                    + 0.30*explanationScore
                    + 0.10*followThrough
                    + 0.05*noUnansweredBonus )
```

Rationale: keeping promises matters most, but honestly explaining what you missed is worth nearly
as much — and ignoring a miss can never raise the score. Change the weights in `SCORE_WEIGHTS` and
nothing else needs to move.

## Honest Days

An **honest day** is *not* a completion streak. A day is honest when every promise on it was kept,
**or** every missed promise received an honest reason, **or** the day was declared an off day.
Days with nothing promised are neutral and are not counted. This is why "23 missed, 23 explained,
0 unexplained" is a good month here.

---

## Behaviour when there is no data

With an empty database every number is a real zero and every label is honest:

```json
{ "totalCount": 0, "completedCount": 0, "completionRate": 0,
  "mostConsistent": "None yet", "mostSkipped": "None yet", "commonReason": null }
```

No sample promises, no demonstrative statistics, no invented streak. The tests assert this.

---

## Tests

`npm test` runs **722 assertions across 8 suites**, each against its own temporary database and a
simulated clock anchored at `2026-10-05T12:00Z` (a Monday), so midnight, grace-period and
off-day-deadline behaviour is deterministic rather than dependent on when the suite happens to run.

| Suite | Covers |
| --- | --- |
| `01-database` | automatic creation, schema, constraints, additive migration of an older file, persistence across close/reopen |
| `02-time` | timezone resolution, UTC↔local conversion, DST transitions, date validation, month/leap handling, clock persistence |
| `03-tasks` | promise CRUD, validation, daily/selected/one-time recurrence, completion & undo, history immutability, safe deactivation |
| `04-day` | daily state shape, empty states, timezone authority, midnight rollover, grace window, past-day closure, custom daily reset, off-day suspension |
| `05-reflection-offday` | reasons recorded per promise, rejected reasons, carry-over attribution, off-day eligibility and the non-retroactive rule |
| `06-analytics` | weekly report from real rows, Honest Score formula & determinism, Honest Days & streaks, calendar statuses, archive search, insights, notification dedupe, backlog |
| `07-api-contract` | documented response shapes for every frontend endpoint, error codes, malformed JSON, unknown routes, oversized bodies, CORS/preflight, and a check that **no response contains shaming language** |
| `08-persistence` | full restart persistence, history accuracy, scheduler not re-notifying, settings and off days surviving, and the real `npm start` process answering a real request and shutting down cleanly |
| `09-production` | CORS allow-list matching (including lookalike-host and scheme attacks), `CRON_SECRET` enforcement and the tick audit, environment parsing, database-target resolution, driver selection, the libSQL/Hrana protocol (offline), lazy bootstrapping, both health routes, and the Vercel entry-point contract |

The libSQL driver is verified **without any network access**: the Hrana encoding/decoding is unit
tested directly, and the adapter is exercised against a stand-in executor that returns exactly the
shape the helper process produces. Only the thin HTTP round trip itself is left to a real Turso
deployment.

`node scripts/verify-api.js` additionally walks the documented frontend contract against a
*running* server over HTTP (36 checks) and prints every response.

Manual time travel for exploring the evening flow:

```powershell
$env:HONEST_TIME_OFFSET_MIN="810"   # jump 13.5 hours ahead
npm start
```

---

## API

See **[API.md](API.md)** for every endpoint with request bodies, query parameters, response
examples, error codes and the business meaning behind each one. `GET /api` returns the same index
as JSON, so integration never requires guessing.

Quick summary of the surface:

| Group | Endpoints |
| --- | --- |
| Daily | `GET /today`, `GET /day?date=`, `GET /time` |
| Promises | `GET|POST /tasks`, `GET /tasks/:id`, `PUT|PATCH|DELETE /tasks/:id`, `PUT /tasks/:id/complete`, `PUT /tasks/:id/uncomplete` |
| Accountability | `GET /night-check`, `POST /night-check/reflect`, `GET /notifications`, `POST /notifications/:id/ack` |
| Off days | `POST /off-day`, `GET /off-day`, `GET /off-days`, `DELETE /off-day/:date` |
| History | `GET /calendar`, `GET /calendar/day/:date`, `GET /history`, `GET /archive?q=` |
| Analytics | `GET /report/weekly`, `GET /stats/score`, `GET /stats/honest-days`, `GET /insights` |
| Config | `GET /settings`, `PUT /settings`, `GET /health` |

---

## Accessibility of the backend

`npm start` also serves the sibling frontend folder (`E:\APPP\frontend`) from the same origin when
it exists, which removes CORS from the picture entirely during development. CORS is configured
permissively as well, so hosting the frontend elsewhere works too.

Only read from `E:\APPP\frontend` ever happens — this backend never writes to it.

---

## Principles the code is held to

1. **No fabricated data.** Empty means empty. Every statistic is derived from rows in the database.
2. **No hardcoded results.** Completion rates, scores, streaks and calendar statuses are computed.
3. **The backend decides dates.** The browser clock is never authoritative.
4. **Validation everywhere.** No client input reaches SQL or a business rule unchecked.
5. **Honesty is a first-class outcome.** Missed-and-explained is modelled, stored and celebrated
   differently from missed-and-ignored.
6. **Never punitive.** No endpoint returns insulting or shaming language; a test enforces it.
7. **Simple architecture.** No queue, no ORM, no build step, no unnecessary dependency.
8. **Parameterised SQL only.** No string-concatenated queries, no raw SQL from clients.
9. **Honest errors.** A failure reports a real failure with a stable code — success is never faked.
