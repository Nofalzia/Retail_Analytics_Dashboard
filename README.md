# Retail Analytics Dashboard

A **multi-tenant SaaS dashboard** for independent retail stores. A store uploads its own
point-of-sale and inventory exports (CSV or XLSX) and the dashboard answers the three
questions a small retailer actually has:

- **What is happening?** — revenue, top products and store health (owner view).
- **What is about to go wrong?** — anomaly alerts and stockout watch (manager view).
- **What should I do about it?** — rule-based reorder suggestions with the revenue at risk.

The analytics layer is **rule-based / statistical only — no machine-learning libraries**.
Anomalies come from a per-product rolling z-score (`backend/src/services/rollingZScore.js`) and
suggestions from a decision rule set (`backend/src/services/recommendationEngine.js`), so every
alert can be explained to a shopkeeper in one sentence.

Ingestion is **streamed, not buffered**: the production route parses CSV with pause/resume,
writes 1,000-row batches and holds a flat ~50–62 MB peak RSS from 100,000 to 1,000,000 rows,
where a naive in-memory read peaks at ~484 MB
(see [Validation & published evidence](#validation--published-evidence)).

---

## Table of contents

- [Features by role](#features-by-role)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Data model](#data-model)
- [API](#api)
- [Getting started (Windows CMD)](#getting-started-windows-cmd)
- [Demo accounts](#demo-accounts)
- [npm scripts](#npm-scripts)
- [Validation & published evidence](#validation--published-evidence)
- [Project structure](#project-structure)
- [Deployment](#deployment)
- [Known limitations](#known-limitations)
- [Design conventions](#design-conventions)
- [Credits](#credits)

---

## Features by role

### Shared

- **Sign-in** with email + password + **store slug**; the API returns a JWT (7-day default) that
  `src/api/client.js` attaches as a Bearer token. Any `401` dispatches `rad:unauthorized` and the
  app returns to the login screen.
- **Five views** — Overview, Deep Analytics, Stockout Watch, Recommendations, Data Ingestion.
- **Preview switchers** — a role switcher (Owner / Manager) and a data-mode switcher
  (*Healthy Store* / *Struggling Store* / *New Tenant (No Data)*), so empty and edge states can be
  demonstrated without touching the database.
- **Light / dark theme** on a warm earth palette, inline SVG icons only (no icon package).

### Owner

**Overview** — revenue and order KPIs, a 14-day revenue trend, and a days-of-inventory health
indicator.

### Manager

- **Deep Analytics** — the store's threshold anomaly alerts (with a manual *Run Detection* control)
  and a baseline **scenario simulator** that projects margin from two levers (supply-chain cost
  increase / price adjustment). The simulator starts from **fixed sample baseline figures**
  (monthly revenue / COGS %), not the tenant's uploaded data.
- **Stockout Watch** — days-of-cover against recent velocity, ranked by urgency.
- **Recommendations** — generated from active alerts, with suggested quantity and revenue at risk;
  an acknowledge / complete flow.

### Data Ingestion

- **Live pipeline** — real `POST /api/upload` (CSV, XLSX, XLS), per-job progress polling, rows
  processed / rows failed and the server-side error log.
- **Per-row validation** (`backend/src/utils/validators.js`) — invalid rows are logged, not fatal.
- **File-level dedup** — a SHA-256 hash of the file stops the same file from being imported twice
  for one store (`uq_ingestion_file_per_store`, a partial index that ignores failed jobs).
- **Honest empty state** — a job that finishes having imported 0 rows is reported as
  *"Nothing imported"* on the ochre warning surface instead of a green success banner.

### Platform (not part of the storefront preview)

- Tenant identity is **always** taken from the JWT (`req.tenantId` via `middleware/tenant.js`),
  never from the request body or query string.
- `system_admin` exists in the `users` role enum for platform operations. It deliberately has no
  entry in the dashboard's role switcher and holds no financial view.

---

## Architecture

```
Browser — React 19 + Vite (src/)
  |  src/api/client.js        fetch wrapper, Bearer JWT from localStorage, VITE_API_URL
  v
Express API — backend/src/index.js
  |  helmet · CORS allow-list · rate limiters · GET /health · POST /api/auth/login
  |  middleware/auth.js       verifies the JWT -> req.user
  |  middleware/tenant.js     resolves the tenant -> req.tenantId
  v
Routes                            Services / utils
  routes/overview.js              services/rollingZScore.js        per-day baseline, guarded |z|
  routes/alerts.js                services/detectionEngine.js      persists alerts
  routes/stockout.js              services/recommendationEngine.js rule set
  routes/recommendations.js       utils/validators.js              per-row CSV validation
  routes/upload.js
  v
PostgreSQL — 10 tables + 4 read views, every query scoped by tenant_id
```

**Upload path (asynchronous — the API keeps serving requests while it runs):**

```
POST /api/upload
  -> multer writes to UPLOAD_TEMP_DIR (cap: MAX_FILE_SIZE_MB)
  -> SHA-256 hash -> ingestion_jobs row (status = processing)     duplicate file -> 409
  -> background: csv-parser stream (CSV only; XLSX/XLS are read into memory by SheetJS)
       -> 1,000-row batches -> products upsert + sale_transactions insert
       -> rows_processed / rows_failed / error_log refreshed every 5 chunks
  -> client polls GET /api/upload/:jobId/status until completed / failed
```

---

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | React 19, Vite 8, Tailwind CSS v4 (`@tailwindcss/postcss`), Chart.js 4 via `react-chartjs-2`, oxlint |
| Backend | Node >= 18 (ES modules), Express 4, `pg`, `jsonwebtoken`, `bcryptjs`, `multer`, `csv-parser`, `xlsx` (SheetJS), `helmet`, `express-rate-limit`, `dotenv` |
| Database | PostgreSQL |
| Tooling | Node scripts only — no test framework, no ML library, no icon package |

---

## Data model

Schema: `backend/db/schema.sql`. Idempotent migrations in `backend/db/migrations/` upgrade a
database created before a constraint existed (Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so
they are guarded by `pg_constraint` lookups and are safe to re-run).

### Tables

| Table | Purpose |
|---|---|
| `tenants` | one row per business; `slug` is the key typed at login |
| `users` | staff accounts — `owner`, `manager`, `data_entry_clerk`, `system_admin`; email unique **per tenant** |
| `stores` | outlets belonging to a tenant |
| `categories` | tenant-scoped product grouping |
| `products` | SKU, name, cost and price; SKU unique per tenant |
| `ingestion_jobs` | one row per upload: file type, SHA-256 `file_hash`, status, rows processed / failed, error log |
| `sale_transactions` | per-product, per-day sales (units, revenue) |
| `inventory_logs` | per-product, per-day stock |
| `anomaly_alerts` | detected anomalies: type, severity, expected vs actual, acknowledgement state |
| `recommendations` | rule-based actions derived from alerts (one per alert) |

### Read views

| View | Used for |
|---|---|
| `daily_revenue_by_store` | owner revenue trend |
| `product_daily_velocity` | rolling mean / σ inputs for the detection engine |
| `latest_inventory_per_product` | current stock for Stockout Watch |
| `active_anomaly_alerts` | unactioned alerts for the manager views |

Tenant isolation is enforced twice: every table carries `tenant_id` with an index that leads on
it, and every query adds `WHERE tenant_id = $1` using the value from the JWT.

---

## API

All `/api/*` routes are JWT-protected and tenant-scoped. Only `/health` and `/api/auth/login` are
open, and login carries its own strict rate limiter.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | liveness + database ping (used by the benchmark to prove the API stays responsive) |
| `POST` | `/api/auth/login` | `{ email, password, tenantSlug }` -> JWT |
| `GET` | `/api/overview` | owner KPIs and series |
| `GET` | `/api/alerts` | anomaly alerts for the tenant |
| `PATCH` | `/api/alerts/:id/ack` | acknowledge an alert |
| `PATCH` | `/api/alerts/:id/dismiss` | dismiss an alert |
| `POST` | `/api/alerts/run-detection` | run the rolling z-score engine and persist alerts |
| `GET` | `/api/stockout` | days-of-cover / stockout risk ranking |
| `GET` | `/api/recommendations` | open and completed recommendations |
| `POST` | `/api/recommendations/generate` | derive recommendations from active alerts |
| `PATCH` | `/api/recommendations/:id/complete` | mark a recommendation done |
| `POST` | `/api/upload` | multipart CSV / XLSX upload -> `{ jobId }`, processed asynchronously |
| `GET` | `/api/upload/:jobId/status` | job progress, `rows_processed`, `rows_failed` |

---

## Getting started (Windows CMD)

**Prerequisites:** Node.js >= 18, npm, and PostgreSQL with `psql` on `PATH`.

```cmd
:: 1. Frontend dependencies (repo root)
git clone https://github.com/Nofalzia/Retail_Analytics_Dashboard.git
cd Retail_Analytics_Dashboard
npm install

:: 2. Backend dependencies + local env file
cd backend
npm install
copy .env.example .env
```

Open `backend\.env` and set at least `DATABASE_URL` (your PostgreSQL connection string) and
`JWT_SECRET` (a long random string — the template shows a one-liner that generates one).

```cmd
:: 3. Create the schema (still in backend\)
set DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@localhost:5432/retail_analytics
psql "%DATABASE_URL%" -f db/schema.sql

:: 4. Seed the demo tenant, users and 90 days of history
npm run seed:reset

:: 5. Start the API (http://localhost:3001)
npm run dev
```

> `npm run db:migrate` is a thin wrapper for `psql $DATABASE_URL -f db/schema.sql`. CMD does not
> expand `$DATABASE_URL`, so use the `psql "%DATABASE_URL%" ...` line above, or run the npm script
> from Git Bash. Upgrading a database that already exists? Run the files in `backend/db/migrations/`
> the same way — they are idempotent.

```cmd
:: 6. Frontend (new CMD window, from the repo root)
copy .env.example .env
npm run dev
```

Open **http://localhost:5173**. The API must be running, and its `CORS_ORIGIN` must list this origin
(`http://localhost:5173` in the template).

### Environment variables

No secrets live in the repository — `.env` is gitignored and only the `.example` templates are
committed.

| Variable | File | Purpose |
|---|---|---|
| `VITE_API_URL` | `.env` (frontend) | Base URL of the API, default `http://localhost:3001`; inlined at build time |
| `DATABASE_URL` | `backend/.env` | PostgreSQL connection string |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | `backend/.env` | Token signing key and lifetime (default `7d`) |
| `PORT`, `NODE_ENV` | `backend/.env` | API port (default `3001`) and environment |
| `MAX_FILE_SIZE_MB`, `UPLOAD_TEMP_DIR` | `backend/.env` | Upload size cap (default `25`) and multer temp directory |
| `CORS_ORIGIN` | `backend/.env` | Comma-separated list of allowed frontend origins |

---

## Demo accounts

`npm run seed:reset` recreates the demo tenant (`demo-kiryana`), 4 categories, 12 products, both
users and 90 days of transactions, so the charts have something real to draw.

| Role | Email | Password | Tenant slug |
|---|---|---|---|
| Owner | `owner@demo.com` | `Demo@1234` | `demo-kiryana` |
| Manager | `manager@demo.com` | `Demo@1234` | `demo-kiryana` |

---

## npm scripts

| Where | Script | What it does |
|---|---|---|
| root | `npm run dev` | Vite dev server (http://localhost:5173) |
| root | `npm run build` | production build into `dist/` |
| root | `npm run lint` | oxlint over the frontend |
| root | `npm run preview` | serve the built bundle locally |
| `backend/` | `npm run dev` | API with `node --watch` |
| `backend/` | `npm start` | plain `node src/index.js` (production) |
| `backend/` | `npm run seed:reset` | reset + reseed the demo tenant |
| `backend/` | `npm run db:migrate` | `psql $DATABASE_URL -f db/schema.sql` |
| `backend/` | `npm run test:zscore` | rolling z-score self-test (assertions, no database) |
| `backend/` | `npm run validate:detection` | v1 detection validation harness |
| `backend/` | `npm run validate:detection:v2` | v2 detection validation harness (writes into `docs/validation/`) |
| `backend/` | `npm run smoke:recs` | recommendation-engine smoke run |
| `backend/` | `npm run bench:parse` | naive vs streamed parse, median of 3 child processes |
| `backend/` | `npm run bench:ingest` | end-to-end ingestion through the real HTTP route |

`set INGEST_DEBUG=1 && npm run bench:ingest` (run from `backend/`) also prints the per-chunk
statement count.

---

## Validation & published evidence

Full reports and their raw results live in [`docs/validation/`](docs/validation); every number below
is quoted from those files.

### Detection quality — rolling z-score (`detection_results_v2.md`)

Exact `(SKU, date)` matching with no date fuzziness, over a 90-day synthetic series with injected
anomalies. Parameters were frozen on development seeds 1–5, then the harness was run **unchanged** on
held-out seeds 6–10.

| Seeds | v1 precision / recall / F1 | v2 precision / recall / F1 |
|---|---|---|
| dev (1–5) | 0.137 / 0.761 / 0.232 | **0.388 / 0.539 / 0.450** |
| hold-out (6–10) | 0.141 / 0.778 / 0.238 | **0.379 / 0.544 / 0.446** |

v2 replaces one global mean/σ — which a large anomaly inflates, hiding itself — with a
previous-14-**calendar**-day baseline per product, zero-filled on days with no sale, σ floored at the
Poisson counting-noise level, and three guards that must all pass (`|z| >= 2.5`, relative deviation
>= 25 %, absolute deviation >= 3 units). F1 roughly doubles while flags per seed drop from ~201 to
~50, which is the precision-first trade the storefront needs. On the held-out seeds neither
fixed-percentage baseline comes close: a 30 % deviation rule scores precision 0.072 / recall 0.900 /
F1 0.134 and a 50 % rule 0.168 / 0.722 / 0.270, against v2's 0.379 / 0.544 / 0.446. v2 beats both
baselines on precision and F1 and only concedes on recall.

### Ingestion scalability (`ingestion_benchmark.md`)

Parse benchmark, median of 3 isolated child processes — the streamed parser keeps a **flat memory
profile**:

| rows | naive peak RSS | stream peak RSS |
|---|---|---|
| 100,000 | 107.3 MB | 50.0 MB |
| 250,000 | 175.9 MB | 54.4 MB |
| 500,000 | 306.5 MB | 54.6 MB |
| 1,000,000 | 483.7 MB | 61.6 MB |

End-to-end through the real `POST /api/upload`, against a remote PostgreSQL (~151 ms per round-trip):

| rows | seconds | rows/s | health median | rows processed | rows failed |
|---|---|---|---|---|---|
| 10,000 | 6.9 | 1,458 | 152 ms | 10,000 | 0 |
| 50,000 | 15.9 | 3,142 | 153 ms | 50,000 | 0 |
| 100,000 | 28.4 | 3,518 | 151 ms | 100,000 | 0 |

Moving from 250-row chunks with 4 statements each to 1,000-row chunks with ~1.2 statements each made
ingestion **4.29× / 8.14× / 9.64×** faster at those sizes, while `GET /health` stayed flat (median
152 ms idle vs 151 ms during the 100,000-row import — the event loop is not starved). The benchmark
asserts `rows_processed == file rows` and `rows_failed == 0` on each run.

---

## Project structure

```
Retail_Analytics_Dashboard/
+- src/                          React app (entry: src/main.jsx -> src/App.jsx)
|  +- api/client.js              fetch wrapper, Bearer JWT, VITE_API_URL
|  +- components/
|  |  +- auth/LoginScreen.jsx
|  |  +- dashboard/              BusinessOwnerDashboard, StoreManagerDashboard,
|  |  |                          StockoutPrediction, RecommendationsPanel
|  |  +- ingestion/              DataIngestionHub (live pipeline + preview states)
|  |  +- layout/DashboardShell.jsx   sidebar, header, role + data-mode switchers
|  +- context/                   AuthContext, ThemeContext (useDesignTokens)
+- backend/
|  +- src/
|  |  +- index.js                Express app, helmet, CORS, rate limiters, /health, /api/auth/login
|  |  +- middleware/             auth.js (JWT -> req.user), tenant.js (-> req.tenantId)
|  |  +- routes/                 overview, alerts, stockout, recommendations, upload
|  |  +- services/               rollingZScore, detectionEngine, recommendationEngine
|  |  +- utils/validators.js     per-row CSV validation + error log
|  |  +- seed.js                 demo-tenant reset + reseed
|  +- db/                        schema.sql + migrations/ (002-004, idempotent)
|  +- scripts/                   benchmark/ and validation/ harnesses, smoke tests
+- docs/validation/              published reports (md) and raw results (csv / json)
```

---

## Deployment

- **Frontend — Vercel.** Import the repo, set `VITE_API_URL` to the deployed API URL *before*
  building (`VITE_*` values are inlined at build time), then deploy. The root `build` script is all
  Vercel needs.
- **Backend — any Node host** (Railway, Render, Fly, ...). Set `DATABASE_URL`, `JWT_SECRET`,
  `CORS_ORIGIN` (the Vercel URL) and `PORT`, then start with `npm start`. `UPLOAD_TEMP_DIR` must be
  writable; on an ephemeral filesystem the temp files vanish on restart, which is harmless because
  every row is streamed into the database during the job.
- **Database — managed PostgreSQL** (Neon, Supabase, Railway, ...). Paste the provider's connection
  string into `DATABASE_URL`, then run `psql "$DATABASE_URL" -f db/schema.sql` and
  `npm run seed:reset` once against the hosted database.
- **Secrets stay out of git.** `.env` files, upload scratch space, generated benchmark CSVs and local
  agent/editor tooling are all ignored (see `.gitignore`); only the `*.example` templates are
  committed.

---

## Known limitations

- **Single machine.** The published figures come from one host (i5-12450H, 7.7 GB RAM, Node 24) with a
  remote database, and the end-to-end runs are single-shot per size — indicative, not a
  distributed-system result.
- **Round-trip latency dominates ingestion, not parsing.** Roughly two thirds of a 100,000-row import
  is database round-trips. The next real lever is one round-trip per file (`COPY ... FROM STDIN`) or a
  database nearer the API, not more JavaScript tuning.
- **XLSX files are parsed in memory, bounded by the 25 MB upload cap.** Streaming applies to CSV;
  the SheetJS path reads the whole workbook before rows are written.
- **Synthetic data.** Validation uses uniformly random rows from a seeded PRNG; real exports have
  skewed distributions, encoding quirks and duplicate SKUs.
- **Detection is deliberately conservative.** Precision stays below 0.5 by design: the guards trade
  recall for fewer false positives, because a shopkeeper who is warned twenty times a week stops
  believing the alerts.
- **No job queue.** Upload processing runs inside the API process, so a crash mid-job leaves that job
  in `processing` until it is retried by hand.
- **One deliberate constant split.** The parse benchmark's `CHUNK_SIZE = 250` differs from the upload
  route's `CHUNK_ROWS = 1000`; the published parse numbers were produced at 250 and the benchmark
  measures parsing only. Both constants say so in a comment.

---

## Design conventions

- **Generic entities only** — Product, Category, SaleTransaction, InventoryLog. No industry-specific
  vocabulary in the schema, variables or components, so the same build serves any store.
- **Tenant safety first** — `req.tenantId` from the JWT is the only accepted source of tenant identity.
- **Warm Euro-Asian minimalist UI** — colours come from `useDesignTokens()` (`PALETTE`, `EARTH`,
  `ALERT_SURFACE`), icons are inline SVG at a 1.5 px stroke, and money is rendered only through
  `formatLocalCurrency()`.
- **Explainable analytics** — rule-based / statistical logic only; no ML dependency, no hidden model.
- **Node scripts over frameworks** — validation, smoke tests and benchmarks are plain Node files that
  can run against a real database with no extra infrastructure.

---

## Credits

- **Developer:** Nofal Zia
- **Supervisor:** <!-- TODO: add supervisor name -->
- **Institution:** Bahria University Islamabad
- **Term:** Fall 2026

