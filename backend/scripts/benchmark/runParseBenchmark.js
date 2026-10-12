/**
 * backend/scripts/benchmark/runParseBenchmark.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Parse-only scalability benchmark: naive in-memory parsing vs the streamed
 * csv-parser the real upload pipeline uses.
 *
 * For every size the CSV is generated once, then parseWorker.js is spawned as a
 * SEPARATE child process for each run (so every run starts from a clean heap).
 * Each (size, mode) pair is repeated REPETITIONS times and the median seconds /
 * median peak RSS are reported.
 *
 * No database is touched — this measures parsing and memory only. Results are
 * written to docs/validation/ingestion_benchmark_parse.json, which
 * runIngestionBenchmark.js folds into the combined report.
 *
 * Run from backend/:  npm run bench:parse
 * Override sizes:     set BENCH_PARSE_SIZES=10000,50000  (Windows CMD)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeCsv } from './generateLargeCsv.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(SCRIPT_DIR, 'parseWorker.js');
const OUTPUT_DIR = path.resolve(SCRIPT_DIR, '../../../docs/validation');
const PARSE_JSON = path.join(OUTPUT_DIR, 'ingestion_benchmark_parse.json');

const REPETITIONS = 3;
const SEED = 20261012;
const MODES = ['naive', 'stream'];
const DEFAULT_SIZES = [100000, 250000, 500000, 1000000];

/** @returns {number[]} Sizes from BENCH_PARSE_SIZES, or the defaults. */
function parseSizes() {
  const raw = process.env.BENCH_PARSE_SIZES;
  if (!raw) return DEFAULT_SIZES;
  const sizes = raw.split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return sizes.length > 0 ? sizes : DEFAULT_SIZES;
}

/** @param {number[]} values @returns {number} Median (mean of the middle pair when even). */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Runs parseWorker once as a separate child process and returns its JSON result.
 * @param {'naive'|'stream'} mode Parse mode.
 * @param {string} filePath CSV to parse.
 * @returns {Promise<{mode: string, rows: number, seconds: number, peakRssMb: number}>} Worker result.
 */
function runWorkerOnce(mode, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH, mode, filePath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    let out = '';
    child.stdout.on('data', (data) => { out += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`parseWorker (${mode}) exited with code ${code}`));
      const lastLine = out.trim().split(/\r?\n/).filter(Boolean).pop();
      try {
        resolve(JSON.parse(lastLine));
      } catch {
        reject(new Error(`parseWorker (${mode}) produced no JSON line: "${String(out).slice(0, 200)}"`));
      }
    });
  });
}

/**
 * Benchmark loop: one file per size, REPETITIONS child-process runs per mode.
 * @param {number[]} sizes Row counts to test.
 * @returns {Promise<Array<object>>} Per-(size, mode) medians.
 */
async function runBenchmark(sizes) {
  const results = [];

  for (const rowCount of sizes) {
    const filePath = path.join(os.tmpdir(), `bench_parse_${rowCount}.csv`);
    const { bytes } = await writeCsv(filePath, rowCount, SEED);
    console.log(`generated ${rowCount.toLocaleString()} rows (${(bytes / 1048576).toFixed(1)} MB) → ${filePath}`);

    for (const mode of MODES) {
      const seconds = [];
      const peaks = [];
      for (let rep = 0; rep < REPETITIONS; rep++) {
        const result = await runWorkerOnce(mode, filePath);
        if (result.rows !== rowCount) {
          throw new Error(`parseWorker (${mode}) parsed ${result.rows} rows, expected ${rowCount}`);
        }
        seconds.push(result.seconds);
        peaks.push(result.peakRssMb);
      }
      results.push({
        rowCount,
        mode,
        bytes,
        repetitions: REPETITIONS,
        secondsMedian: median(seconds),
        peakRssMbMedian: median(peaks),
        secondsSamples: seconds,
        peakRssMbSamples: peaks,
      });
      console.log(`  ${mode.padEnd(6)} | ${median(seconds).toFixed(2)} s | peak ${median(peaks).toFixed(1)} MB`);
    }

    await unlink(filePath).catch(() => {});
  }

  return results;
}

/**
 * Prints the parse table with naive/stream ratios.
 * @param {Array<object>} results Per-(size, mode) medians.
 * @returns {void}
 */
function printTable(results) {
  console.log(`\nParse benchmark (median of ${REPETITIONS} runs, isolated child process each)`);
  console.log('  rows      | mode   | seconds | ratio vs stream | peak RSS MB | ratio vs stream');
  console.log('  ----------+--------+---------+-----------------+-------------+----------------');
  for (const size of [...new Set(results.map((r) => r.rowCount))]) {
    const naive = results.find((r) => r.rowCount === size && r.mode === 'naive');
    const stream = results.find((r) => r.rowCount === size && r.mode === 'stream');
    for (const entry of [naive, stream]) {
      const secRatio = entry === naive ? naive.secondsMedian / stream.secondsMedian : 1;
      const rssRatio = entry === naive ? naive.peakRssMbMedian / stream.peakRssMbMedian : 1;
      console.log(
        `  ${String(entry.rowCount).padStart(9)} | ${entry.mode.padEnd(6)} | ` +
        `${entry.secondsMedian.toFixed(2).padStart(7)} | ${secRatio.toFixed(2).padStart(15)} | ` +
        `${entry.peakRssMbMedian.toFixed(1).padStart(11)} | ${rssRatio.toFixed(2).padStart(14)}`,
      );
    }
  }
}

async function main() {
  const sizes = parseSizes();
  console.log('T8b — CSV parse benchmark (naive vs stream)');
  console.log(`sizes: ${sizes.join(', ')} | repetitions: ${REPETITIONS} (median) | node ${process.version}\n`);

  const results = await runBenchmark(sizes);
  printTable(results);

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    PARSE_JSON,
    JSON.stringify({ generatedAt: new Date().toISOString(), seed: SEED, sizes, repetitions: REPETITIONS, results }, null, 2),
    'utf8',
  );
  console.log(`\n✔ parse results → ${PARSE_JSON}`);
  console.log('  run `npm run bench:ingest` to write the combined report (markdown + csv).');
}

main().catch((err) => {
  console.error('\n❌ bench:parse failed:', err.message);
  process.exit(1);
});
