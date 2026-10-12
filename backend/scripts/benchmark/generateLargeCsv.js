/**
 * backend/scripts/benchmark/generateLargeCsv.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Synthetic CSV generator for the ingestion-scalability benchmark (T8b).
 *
 * Emits a file with the six columns the real import template requires
 * (date, sku, product_name, quantity_sold, unit_price, unit_cost) so the output
 * can be fed to the REAL POST /api/upload pipeline unchanged.
 *
 * Row generation is:
 *   * deterministic — every value is drawn from ../validation/prng.js, so a
 *     given (rowCount, seed) pair always produces a byte-identical file;
 *   * backpressure-aware — rows go through a WriteStream and each write waits
 *     for 'drain' when the kernel buffer is full, so peak memory stays flat
 *     regardless of rowCount (the same principle the upload pipeline uses).
 *
 * This module never touches the database. The benchmark always writes into
 * os.tmpdir() and deletes the file afterwards, so nothing is ever committed.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createPrng } from '../validation/prng.js';

export const BENCH_HEADER = 'date,sku,product_name,quantity_sold,unit_price,unit_cost';
export const BENCH_SKU_COUNT = 300;      // "BENCH-0001" ... "BENCH-0300"
export const BENCH_WINDOW_DAYS = 365;    // sale dates spread over the last year

/** @returns {string} Zero-padded integer. */
function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** @param {Date} date @returns {string} Local ISO date (YYYY-MM-DD), no TZ shift. */
function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** @param {Date} date @param {number} days @returns {Date} date shifted by `days`. */
function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/**
 * Builds the 300 generic SKUs with a fixed price/cost spread.
 * @param {{uniform: (min: number, max: number) => number, randInt: (min: number, max: number) => number}} prng Seeded PRNG.
 * @returns {Array<{sku: string, name: string, price: number, cost: number}>} Catalog.
 */
function buildCatalog(prng) {
  const catalog = [];
  for (let i = 0; i < BENCH_SKU_COUNT; i++) {
    const price = prng.randInt(50, 500);                                  // whole units
    const cost = Math.max(1, Math.round(price * (0.45 + prng.uniform(0, 0.35))));
    catalog.push({
      sku: `BENCH-${pad(i + 1, 4)}`,
      name: `Bench Product ${pad(i + 1, 4)}`,
      price,
      cost,
    });
  }
  return catalog;
}

/**
 * Writes one synthetic CSV to disk.
 * @param {string} targetPath Absolute output path (the benchmark uses os.tmpdir()).
 * @param {number} rowCount Number of data rows (the header is not counted).
 * @param {number} seed Deterministic seed.
 * @returns {Promise<{path: string, rowCount: number, bytes: number}>} Write summary.
 */
export async function writeCsv(targetPath, rowCount, seed) {
  const prng = createPrng(seed);
  const catalog = buildCatalog(prng);
  const yesterday = addDays(new Date(), -1);

  const stream = createWriteStream(targetPath);
  let streamError = null;
  stream.on('error', (err) => { streamError = err; });

  // Writes one line, resolving only once the stream can accept more data.
  const writeLine = (line) => new Promise((resolve, reject) => {
    if (streamError) return reject(streamError);
    if (stream.write(line)) return resolve();   // still buffered — keep going
    const onDrain = () => { cleanup(); resolve(); };
    const onError = (err) => { cleanup(); reject(err); };
    const cleanup = () => {
      stream.removeListener('drain', onDrain);
      stream.removeListener('error', onError);
    };
    stream.once('drain', onDrain);              // buffer full — wait, then resume
    stream.once('error', onError);
  });

  await writeLine(`${BENCH_HEADER}\n`);

  for (let row = 0; row < rowCount; row++) {
    const product = catalog[prng.randInt(0, BENCH_SKU_COUNT - 1)];
    const dayOffset = prng.randInt(0, BENCH_WINDOW_DAYS - 1);   // 0 = yesterday
    const date = toIsoDate(addDays(yesterday, -dayOffset));
    const quantity = prng.randInt(1, 40);
    await writeLine(
      `${date},${product.sku},${product.name},${quantity},${product.price}.00,${product.cost}.00\n`,
    );
  }

  await new Promise((resolve, reject) => {
    stream.end(() => (streamError ? reject(streamError) : resolve()));
  });

  const { size } = await stat(targetPath);
  return { path: targetPath, rowCount, bytes: size };
}
