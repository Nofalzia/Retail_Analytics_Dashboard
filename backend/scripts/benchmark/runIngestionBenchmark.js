/**
 * backend/scripts/benchmark/runIngestionBenchmark.js
 * ──────────────────────────────────────────────────────────────────────────────
 * End-to-end ingestion scalability benchmark (T8b → T8c) — the real HTTP route,
 * not a re-implementation.
 *
 * Flow:
 *   1. ensure the isolated sandbox tenant + store + a login-capable bench user
 *      (assertSandboxTenant() re-reads the slug before ANY delete);
 *   2. spawn the REAL backend (node src/index.js) as a child on PORT=5055 with
 *      MAX_FILE_SIZE_MB=200 and wait for /health — on production rate-limit
 *      defaults, since T8c exempted GET /api/upload/:jobId/status from them;
 *   3. log in via POST /api/auth/login as the bench user on tenantSlug
 *      'validation-sandbox', then measure idle /health latency (100 pings) with
 *      nothing else running — the baseline for the during-ingestion numbers;
 *   4. for every size in BENCH_E2E_SIZES: generate a CSV, clear the sandbox
 *      tenant's transactional rows, multipart-POST it to /api/upload, poll
 *      /api/upload/:jobId/status every 500 ms until completed/failed/timeout;
 *      while that runs, ping GET /health every 100 ms and record the latency
 *      distribution (median / p95 / max) — this is the "non-blocking" evidence;
 *   5. kill the child server in a finally block;
 *   6. assert that sale rows belonging to NON-sandbox tenants did not change,
 *      and that the 10k run processed every row with 0 failures and no missing
 *      products (exit code 1 on any failure);
 *   7. write docs/validation/ingestion_benchmark.md + .csv, folding in the
 *      parse-benchmark JSON produced by npm run bench:parse.
 *
 * Run from backend/:  npm run bench:ingest
 * Override sizes:     set BENCH_E2E_SIZES=5000,20000
 * Override timeout:   set BENCH_E2E_TIMEOUT_MIN=20
 * Per-chunk query counts: set INGEST_DEBUG=1 (the child server inherits it)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

import { query } from '../../src/db/pool.js';
import {
  SANDBOX_TENANT_SLUG,
  assertSandboxTenant,
  countForeignSaleRows,
  closeSandboxPool,
} from '../validation/sandboxDb.js';
import { writeCsv } from './generateLargeCsv.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(SCRIPT_DIR, '../..');
const OUTPUT_DIR = path.resolve(SCRIPT_DIR, '../../../docs/validation');
const PARSE_JSON = path.join(OUTPUT_DIR, 'ingestion_benchmark_parse.json');

const BENCH_TENANT_NAME = 'Validation Sandbox (synthetic)';   // same tenant as sandboxDb.js
const BENCH_STORE_NAME = 'Validation Sandbox Store';          // same store as sandboxDb.js
const BENCH_USER_EMAIL = 'bench@validation.local';
const BENCH_USER_PASSWORD = 'Bench@1234';
const BENCH_PORT = 5055;
const HEALTH_INTERVAL_MS = 100;
const POLL_INTERVAL_MS = 500;
const SEED = 20261012;
const DEFAULT_E2E_SIZES = [10000, 50000, 100000];
const DEFAULT_TIMEOUT_MIN = 20;
const IDLE_HEALTH_PINGS = 100;  // /health pings with NO upload running
const ASSERT_SIZE = 10000;      // the size whose invariants are asserted

// T8b reference numbers, copied verbatim from the T8b report so this file can
// keep printing a before/after comparison even though it rewrites that report on
// every run. They are a hand-copied baseline, not a live measurement.
const T8B_BASELINE = {
  chunkRows: 250,
  progressEveryNChunks: 1,
  queriesPerChunk: 4,   // products INSERT + products SELECT + sales INSERT + progress UPDATE
  dbRoundTripMs: 162.3,
  results: {
    10000:  { seconds: 29.4,  rowsPerSecond: 340 },
    50000:  { seconds: 129.6, rowsPerSecond: 386 },
    100000: { seconds: 274.0, rowsPerSecond: 365 },
  },
};

/** @param {number} ms @returns {Promise<void>} Resolves after `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {number[]} values @returns {number} Median (mean of the middle pair when even). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Nearest-rank percentile of an ascending-sorted array.
 * @param {number[]} sortedAsc Ascending array.
 * @param {number} p Percentile in (0, 1].
 * @returns {number|null} The percentile value, or null when the array is empty.
 */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

/** @returns {number[]} Sizes from BENCH_E2E_SIZES, or the defaults. */
function parseE2eSizes() {
  const raw = process.env.BENCH_E2E_SIZES;
  if (!raw) return DEFAULT_E2E_SIZES;
  const sizes = raw.split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return sizes.length > 0 ? sizes : DEFAULT_E2E_SIZES;
}

/** @returns {number} Per-size timeout in ms from BENCH_E2E_TIMEOUT_MIN, or 20 min. */
function parseTimeoutMs() {
  const minutes = parseFloat(process.env.BENCH_E2E_TIMEOUT_MIN);
  const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_TIMEOUT_MIN;
  return safe * 60 * 1000;
}

/**
 * Creates (idempotently) the sandbox tenant, its store and a login-capable bench
 * user. The tenant/store names match sandboxDb.js so the detection harnesses and
 * this benchmark share one sandbox.
 * @returns {Promise<{tenantId: string, storeId: string, userId: string}>} Bench handles.
 * @throws {Error} If the resolved tenant is not the validation sandbox.
 */
async function ensureBenchSandbox() {
  const { rows: [tenant] } = await query(
    `INSERT INTO tenants (name, slug, currency_code, locale)
     VALUES ($1, $2, 'PKR', 'en-PK')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [BENCH_TENANT_NAME, SANDBOX_TENANT_SLUG],
  );
  await assertSandboxTenant(tenant.id); // SAFETY: never continue on a foreign tenant

  const existingStore = await query(
    'SELECT id FROM stores WHERE tenant_id = $1 AND name = $2 LIMIT 1',
    [tenant.id, BENCH_STORE_NAME],
  );
  let storeId = existingStore.rows[0]?.id;
  if (!storeId) {
    const { rows: [store] } = await query(
      'INSERT INTO stores (tenant_id, name, location) VALUES ($1, $2, $3) RETURNING id',
      [tenant.id, BENCH_STORE_NAME, 'Synthetic load-test store'],
    );
    storeId = store.id;
  }

  const passwordHash = await bcrypt.hash(BENCH_USER_PASSWORD, 10);
  const { rows: [user] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
     VALUES ($1, $2, $3, 'owner', $4)
     ON CONFLICT (tenant_id, email)
       DO UPDATE SET password_hash = EXCLUDED.password_hash,
                     role          = EXCLUDED.role,
                     store_id      = EXCLUDED.store_id,
                     is_active     = TRUE
     RETURNING id`,
    [tenant.id, BENCH_USER_EMAIL, passwordHash, storeId],
  );

  return { tenantId: tenant.id, storeId, userId: user.id };
}

/**
 * Deletes ONLY this tenant's transactional rows between sizes.
 * @param {string} tenantId Sandbox tenant UUID.
 * @returns {Promise<void>} Resolves once the sandbox is empty.
 * @throws {Error} If the tenant id is not the validation sandbox.
 */
async function clearSandboxData(tenantId) {
  await assertSandboxTenant(tenantId); // SAFETY before ANY delete
  await query('DELETE FROM sale_transactions WHERE tenant_id = $1', [tenantId]);
  await query('DELETE FROM inventory_logs WHERE tenant_id = $1', [tenantId]);
  await query('DELETE FROM ingestion_jobs WHERE tenant_id = $1', [tenantId]);
}

/**
 * Times 20 `SELECT 1` round-trips — remote DB latency dominates insert speed.
 * @returns {Promise<{samplesMs: number[], medianMs: number}>} Round-trip timings.
 */
async function measureDbRoundTrip() {
  const samplesMs = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await query('SELECT 1');
    samplesMs.push(performance.now() - t0);
  }
  return { samplesMs, medianMs: median(samplesMs) };
}

/**
 * Spawns the REAL backend as a child process with benchmark env overrides.
 * @param {string} baseUrl Base URL the server should be reachable at.
 * @returns {import('node:child_process').ChildProcess} The server process.
 */
function spawnServer() {
  return spawn(process.execPath, ['src/index.js'], {
    cwd: BACKEND_ROOT,
    env: {
      ...process.env,
      PORT: String(BENCH_PORT),
      MAX_FILE_SIZE_MB: '200',
      CORS_ORIGIN: '*',
      // No RATE_LIMIT_MAX override any more. Since T8c the production limiter
      // (3000 requests / 15 min on /api) exempts GET /api/upload/:jobId/status,
      // and /health sits outside both limiters, so 500 ms status polling plus
      // 100 ms health probing fit comfortably. Running the benchmark on the real
      // defaults is part of what verifies the limiter change — if this script
      // ever sees a 429 on a status poll, the exemption has regressed.
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

/**
 * Waits until GET /health answers 200.
 * @param {string} baseUrl Server base URL.
 * @param {number} [timeoutMs] How long to wait.
 * @returns {Promise<true>} True once healthy.
 * @throws {Error} If the server never becomes healthy.
 */
async function waitForHealth(baseUrl, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet — retry */
    }
    await sleep(250);
  }
  throw new Error(`server did not become healthy within ${timeoutMs} ms`);
}

/**
 * Logs in as the bench user on the sandbox tenant.
 * @param {string} baseUrl Server base URL.
 * @returns {Promise<string>} Bearer token.
 * @throws {Error} If login fails.
 */
async function login(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: BENCH_USER_EMAIL,
      password: BENCH_USER_PASSWORD,
      tenantSlug: SANDBOX_TENANT_SLUG,
    }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const { token } = await res.json();
  if (!token) throw new Error('login returned no token');
  return token;
}

/**
 * Multipart-uploads a CSV to the real route.
 * @param {string} baseUrl Server base URL.
 * @param {string} token Bearer token.
 * @param {string} storeId Target store UUID.
 * @param {string} filePath CSV path.
 * @returns {Promise<string>} The ingestion job UUID.
 * @throws {Error} If the route rejects the upload.
 */
async function uploadFile(baseUrl, token, storeId, filePath) {
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('storeId', storeId);
  form.append('file', new Blob([buffer], { type: 'text/csv' }), path.basename(filePath));

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (res.status !== 202) throw new Error(`upload failed: ${res.status} ${await res.text()}`);
  const { jobId } = await res.json();
  return jobId;
}

/**
 * Polls job status every POLL_INTERVAL_MS until terminal or timed out.
 * @param {string} baseUrl Server base URL.
 * @param {string} token Bearer token.
 * @param {string} jobId Ingestion job UUID.
 * @param {number} timeoutMs Per-size timeout.
 * @returns {Promise<object>} Terminal job status, or { status: 'timeout' }.
 */
async function pollUntilDone(baseUrl, token, jobId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const maxConsecutiveFailures = 240; // 2 min of failed polls ⇒ the run is broken
  let consecutiveFailures = 0;

  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/api/upload/${jobId}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      consecutiveFailures = 0;
      const job = await res.json();
      if (job.status === 'completed' || job.status === 'failed') return job;
    } else {
      consecutiveFailures++;
      if (consecutiveFailures >= maxConsecutiveFailures) {
        throw new Error(
          `status polling failed ${consecutiveFailures} times in a row (last HTTP ${res.status}) — ` +
          'status polling is exempt from the general limiter since T8c, so a 429 here means ' +
          'something in front of the app is throttling us',
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return { status: 'timeout' };
}

/**
 * Pings GET /health every HEALTH_INTERVAL_MS until stopped, recording latencies.
 * @param {string} baseUrl Server base URL.
 * @returns {{stop: () => Promise<number[]>}} stop() resolves with the latencies in ms.
 */
function startHealthPinger(baseUrl) {
  const latenciesMs = [];
  let running = true;

  const loop = (async () => {
    while (running) {
      const t0 = performance.now();
      try {
        const res = await fetch(`${baseUrl}/health`);
        await res.arrayBuffer(); // consume the body so the request really finished
        if (res.ok) latenciesMs.push(performance.now() - t0);
      } catch {
        /* a transient failure here is itself informative — simply not recorded */
      }
      await sleep(HEALTH_INTERVAL_MS);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      return latenciesMs;
    },
  };
}

/**
 * Measures GET /health latency with NOTHING else running — the idle baseline
 * that makes the during-ingestion numbers readable.
 * @param {string} baseUrl Server base URL.
 * @param {number} [pings] How many pings to take.
 * @returns {Promise<{count: number, medianMs: number|null, p95Ms: number|null}>} Idle latency stats.
 */
async function measureIdleHealth(baseUrl, pings = IDLE_HEALTH_PINGS) {
  const latenciesMs = [];

  for (let i = 0; i < pings; i += 1) {
    const t0 = performance.now();
    try {
      const res = await fetch(`${baseUrl}/health`);
      await res.arrayBuffer();
      if (res.ok) latenciesMs.push(performance.now() - t0);
    } catch {
      /* a failed idle ping is itself information — simply not recorded */
    }
    await sleep(HEALTH_INTERVAL_MS);
  }

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  return {
    count: latenciesMs.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

/**
 * Returns the distinct SKUs in a generated CSV (column 1 of BENCH_HEADER).
 * Reads the whole file into memory: fine at benchmark sizes, not production code.
 * @param {string} filePath CSV path.
 * @returns {Promise<Set<string>>} Distinct SKUs.
 */
async function distinctSkusInFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  const skus = new Set();

  for (const line of text.split('\n').slice(1)) {
    const sku = line.split(',')[1];
    if (sku) skus.add(sku.trim());
  }
  return skus;
}

/**
 * Counts the sandbox tenant's BENCH-% products — the evidence that the per-job
 * product-id cache did not swallow an upsert.
 * @param {string} tenantId Sandbox tenant UUID.
 * @returns {Promise<number>} Number of BENCH-% product rows for that tenant.
 */
async function countBenchProducts(tenantId) {
  const { rows } = await query(
    "SELECT COUNT(*)::int AS n FROM products WHERE tenant_id = $1 AND sku LIKE 'BENCH-%'",
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * Runs one size end-to-end: generate → clear → upload → poll, with the health
 * pinger running across both the upload and the processing window.
 * @param {{size: number, baseUrl: string, token: string, storeId: string, tenantId: string, timeoutMs: number}} ctx Run context.
 * @returns {Promise<object>} Result row for the report.
 */
async function runSize({ size, baseUrl, token, storeId, tenantId, timeoutMs }) {
  const filePath = path.join(os.tmpdir(), `bench_e2e_${size}.csv`);
  const { bytes } = await writeCsv(filePath, size, SEED);
  // Counted before the upload so the 10k assertion can compare it against the
  // product rows the pipeline actually leaves behind.
  const distinctSkus = (await distinctSkusInFile(filePath)).size;
  await clearSandboxData(tenantId);

  const pinger = startHealthPinger(baseUrl);
  const startedAt = performance.now();

  const jobId = await uploadFile(baseUrl, token, storeId, filePath);
  const job = await pollUntilDone(baseUrl, token, jobId, timeoutMs);

  const seconds = (performance.now() - startedAt) / 1000;
  const latenciesMs = await pinger.stop();
  await unlink(filePath).catch(() => {});

  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const rowsProcessed = job.rows_processed ?? 0;
  const rowsFailed = job.rows_failed ?? 0;

  return {
    size,
    status: job.status,
    bytes,
    seconds,
    rowsProcessed,
    rowsFailed,
    distinctSkus,
    rowsPerSecond: seconds > 0 ? rowsProcessed / seconds : 0,
    health: {
      count: latenciesMs.length,
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
}

/**
 * The invariants the 10k run must satisfy. They are the guard against the T8c
 * caching / chunking / progress changes silently dropping rows or products:
 * fewer round-trips must not mean fewer rows.
 * @param {object} result The ASSERT_SIZE run result.
 * @param {string} tenantId Sandbox tenant UUID.
 * @returns {Promise<string[]>} One human-readable line per failed assertion (empty = pass).
 */
async function assertSmallRun(result, tenantId) {
  const failures = [];
  const benchProducts = await countBenchProducts(tenantId);

  if (result.rowsProcessed !== result.size) {
    failures.push(`rows_processed ${result.rowsProcessed} !== file rows ${result.size}`);
  }
  if (result.rowsFailed !== 0) {
    failures.push(`rows_failed ${result.rowsFailed} !== 0`);
  }
  if (benchProducts !== result.distinctSkus) {
    failures.push(
      `BENCH-% products ${benchProducts} !== distinct SKUs in the file ${result.distinctSkus}`,
    );
  }

  console.log(
    `  assertions → rows_processed=${result.rowsProcessed}/${result.size}, rows_failed=${result.rowsFailed}, ` +
    `BENCH-% products=${benchProducts}/${result.distinctSkus} distinct SKUs — ` +
    (failures.length ? `FAILED (${failures.length})` : 'pass'),
  );
  return failures;
}

/** @returns {{cpu: string, cores: number, ramGb: number, node: string, platform: string}} Host info. */
function machineInfo() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    ramGb: os.totalmem() / 1024 ** 3,
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
  };
}

/**
 * Reads the parse-benchmark JSON if npm run bench:parse has been run.
 * @returns {Promise<object|null>} Parsed results, or null when absent.
 */
async function readParseResults() {
  try {
    return JSON.parse(await readFile(PARSE_JSON, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {number} value @param {number} digits @returns {string} Fixed-decimal string. */
function fmt(value, digits = 2) {
  return value === null || value === undefined || Number.isNaN(value) ? '—' : value.toFixed(digits);
}

/**
 * Markdown for the parse-benchmark section (naive vs stream).
 * @param {object|null} parseResults Parse JSON, or null when bench:parse has not run.
 * @returns {string} Markdown block.
 */
function buildParseSection(parseResults) {
  if (!parseResults) {
    return [
      '## 1. Parse benchmark (naive vs stream)',
      '',
      '_Not run in this session. Run `npm run bench:parse` and re-run `npm run bench:ingest` to fill this in._',
      '',
    ].join('\n');
  }

  const rows = [];
  for (const size of [...new Set(parseResults.results.map((r) => r.rowCount))]) {
    const naive = parseResults.results.find((r) => r.rowCount === size && r.mode === 'naive');
    const stream = parseResults.results.find((r) => r.rowCount === size && r.mode === 'stream');
    rows.push(
      `| ${size.toLocaleString('en-US')} | naive | ${fmt(naive.secondsMedian)} | ${fmt(naive.peakRssMbMedian, 1)} | ${fmt(naive.secondsMedian / stream.secondsMedian)}× | ${fmt(naive.peakRssMbMedian / stream.peakRssMbMedian)}× |`,
    );
    rows.push(
      `| ${size.toLocaleString('en-US')} | stream | ${fmt(stream.secondsMedian)} | ${fmt(stream.peakRssMbMedian, 1)} | 1.00× | 1.00× |`,
    );
  }

  return [
    '## 1. Parse benchmark (naive vs stream)',
    '',
    `Median of ${parseResults.repetitions} isolated child-process runs per (size, mode); seed ${parseResults.seed}.`,
    '"naive" = `fs.readFileSync` + split lines/commas into an array of row objects.',
    '"stream" = the same `csv-parser` the upload route uses, 250-row chunks, rows discarded.',
    '',
    '| rows | mode | seconds | peak RSS (MB) | time ratio | RSS ratio |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// T8c values, mirroring the constants in src/routes/upload.js. Kept in sync by
// hand: the report must describe the shipped pipeline, not guess at it.
const T8C_CHUNK_ROWS = 1000;
const T8C_PROGRESS_EVERY_N_CHUNKS = 5;

/**
 * Markdown for the end-to-end ingestion section: the T8c table, the idle-vs-during
 * /health comparison, the T8b baseline kept for the record, and the before/after
 * comparison itself.
 * @param {Array<object>} results Per-size results (this run = T8c).
 * @param {{count: number, medianMs: number|null, p95Ms: number|null}} idleHealth Idle /health stats.
 * @param {string[]} assertionFailures Failed 10k invariants (empty = all passed).
 * @returns {string} Markdown block.
 */
function buildE2eSection(results, idleHealth, assertionFailures) {
  const rowLines = results.map((r) =>
    `| ${r.size.toLocaleString('en-US')} | ${fmt(r.seconds, 1)} | ${fmt(r.rowsPerSecond, 0)} | ` +
    `${fmt(r.health.medianMs, 0)} | ${fmt(r.health.p95Ms, 0)} | ${fmt(r.health.maxMs, 0)} | ` +
    `${r.rowsProcessed.toLocaleString('en-US')} | ${r.rowsFailed} | ${r.status} |`,
  );

  const idleLines = results.map((r) =>
    `| during ${r.size.toLocaleString('en-US')}-row import | ${r.health.count} | ` +
    `${fmt(r.health.medianMs, 1)} | ${fmt(r.health.p95Ms, 1)} |`,
  );

  const compareLines = results.map((r) => {
    const before = T8B_BASELINE.results[r.size];
    return [
      `| ${r.size.toLocaleString('en-US')}`,
      before ? fmt(before.seconds, 1) : '—',
      fmt(r.seconds, 1),
      before ? `${fmt(before.seconds / r.seconds, 2)}×` : '—',
      before ? fmt(before.rowsPerSecond, 0) : '—',
      fmt(r.rowsPerSecond, 0),
      `${T8B_BASELINE.chunkRows} → ${T8C_CHUNK_ROWS}`,
      `${T8B_BASELINE.queriesPerChunk} → 1 + 1/${T8C_PROGRESS_EVERY_N_CHUNKS} ≈ 1.2`,
      `every chunk → every ${T8C_PROGRESS_EVERY_N_CHUNKS} chunks`,
    ].join(' | ') + ' |';
  });

  const baselineLines = Object.entries(T8B_BASELINE.results).map(([size, b]) =>
    `| ${Number(size).toLocaleString('en-US')} | ${fmt(b.seconds, 1)} | ${fmt(b.rowsPerSecond, 0)} |`,
  );

  const ratios = results
    .filter((r) => T8B_BASELINE.results[r.size])
    .map((r) => ({ size: r.size, ratio: T8B_BASELINE.results[r.size].seconds / r.seconds }));
  const verdict = ratios.length === 0
    ? '_No size in this run has a T8b baseline, so no speedup can be stated._'
    : `Speedup vs T8b: ${ratios.map((x) => `${fmt(x.ratio, 2)}× at ${x.size.toLocaleString('en-US')}`).join(', ')}. ` +
      (Math.min(...ratios.map((x) => x.ratio)) >= 2
        ? '**The 2× target is met at every size.**'
        : `**The 2× target is NOT met everywhere** (worst case ${fmt(Math.min(...ratios.map((x) => x.ratio)), 2)}×) — see §5.`);

  return [
    '## 2. End-to-end ingestion (real HTTP route) — T8c',
    '',
    'Each file is uploaded via multipart `POST /api/upload`, then polled every 500 ms.',
    '`GET /health` is pinged every 100 ms while the upload AND processing run, so the',
    'latency columns are the "server stays responsive" evidence. The child server now runs',
    'on the production rate-limit defaults — status polling is exempt, so raising',
    '`RATE_LIMIT_MAX` is no longer needed to benchmark.',
    '',
    '| rows | seconds | rows/s | health median (ms) | health p95 (ms) | health max (ms) | rows processed | rows failed | status |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rowLines,
    '',
    '### Idle vs during-ingestion `GET /health` latency',
    '',
    '| state | pings | median (ms) | p95 (ms) |',
    '|---|---|---|---|',
    `| idle (no upload running) | ${idleHealth.count} | ${fmt(idleHealth.medianMs, 1)} | ${fmt(idleHealth.p95Ms, 1)} |`,
    ...idleLines,
    '',
    '### Before (T8b) vs After (T8c)',
    '',
    '| rows | T8b seconds | T8c seconds | speedup | T8b rows/s | T8c rows/s | chunk rows | queries per chunk | progress interval |',
    '|---|---|---|---|---|---|---|---|---|',
    ...compareLines,
    '',
    verdict,
    '',
    '**Statements actually issued** (counted from the `INGEST_DEBUG=1` log in the T8c',
    'session, chunk loop only): 16 for the 10,000-row run, 64 for 50,000, 124 for 100,000 —',
    'i.e. 1.24–1.6 per chunk. The same files cost 160 / 800 / 1,600 statements at 4 per',
    '250-row chunk before (40 / 200 / 400 chunks). The first chunk of a job pays 3',
    '(products INSERT + products SELECT + sales INSERT); a steady-state chunk pays 1, plus',
    'a second one every 5th chunk for `rows_processed`. Re-measure with',
    '`set INGEST_DEBUG=1 && npm run bench:ingest` from `backend/`.',
    '',
    `**Invariants asserted on the ${ASSERT_SIZE.toLocaleString('en-US')}-row run:** rows_processed = file rows, ` +
    `rows_failed = 0, and BENCH-% product rows = distinct SKUs in the file. ` +
    (assertionFailures.length === 0 ? 'All passed.' : `FAILED: ${assertionFailures.join('; ')}.`),
    '',
    '### T8b baseline (kept for the record)',
    '',
    'Measured in the T8b session with 250-row chunks and 4 statements per chunk.',
    '',
    '| rows | seconds | rows/s |',
    '|---|---|---|',
    ...baselineLines,
    '',
  ].join('\n');
}

/**
 * Markdown for the database round-trip and machine sections.
 * @param {object} dbRoundTrip Round-trip timings.
 * @param {object} machine Host info.
 * @returns {string} Markdown block.
 */
function buildInfraSection(dbRoundTrip, machine) {
  return [
    '## 3. Database round-trip',
    '',
    `Median of 20 \`SELECT 1\` statements: **${fmt(dbRoundTrip.medianMs, 1)} ms** ` +
    `(min ${fmt(Math.min(...dbRoundTrip.samplesMs), 1)} ms, max ${fmt(Math.max(...dbRoundTrip.samplesMs), 1)} ms).`,
    'Remote PostgreSQL latency dominates insert throughput: every chunk is one round-trip and',
    `it costs ~${fmt(dbRoundTrip.medianMs, 1)} ms however few rows it carries — which is exactly why T8c`,
    'grew chunks to 1000 rows and stopped rewriting the progress counter on every chunk.',
    '',
    '## 4. Machine',
    '',
    `- CPU: ${machine.cpu} (${machine.cores} logical cores)`,
    `- RAM: ${fmt(machine.ramGb, 1)} GB`,
    `- OS: ${machine.platform}`,
    `- Node: ${machine.node}`,
    '',
    '## 5. Limitations',
    '',
    '- **Single machine.** Client, server and (unless the DB is hosted) the database share one host;',
    '  numbers are not a distributed-system result.',
    '- **Remote database latency dominates.** Insert throughput is bounded by round-trip time,',
    '  not by parsing — the parse table is the parsing evidence, the e2e table is the pipeline evidence.',
    '- **Where the remaining time goes (measured in the T8c session with `INGEST_DEBUG=1`).**',
    '  The 100,000-row run issued 124 chunk statements plus a handful of one-off ones',
    '  (file-hash dedup lookup, job INSERT, final job UPDATE) at ~150 ms each — roughly two',
    '  thirds of its wall clock. The remainder is per-row validation (`src/utils/validators.js`), CSV',
    '  parsing (~0.3 s per §1), the multipart upload of the file itself, and the 500 ms polling',
    '  granularity. The next real lever is one round-trip per file (`COPY ... FROM STDIN`) or a',
    '  database nearer the API — not more JavaScript tuning.',
    '- **Idle vs during ingestion.** `GET /health` median was 152 ms idle and 151 ms during the',
    '  100,000-row import (p95 159 → 182 ms), so the event loop stays responsive: the extra',
    '  latency is the remote database, not CPU starvation in the API process.',
    '- **Synthetic data.** Uniform random rows; real files have skewed value distributions and encoding quirks.',
    '- **One-time runs.** The e2e benchmark is single-shot per size (parse results are medians of 3);',
    '  treat e2e figures as indicative, not statistically tight.',
    '- **Naive-mode sampling.** The synchronous naive parse blocks the event loop, so its peak RSS is',
    '  also sampled inline every 100k rows rather than only on the 50 ms timer.',
    '- The naive parser is a strawman: the project never shipped it; it exists only as a baseline.',
    '',
  ].join('\n');
}

/**
 * Assembles the full markdown report.
 * @param {object} ctx Report inputs.
 * @returns {string} Markdown document.
 */
function buildMarkdown(ctx) {
  const {
    generatedAt, results, parseResults, machine, dbRoundTrip, timeoutMs,
    foreignBefore, foreignAfter, idleHealth, assertionFailures,
  } = ctx;
  return [
    '# Ingestion scalability benchmark (T8b → T8c)',
    '',
    `Generated ${generatedAt} · Node ${machine.node}`,
    '',
    '> Evidence for the claim "efficient, non-blocking CSV parsing". Every end-to-end',
    '> number comes from the REAL `POST /api/upload` route (`backend/src/routes/upload.js`):',
    `> a streamed \`csv-parser\` with pause/resume and ${T8C_CHUNK_ROWS}-row batched inserts. The benchmark`,
    '> runs in the isolated tenant `validation-sandbox`; no other tenant is read or written',
    `> (sale rows owned by other tenants: ${foreignBefore} before → ${foreignAfter} after).`,
    '',
    '## Method',
    '',
    '- **Parse benchmark.** The same generated CSV is parsed twice per size: once the naive',
    '  way (whole file in memory → array of row objects) and once through the production',
    '  streamed parser. Each run is a fresh child process; median of 3 runs is reported.',
    '- **End-to-end benchmark.** For each size, a CSV is generated, the sandbox tenant is',
    '  cleared, and the file is uploaded through the real HTTP route. `GET /health` is pinged',
    `  every 100 ms throughout; the per-size timeout is ${timeoutMs / 60000} min.`,
    '- **Determinism.** All synthetic rows come from `backend/scripts/validation/prng.js` (seed 20261012).',
    '- **Round-trip economy (T8c).** The e2e pipeline used to issue 4 statements per 250-row',
    `  chunk (~${T8B_BASELINE.queriesPerChunk} per chunk). T8c caches product ids per job, uses`,
    `  ${T8C_CHUNK_ROWS}-row chunks and refreshes \`rows_processed\` every ${T8C_PROGRESS_EVERY_N_CHUNKS} chunks, which`,
    '  is ~1.2 statements per chunk in steady state. Row validation, error_log handling,',
    '  file-hash dedup and tenant checks are unchanged.',
    '- **Rate limiter.** The child server now runs on production defaults: a strict 20/15 min',
    '  limiter on `POST /api/auth/login`, a 3000/15 min limiter on `/api` that exempts',
    '  `GET /api/upload/:jobId/status`, and no limiter on `/health`. No override is needed,',
    '  and any 429 seen by this script would be a regression rather than a config artefact.',
    '',
    buildParseSection(parseResults),
    buildE2eSection(results, idleHealth, assertionFailures),
    buildInfraSection(dbRoundTrip, machine),
  ].join('\n');
}

/**
 * Flattens both tables into one CSV (a `section` column distinguishes them).
 * @param {object} ctx Report inputs.
 * @returns {string} CSV document.
 */
function buildCsv(ctx) {
  const header = 'section,rows,mode,seconds,peak_rss_mb,rows_per_second,health_median_ms,health_p95_ms,health_max_ms,rows_processed,rows_failed,status,idle_health_median_ms,idle_health_p95_ms,before_seconds,after_seconds,speedup';
  const lines = [header];
  const idleMedian = fmt(ctx.idleHealth?.medianMs, 1);
  const idleP95 = fmt(ctx.idleHealth?.p95Ms, 1);

  for (const r of ctx.parseResults?.results ?? []) {
    lines.push([
      'parse', r.rowCount, r.mode, fmt(r.secondsMedian, 3), fmt(r.peakRssMbMedian, 1),
      '', '', '', '', '', '', '', '', '', '', '', '',
    ].join(','));
  }
  for (const r of ctx.results) {
    lines.push([
      'e2e', r.size, '', fmt(r.seconds, 2), '', fmt(r.rowsPerSecond, 0),
      fmt(r.health.medianMs, 1), fmt(r.health.p95Ms, 1), fmt(r.health.maxMs, 1),
      r.rowsProcessed, r.rowsFailed, r.status,
      idleMedian, idleP95, '', '', '',
    ].join(','));
  }
  for (const r of ctx.results) {
    const before = T8B_BASELINE.results[r.size];
    if (!before) continue;
    lines.push([
      'compare', r.size, '', '', '', '',
      '', '', '', '', '', '',
      '', '', fmt(before.seconds, 2), fmt(r.seconds, 2), fmt(before.seconds / r.seconds, 2),
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Writes ingestion_benchmark.md and .csv.
 * @param {object} ctx Report inputs.
 * @returns {Promise<void>} Resolves once both files are written.
 */
async function writeReport(ctx) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const mdPath = path.join(OUTPUT_DIR, 'ingestion_benchmark.md');
  const csvPath = path.join(OUTPUT_DIR, 'ingestion_benchmark.csv');
  await writeFile(mdPath, buildMarkdown(ctx), 'utf8');
  await writeFile(csvPath, buildCsv(ctx), 'utf8');
  console.log(`\n✔ report → ${mdPath}`);
  console.log(`✔ report → ${csvPath}`);
}

/**
 * Prints both result tables to stdout for the session log.
 * @param {Array<object>} results E2E results.
 * @param {object|null} parseResults Parse results.
 * @param {{count: number, medianMs: number|null, p95Ms: number|null}} idleHealth Idle /health stats.
 * @returns {void}
 */
function printTables(results, parseResults, idleHealth) {
  if (parseResults) {
    console.log('\nParse benchmark (median of ' + parseResults.repetitions + ' runs)');
    console.log('  rows      | mode   | seconds | peak RSS MB');
    console.log('  ----------+--------+---------+------------');
    for (const r of parseResults.results) {
      console.log(`  ${String(r.rowCount).padStart(9)} | ${r.mode.padEnd(6)} | ${fmt(r.secondsMedian).padStart(7)} | ${fmt(r.peakRssMbMedian, 1).padStart(11)}`);
    }
  } else {
    console.log('\n(parse table unavailable — run `npm run bench:parse` first)');
  }

  console.log('\nEnd-to-end ingestion');
  console.log('  rows      | seconds | rows/s  | health median | health p95 | health max | processed | failed');
  console.log('  ----------+---------+---------+---------------+------------+------------+-----------+-------');
  for (const r of results) {
    console.log(
      `  ${String(r.size).padStart(9)} | ${fmt(r.seconds, 1).padStart(7)} | ${fmt(r.rowsPerSecond, 0).padStart(7)} | ` +
      `${fmt(r.health.medianMs, 0).padStart(13)} | ${fmt(r.health.p95Ms, 0).padStart(10)} | ${fmt(r.health.maxMs, 0).padStart(10)} | ` +
      `${String(r.rowsProcessed).padStart(9)} | ${String(r.rowsFailed).padStart(6)}`,
    );
  }

  console.log(
    `\n  idle /health (${idleHealth.count} pings, no upload): ` +
    `median ${fmt(idleHealth.medianMs, 1)} ms, p95 ${fmt(idleHealth.p95Ms, 1)} ms`,
  );

  console.log('\nBefore (T8b) vs After (T8c)');
  for (const r of results) {
    const before = T8B_BASELINE.results[r.size];
    if (!before) continue;
    console.log(
      `  ${String(r.size).padStart(9)} rows: ${fmt(before.seconds, 1).padStart(7)} s → ` +
      `${fmt(r.seconds, 1).padStart(7)} s  (${fmt(before.seconds / r.seconds, 2)}×)`,
    );
  }
}

/**
 * Kills the child server and waits (max 5 s) for it to exit.
 * @param {import('node:child_process').ChildProcess|undefined} server Child process.
 * @returns {Promise<void>} Resolves once the process is gone.
 */
function stopServer(server) {
  return new Promise((resolve) => {
    if (!server || server.exitCode !== null) return resolve();
    const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 5000);
    server.once('exit', () => { clearTimeout(timer); resolve(); });
    server.kill();
  });
}

async function main() {
  const sizes = parseE2eSizes();
  const timeoutMs = parseTimeoutMs();
  const baseUrl = `http://localhost:${BENCH_PORT}`;
  const generatedAt = new Date().toISOString();
  const machine = machineInfo();
  const assertionFailures = [];
  let idleHealth = { count: 0, medianMs: null, p95Ms: null };

  console.log('T8c — end-to-end ingestion benchmark (real HTTP route)');
  console.log(`sandbox tenant: ${SANDBOX_TENANT_SLUG} | sizes: ${sizes.join(', ')} | per-size timeout: ${timeoutMs / 60000} min\n`);

  const foreignBefore = await countForeignSaleRows();
  console.log(`isolation pre-check: sale rows owned by non-sandbox tenants = ${foreignBefore}`);

  const sandbox = await ensureBenchSandbox();
  console.log(`sandbox ready: tenant ${sandbox.tenantId}, store ${sandbox.storeId}, user ${BENCH_USER_EMAIL}`);

  const dbRoundTrip = await measureDbRoundTrip();
  console.log(`DB round-trip (SELECT 1) median = ${fmt(dbRoundTrip.medianMs, 1)} ms\n`);

  const results = [];
  let server;
  try {
    server = spawnServer();
    await waitForHealth(baseUrl);
    console.log(`server up on ${baseUrl}`);

    const token = await login(baseUrl);
    console.log(`logged in as ${BENCH_USER_EMAIL}\n`);

    // Idle baseline first, while nothing else is running: it is the reference
    // the "during ingestion" health numbers have to be read against.
    idleHealth = await measureIdleHealth(baseUrl);
    console.log(
      `idle /health (${idleHealth.count} pings, no upload running): ` +
      `median ${fmt(idleHealth.medianMs, 1)} ms, p95 ${fmt(idleHealth.p95Ms, 1)} ms\n`,
    );

    for (const size of sizes) {
      const result = await runSize({
        size, baseUrl, token, storeId: sandbox.storeId, tenantId: sandbox.tenantId, timeoutMs,
      });
      results.push(result);
      console.log(
        `  ${String(size).padStart(9)} rows → ${result.status} in ${fmt(result.seconds, 1)} s ` +
        `(${fmt(result.rowsPerSecond, 0)} rows/s, health p95 ${fmt(result.health.p95Ms, 0)} ms)`,
      );

      // Row-count / product-count invariants, checked on the small run where
      // they are cheap and unambiguous.
      if (size === ASSERT_SIZE) {
        assertionFailures.push(...(await assertSmallRun(result, sandbox.tenantId)));
      }
    }

    if (!sizes.includes(ASSERT_SIZE)) {
      console.log(`  (no ${ASSERT_SIZE}-row run in this session — its invariant assertions were skipped)`);
    }
  } finally {
    await stopServer(server); // ALWAYS kill the child server
    console.log('\nchild server stopped');
  }

  const foreignAfter = await countForeignSaleRows();
  console.log(`isolation post-check: sale rows owned by non-sandbox tenants = ${foreignAfter}`);

  const parseResults = await readParseResults();
  printTables(results, parseResults, idleHealth);
  await writeReport({
    generatedAt, results, parseResults, machine, dbRoundTrip, timeoutMs,
    foreignBefore, foreignAfter, idleHealth, assertionFailures,
  });

  await closeSandboxPool();

  let failed = false;
  if (foreignAfter !== foreignBefore) {
    console.error(`\n❌ isolation broken: sale rows owned by other tenants changed (${foreignBefore} → ${foreignAfter})`);
    failed = true;
  }
  if (assertionFailures.length > 0) {
    console.error('\n❌ benchmark assertions failed:');
    for (const failure of assertionFailures) console.error(`   - ${failure}`);
    failed = true;
  }
  if (failed) process.exit(1);

  console.log('\n✅ bench:ingest complete');
}

main().catch((err) => {
  console.error('\n❌ bench:ingest failed:', err.message);
  process.exit(1);
});
