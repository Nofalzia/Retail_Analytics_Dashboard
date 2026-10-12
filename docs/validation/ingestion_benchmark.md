# Ingestion scalability benchmark (T8b → T8c)

Generated 2026-10-12T15:09:47.693Z · Node v24.15.0

> Evidence for the claim "efficient, non-blocking CSV parsing". Every end-to-end
> number comes from the REAL `POST /api/upload` route (`backend/src/routes/upload.js`):
> a streamed `csv-parser` with pause/resume and 1000-row batched inserts. The benchmark
> runs in the isolated tenant `validation-sandbox`; no other tenant is read or written
> (sale rows owned by other tenants: 2160 before → 2160 after).

## Method

- **Parse benchmark.** The same generated CSV is parsed twice per size: once the naive
  way (whole file in memory → array of row objects) and once through the production
  streamed parser. Each run is a fresh child process; median of 3 runs is reported.
- **End-to-end benchmark.** For each size, a CSV is generated, the sandbox tenant is
  cleared, and the file is uploaded through the real HTTP route. `GET /health` is pinged
  every 100 ms throughout; the per-size timeout is 20 min.
- **Determinism.** All synthetic rows come from `backend/scripts/validation/prng.js` (seed 20261012).
- **Round-trip economy (T8c).** The e2e pipeline used to issue 4 statements per 250-row
  chunk (~4 per chunk). T8c caches product ids per job, uses
  1000-row chunks and refreshes `rows_processed` every 5 chunks, which
  is ~1.2 statements per chunk in steady state. Row validation, error_log handling,
  file-hash dedup and tenant checks are unchanged.
- **Rate limiter.** The child server now runs on production defaults: a strict 20/15 min
  limiter on `POST /api/auth/login`, a 3000/15 min limiter on `/api` that exempts
  `GET /api/upload/:jobId/status`, and no limiter on `/health`. No override is needed,
  and any 429 seen by this script would be a regression rather than a config artefact.

## 1. Parse benchmark (naive vs stream)

Median of 3 isolated child-process runs per (size, mode); seed 20261012.
"naive" = `fs.readFileSync` + split lines/commas into an array of row objects.
"stream" = the same `csv-parser` the upload route uses, 250-row chunks, rows discarded.

| rows | mode | seconds | peak RSS (MB) | time ratio | RSS ratio |
|---|---|---|---|---|---|
| 100,000 | naive | 0.12 | 107.3 | 0.36× | 2.15× |
| 100,000 | stream | 0.32 | 50.0 | 1.00× | 1.00× |
| 250,000 | naive | 0.35 | 175.9 | 0.49× | 3.23× |
| 250,000 | stream | 0.71 | 54.4 | 1.00× | 1.00× |
| 500,000 | naive | 0.76 | 306.5 | 0.63× | 5.61× |
| 500,000 | stream | 1.21 | 54.6 | 1.00× | 1.00× |
| 1,000,000 | naive | 1.68 | 483.7 | 0.68× | 7.85× |
| 1,000,000 | stream | 2.47 | 61.6 | 1.00× | 1.00× |

## 2. End-to-end ingestion (real HTTP route) — T8c

Each file is uploaded via multipart `POST /api/upload`, then polled every 500 ms.
`GET /health` is pinged every 100 ms while the upload AND processing run, so the
latency columns are the "server stays responsive" evidence. The child server now runs
on the production rate-limit defaults — status polling is exempt, so raising
`RATE_LIMIT_MAX` is no longer needed to benchmark.

| rows | seconds | rows/s | health median (ms) | health p95 (ms) | health max (ms) | rows processed | rows failed | status |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 6.9 | 1458 | 152 | 157 | 178 | 10,000 | 0 | completed |
| 50,000 | 15.9 | 3142 | 153 | 175 | 203 | 50,000 | 0 | completed |
| 100,000 | 28.4 | 3518 | 151 | 164 | 182 | 100,000 | 0 | completed |

### Idle vs during-ingestion `GET /health` latency

| state | pings | median (ms) | p95 (ms) |
|---|---|---|---|
| idle (no upload running) | 100 | 153.2 | 156.7 |
| during 10,000-row import | 27 | 151.9 | 157.3 |
| during 50,000-row import | 61 | 152.5 | 174.7 |
| during 100,000-row import | 110 | 150.7 | 163.7 |

### Before (T8b) vs After (T8c)

| rows | T8b seconds | T8c seconds | speedup | T8b rows/s | T8c rows/s | chunk rows | queries per chunk | progress interval |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 29.4 | 6.9 | 4.29× | 340 | 1458 | 250 → 1000 | 4 → 1 + 1/5 ≈ 1.2 | every chunk → every 5 chunks |
| 50,000 | 129.6 | 15.9 | 8.14× | 386 | 3142 | 250 → 1000 | 4 → 1 + 1/5 ≈ 1.2 | every chunk → every 5 chunks |
| 100,000 | 274.0 | 28.4 | 9.64× | 365 | 3518 | 250 → 1000 | 4 → 1 + 1/5 ≈ 1.2 | every chunk → every 5 chunks |

Speedup vs T8b: 4.29× at 10,000, 8.14× at 50,000, 9.64× at 100,000. **The 2× target is met at every size.**

**Statements actually issued** (counted from the `INGEST_DEBUG=1` log in the T8c
session, chunk loop only): 16 for the 10,000-row run, 64 for 50,000, 124 for 100,000 —
i.e. 1.24–1.6 per chunk. The same files cost 160 / 800 / 1,600 statements at 4 per
250-row chunk before (40 / 200 / 400 chunks). The first chunk of a job pays 3
(products INSERT + products SELECT + sales INSERT); a steady-state chunk pays 1, plus
a second one every 5th chunk for `rows_processed`. Re-measure with
`set INGEST_DEBUG=1 && npm run bench:ingest` from `backend/`.

**Invariants asserted on the 10,000-row run:** rows_processed = file rows, rows_failed = 0, and BENCH-% product rows = distinct SKUs in the file. All passed.

### T8b baseline (kept for the record)

Measured in the T8b session with 250-row chunks and 4 statements per chunk.

| rows | seconds | rows/s |
|---|---|---|
| 10,000 | 29.4 | 340 |
| 50,000 | 129.6 | 386 |
| 100,000 | 274.0 | 365 |

## 3. Database round-trip

Median of 20 `SELECT 1` statements: **151.0 ms** (min 149.7 ms, max 170.8 ms).
Remote PostgreSQL latency dominates insert throughput: every chunk is one round-trip and
it costs ~151.0 ms however few rows it carries — which is exactly why T8c
grew chunks to 1000 rows and stopped rewriting the progress counter on every chunk.

## 4. Machine

- CPU: 12th Gen Intel(R) Core(TM) i5-12450H (12 logical cores)
- RAM: 7.7 GB
- OS: win32 10.0.26200
- Node: v24.15.0

## 5. Limitations

- **Single machine.** Client, server and (unless the DB is hosted) the database share one host;
  numbers are not a distributed-system result.
- **Remote database latency dominates.** Insert throughput is bounded by round-trip time,
  not by parsing — the parse table is the parsing evidence, the e2e table is the pipeline evidence.
- **Where the remaining time goes (measured in the T8c session with `INGEST_DEBUG=1`).**
  The 100,000-row run issued 124 chunk statements plus a handful of one-off ones
  (file-hash dedup lookup, job INSERT, final job UPDATE) at ~150 ms each — roughly two
  thirds of its wall clock. The remainder is per-row validation (`src/utils/validators.js`), CSV
  parsing (~0.3 s per §1), the multipart upload of the file itself, and the 500 ms polling
  granularity. The next real lever is one round-trip per file (`COPY ... FROM STDIN`) or a
  database nearer the API — not more JavaScript tuning.
- **Idle vs during ingestion.** `GET /health` median was 152 ms idle and 151 ms during the
  100,000-row import (p95 159 → 182 ms), so the event loop stays responsive: the extra
  latency is the remote database, not CPU starvation in the API process.
- **Synthetic data.** Uniform random rows; real files have skewed value distributions and encoding quirks.
- **One-time runs.** The e2e benchmark is single-shot per size (parse results are medians of 3);
  treat e2e figures as indicative, not statistically tight.
- **Naive-mode sampling.** The synchronous naive parse blocks the event loop, so its peak RSS is
  also sampled inline every 100k rows rather than only on the 50 ms timer.
- The naive parser is a strawman: the project never shipped it; it exists only as a baseline.
