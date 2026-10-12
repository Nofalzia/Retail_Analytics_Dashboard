/**
 * backend/scripts/benchmark/runIngestionBenchmark.js
 * ──────────────────────────────────────────────────────────────────────────────
 * End-to-end ingestion scalability benchmark (T8b) — the real HTTP route, not a
 * re-implementation.
 *
 * Flow:
 *   1. ensure the isolated sandbox tenant + store + a login-capable bench user
 *      (assertSandboxTenant() re-reads the slug before ANY delete);
 *   2. spawn the REAL backend (node src/index.js) as a child on PORT=5055 with
 *      MAX_FILE_SIZE_MB=200 and wait for /health;
 *   3. log in via POST /api/auth/login as the bench user on tenantSlug
 *      'validation-sandbox';
 *   4. for every size in BENCH_E2E_SIZES: generate a CSV, clear the sandbox
 *      tenant's transactional rows, multipart-POST it to /api/upload, poll
 *      /api/upload/:jobId/status every 500 ms until completed/failed/timeout;
 *      while that runs, ping GET /health every 100 ms and record the latency
 *      distribution (median / p95 / max) — this is the "non-blocking" evidence;
 *   5. kill the child server in a finally block;
 *   6. assert that sale rows belonging to NON-sandbox tenants did not change
 *      (exit code 1 otherwise);
 *   7. write docs/validation/ingestion_benchmark.md + .csv, folding in the
 *      parse-benchmark JSON produced by npm run bench:parse.
 *
 * Run from backend/:  npm run bench:ingest
 * Override sizes:     set BENCH_E2E_SIZES=5000,20000
 * Override timeout:   set BENCH_E2E_TIMEOUT_MIN=20
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
      // The benchmark polls status every 500 ms and /health every 100 ms, which
      // is far beyond the production 200-requests/15-min limiter (see index.js).
      RATE_LIMIT_MAX: '1000000',
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
          'is the server rate-limiting us? (see RATE_LIMIT_MAX in src/index.js)',
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
 * Runs one size end-to-end: generate → clear → upload → poll, with the health
 * pinger running across both the upload and the processing window.
 * @param {{size: number, baseUrl: string, token: string, storeId: string, tenantId: string, timeoutMs: number}} ctx Run context.
 * @returns {Promise<object>} Result row for the report.
 */
async function runSize({ size, baseUrl, token, storeId, tenantId, timeoutMs }) {
  const filePath = path.join(os.tmpdir(), `bench_e2e_${size}.csv`);
  const { bytes } = await writeCsv(filePath, size, SEED);
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
    rowsPerSecond: seconds > 0 ? rowsProcessed / seconds : 0,
    health: {
      count: latenciesMs.length,
      medianMs: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
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

/**
 * Markdown for the end-to-end ingestion section.
 * @param {Array<object>} results Per-size results.
 * @returns {string} Markdown block.
 */
function buildE2eSection(results) {
  const rows = results.map((r) =>
    `| ${r.size.toLocaleString('en-US')} | ${fmt(r.seconds, 1)} | ${fmt(r.rowsPerSecond, 0)} | ` +
    `${fmt(r.health.medianMs, 0)} | ${fmt(r.health.p95Ms, 0)} | ${fmt(r.health.maxMs, 0)} | ` +
    `${r.rowsProcessed.toLocaleString('en-US')} | ${r.rowsFailed} | ${r.status} |`,
  );

  return [
    '## 2. End-to-end ingestion (real HTTP route)',
    '',
    'Each file is uploaded via multipart `POST /api/upload`, then polled every 500 ms.',
    '`GET /health` is pinged every 100 ms while the upload AND processing run, so the',
    'latency columns are the "server stays responsive" evidence.',
    '',
    '| rows | seconds | rows/s | health median (ms) | health p95 (ms) | health max (ms) | rows processed | rows failed | status |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows,
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
    'Remote PostgreSQL latency dominates insert throughput: every 250-row batch is one round-trip.',
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
  const { generatedAt, results, parseResults, machine, dbRoundTrip, timeoutMs, foreignBefore, foreignAfter } = ctx;
  return [
    '# Ingestion scalability benchmark (T8b)',
    '',
    `Generated ${generatedAt} · Node ${machine.node}`,
    '',
    '> Evidence for the claim "efficient, non-blocking CSV parsing". Every end-to-end',
    '> number comes from the REAL `POST /api/upload` route (`backend/src/routes/upload.js`):',
    '> a streamed `csv-parser` with pause/resume and 250-row batched inserts. The benchmark',
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
    '- **Rate limiter.** The child server is started with `RATE_LIMIT_MAX` raised, because the',
    '  production limiter (200 requests / 15 min, `src/index.js`) is far below what 500 ms job',
    '  polling plus 100 ms health probing requires. Unset, the limiter is unchanged at 200.',
    '',
    buildParseSection(parseResults),
    buildE2eSection(results),
    buildInfraSection(dbRoundTrip, machine),
  ].join('\n');
}

/**
 * Flattens both tables into one CSV (a `section` column distinguishes them).
 * @param {object} ctx Report inputs.
 * @returns {string} CSV document.
 */
function buildCsv(ctx) {
  const header = 'section,rows,mode,seconds,peak_rss_mb,rows_per_second,health_median_ms,health_p95_ms,health_max_ms,rows_processed,rows_failed,status';
  const lines = [header];

  for (const r of ctx.parseResults?.results ?? []) {
    lines.push([
      'parse', r.rowCount, r.mode, fmt(r.secondsMedian, 3), fmt(r.peakRssMbMedian, 1),
      '', '', '', '', '', '', '',
    ].join(','));
  }
  for (const r of ctx.results) {
    lines.push([
      'e2e', r.size, '', fmt(r.seconds, 2), '', fmt(r.rowsPerSecond, 0),
      fmt(r.health.medianMs, 1), fmt(r.health.p95Ms, 1), fmt(r.health.maxMs, 1),
      r.rowsProcessed, r.rowsFailed, r.status,
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
 * @returns {void}
 */
function printTables(results, parseResults) {
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

  console.log('T8b — end-to-end ingestion benchmark (real HTTP route)');
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

    for (const size of sizes) {
      const result = await runSize({
        size, baseUrl, token, storeId: sandbox.storeId, tenantId: sandbox.tenantId, timeoutMs,
      });
      results.push(result);
      console.log(
        `  ${String(size).padStart(9)} rows → ${result.status} in ${fmt(result.seconds, 1)} s ` +
        `(${fmt(result.rowsPerSecond, 0)} rows/s, health p95 ${fmt(result.health.p95Ms, 0)} ms)`,
      );
    }
  } finally {
    await stopServer(server); // ALWAYS kill the child server
    console.log('\nchild server stopped');
  }

  const foreignAfter = await countForeignSaleRows();
  console.log(`isolation post-check: sale rows owned by non-sandbox tenants = ${foreignAfter}`);

  const parseResults = await readParseResults();
  printTables(results, parseResults);
  await writeReport({
    generatedAt, results, parseResults, machine, dbRoundTrip, timeoutMs, foreignBefore, foreignAfter,
  });

  await closeSandboxPool();

  if (foreignAfter !== foreignBefore) {
    console.error(`\n❌ isolation broken: sale rows owned by other tenants changed (${foreignBefore} → ${foreignAfter})`);
    process.exit(1);
  }
  console.log('\n✅ bench:ingest complete');
}

main().catch((err) => {
  console.error('\n❌ bench:ingest failed:', err.message);
  process.exit(1);
});
