# Ingestion scalability benchmark (T8b)

Generated 2026-10-12T14:37:09.319Z · Node v24.15.0

> Evidence for the claim "efficient, non-blocking CSV parsing". Every end-to-end
> number comes from the REAL `POST /api/upload` route (`backend/src/routes/upload.js`):
> a streamed `csv-parser` with pause/resume and 250-row batched inserts. The benchmark
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
- **Rate limiter.** The child server is started with `RATE_LIMIT_MAX` raised, because the
  production limiter (200 requests / 15 min, `src/index.js`) is far below what 500 ms job
  polling plus 100 ms health probing requires. Unset, the limiter is unchanged at 200.

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

## 2. End-to-end ingestion (real HTTP route)

Each file is uploaded via multipart `POST /api/upload`, then polled every 500 ms.
`GET /health` is pinged every 100 ms while the upload AND processing run, so the
latency columns are the "server stays responsive" evidence.

| rows | seconds | rows/s | health median (ms) | health p95 (ms) | health max (ms) | rows processed | rows failed | status |
|---|---|---|---|---|---|---|---|---|
| 10,000 | 29.4 | 340 | 159 | 176 | 841 | 10,000 | 0 | completed |
| 50,000 | 129.6 | 386 | 157 | 165 | 419 | 50,000 | 0 | completed |
| 100,000 | 274.0 | 365 | 152 | 161 | 813 | 100,000 | 0 | completed |

## 3. Database round-trip

Median of 20 `SELECT 1` statements: **162.3 ms** (min 161.0 ms, max 164.4 ms).
Remote PostgreSQL latency dominates insert throughput: every 250-row batch is one round-trip.

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
- **Synthetic data.** Uniform random rows; real files have skewed value distributions and encoding quirks.
- **One-time runs.** The e2e benchmark is single-shot per size (parse results are medians of 3);
  treat e2e figures as indicative, not statistically tight.
- **Naive-mode sampling.** The synchronous naive parse blocks the event loop, so its peak RSS is
  also sampled inline every 100k rows rather than only on the 50 ms timer.
- The naive parser is a strawman: the project never shipped it; it exists only as a baseline.
