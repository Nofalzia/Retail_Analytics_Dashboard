/**
 * backend/scripts/benchmark/parseWorker.js
 * ──────────────────────────────────────────────────────────────────────────────
 * One CSV-parse measurement, run as an isolated child process so each run starts
 * from a clean heap (the memory difference between the two modes is the point).
 *
 * Usage:  node parseWorker.js <naive|stream> <csvPath>
 *
 *   naive  — fs.readFileSync the whole file, split into lines, split every line
 *            on commas and build an array of row objects. This is what a careless
 *            implementation does: it is blocking and memory grows with the file.
 *   stream — the SAME csv-parser the real pipeline uses (src/routes/upload.js),
 *            buffering rows in CHUNK_SIZE-row chunks and discarding each chunk.
 *            No database here — we only count rows.
 *
 * Both modes only parse and count. RSS is sampled every 50 ms (and inline during
 * the blocking naive loop, which would otherwise starve the timer).
 *
 * Output: exactly ONE JSON line on stdout — {"mode","rows","seconds","peakRssMb"}.
 * Everything else goes to stderr, so the parent can parse stdout safely.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, createReadStream } from 'node:fs';
import csvParser from 'csv-parser';

// Deliberately 250 here — NOT the ingest route's batch size. This worker measures
// PARSING only, and every published parse number was produced at 250 rows/chunk.
// upload.js now flushes 1000-row batches (CHUNK_ROWS); the two constants are
// independent on purpose, so do not "sync" them.
const CHUNK_SIZE = 250;
const SAMPLE_INTERVAL_MS = 50;   // RSS sampling cadence
const NAIVE_SAMPLE_EVERY = 100_000; // inline samples for the blocking naive loop

/** @returns {number} Current resident set size in MB. */
function rssMb() {
  return process.memoryUsage().rss / (1024 * 1024);
}

/**
 * Starts a timer that tracks peak RSS.
 * @returns {{sample: () => number, stop: () => number}} Sampler; stop() returns peak MB.
 */
function startRssSampler() {
  let peak = rssMb();
  const sample = () => {
    const now = rssMb();
    if (now > peak) peak = now;
    return now;
  };
  const timer = setInterval(sample, SAMPLE_INTERVAL_MS);
  return {
    sample,
    stop() {
      clearInterval(timer);
      return sample();
    },
  };
}

/**
 * Naive parse: whole file in memory → array of row objects (deliberately wasteful).
 * @param {string} filePath CSV path.
 * @param {() => void} sample Inline RSS sampler (the event loop is blocked here).
 * @returns {number} Number of data rows parsed.
 */
function parseNaive(filePath, sample) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const headers = lines[0].split(',');
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === '') continue;                       // trailing newline
    const cells = line.split(',');
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = cells[c];
    rows.push(obj);
    if (rows.length % NAIVE_SAMPLE_EVERY === 0) sample();
  }
  return rows.length;
}

/**
 * Stream parse: the real pipeline's csv-parser, CHUNK_SIZE-row chunks, rows discarded.
 * @param {string} filePath CSV path.
 * @returns {Promise<number>} Number of data rows parsed.
 */
function parseStream(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath).pipe(csvParser());
    let chunk = [];
    let rows = 0;

    stream.on('data', (row) => {
      chunk.push(row);
      if (chunk.length >= CHUNK_SIZE) {
        rows += chunk.length;   // "flush" the chunk — here it is simply discarded
        chunk = [];
      }
    });
    stream.on('end', () => {
      rows += chunk.length;     // final partial chunk
      resolve(rows);
    });
    stream.on('error', reject);
  });
}

async function main() {
  const mode = process.argv[2];
  const filePath = process.argv[3];

  if (mode !== 'naive' && mode !== 'stream') {
    console.error(`parseWorker: unknown mode "${mode}" (expected naive|stream)`);
    process.exit(2);
  }
  if (!filePath) {
    console.error('parseWorker: missing csv path');
    process.exit(2);
  }

  const sampler = startRssSampler();
  const startedAt = process.hrtime.bigint();

  const rows = mode === 'naive' ? parseNaive(filePath, sampler.sample) : await parseStream(filePath);

  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  const peakRssMb = sampler.stop();

  process.stdout.write(`${JSON.stringify({
    mode,
    rows,
    seconds: Number(seconds.toFixed(3)),
    peakRssMb: Number(peakRssMb.toFixed(1)),
  })}\n`);
}

main().catch((err) => {
  console.error('parseWorker failed:', err.message);
  process.exit(1);
});
