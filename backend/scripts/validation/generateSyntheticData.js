/**
 * backend/scripts/validation/generateSyntheticData.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Synthetic sales-series generator with KNOWN injected anomalies (T7a).
 *
 * Data model (per product, per day):
 *   expected = dailyMean × (weekend ? WEEKEND_MULTIPLIER : 1)
 *   units    = round( expected + N(0, 1.2·√dailyMean) )   clamped to >= 0
 * where dailyMean is drawn uniformly from [6, 40] units/day per product.
 *
 * Ground truth: 36 injected anomalies, placed only on dayIndex 21..90, at least
 * 12 days apart within any one product and never twice on the same
 * product-day. 18 spikes (multipliers 1.5 / 2.0 / 3.0, six each) and
 * 18 drops (multipliers 0.6 / 0.4 / 0.2, six each). The multiplier is applied
 * to the day's already-noised units.
 *
 * Note on zero units: baseline days whose draw rounds to 0 stay 0 and are never
 * written to the database (sale_transactions.quantity_sold has CHECK (> 0)), so
 * they are missing from the product_daily_velocity view. Injected anomaly days
 * are floored at 1 unit so that every ground-truth row is physically present in
 * the series and therefore measurable.
 *
 * Everything is derived from a single seeded mulberry32 stream: same seed ⇒
 * identical dataset, on any machine.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { createPrng } from './prng.js';

export const PRODUCT_COUNT = 20;
export const DAY_COUNT = 90;
export const WEEKEND_MULTIPLIER = 1.2;
export const NOISE_SD_FACTOR = 1.2;
export const MEAN_MIN_UNITS = 6;
export const MEAN_MAX_UNITS = 40;
export const ANOMALY_FIRST_DAY_INDEX = 21;
export const MIN_DAYS_BETWEEN_ANOMALIES = 12;
export const ANOMALIES_PER_MULTIPLIER = 6;
export const SPIKE_MULTIPLIERS = [1.5, 2.0, 3.0];
export const DROP_MULTIPLIERS = [0.6, 0.4, 0.2];
export const GROUND_TRUTH_TOTAL =
  2 * SPIKE_MULTIPLIERS.length * ANOMALIES_PER_MULTIPLIER; // 36

const MAX_PLACEMENT_ATTEMPTS = 20000;

/** @returns {string} Zero-padded number. */
function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** @param {Date} date @returns {string} Local ISO date (YYYY-MM-DD), no TZ shift. */
function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** @param {Date} date @param {number} days @returns {Date} New date shifted by `days`. */
function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** @returns {number|string} Pair key for slot bookkeeping. */
function slotKey(productIndex, dayIndex) {
  return `${productIndex}:${dayIndex}`;
}

/**
 * Builds the calendar: `dayCount` days ending yesterday.
 * @param {{dayCount?: number, endDate?: Date}} [options] Window options.
 * @returns {Array<{dayIndex: number, date: string, isWeekend: boolean}>}
 *   dayIndex is 1-based (1 = oldest, dayCount = yesterday).
 */
export function buildDays(options = {}) {
  const { dayCount = DAY_COUNT, endDate = new Date() } = options;
  const yesterday = addDays(endDate, -1);
  const start = addDays(yesterday, -(dayCount - 1));
  const days = [];

  for (let i = 0; i < dayCount; i++) {
    const date = addDays(start, i);
    const dow = date.getDay(); // 0 = Sunday, 6 = Saturday
    days.push({ dayIndex: i + 1, date: toIsoDate(date), isWeekend: dow === 0 || dow === 6 });
  }
  return days;
}

/**
 * Picks a free (product, day) slot for an injected anomaly.
 * Random first, deterministic scan as a fallback — both PRNG-driven, so the
 * whole placement is reproducible.
 * @param {object} ctx Placement context.
 * @returns {{productIndex: number, dayIndex: number}} The chosen slot.
 * @throws {Error} If no legal slot remains.
 */
function pickSlot(ctx) {
  const { prng, productCount, dayCount, usedByProduct, usedPairs } = ctx;
  const isFree = (productIndex, dayIndex) => {
    if (usedPairs.has(slotKey(productIndex, dayIndex))) return false;
    const used = usedByProduct.get(productIndex) ?? [];
    return !used.some((d) => Math.abs(d - dayIndex) < MIN_DAYS_BETWEEN_ANOMALIES);
  };

  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
    const productIndex = prng.randInt(0, productCount - 1);
    const dayIndex = prng.randInt(ANOMALY_FIRST_DAY_INDEX, dayCount);
    if (isFree(productIndex, dayIndex)) return { productIndex, dayIndex };
  }

  for (let productIndex = 0; productIndex < productCount; productIndex++) {
    for (let dayIndex = ANOMALY_FIRST_DAY_INDEX; dayIndex <= dayCount; dayIndex++) {
      if (isFree(productIndex, dayIndex)) return { productIndex, dayIndex };
    }
  }

  throw new Error('generateDataset: no free slot left for an injected anomaly');
}

/**
 * Builds the anomaly injection plan (18 spikes + 18 drops) in a fixed order.
 * @returns {Array<{type: 'spike'|'drop', multiplier: number}>} 36 specs.
 */
function buildAnomalySpecs() {
  const specs = [];
  for (const multiplier of SPIKE_MULTIPLIERS) {
    for (let i = 0; i < ANOMALIES_PER_MULTIPLIER; i++) specs.push({ type: 'spike', multiplier });
  }
  for (const multiplier of DROP_MULTIPLIERS) {
    for (let i = 0; i < ANOMALIES_PER_MULTIPLIER; i++) specs.push({ type: 'drop', multiplier });
  }
  return specs;
}

/**
 * Generates the full synthetic dataset for one seed.
 * @param {number} seed Any integer seed (the harness uses 1..5).
 * @param {{productCount?: number, dayCount?: number, endDate?: Date}} [options] Sizing options.
 * @returns {{seed: number, products: Array, days: Array, series: Array, groundTruth: Array,
 *            productCount: number, dayCount: number}} Dataset snapshot.
 *   products[i] = {sku, name, dailyMean, noiseSd}
 *   series[i]   = {sku, name, dailyMean, points:[{dayIndex, date, units, isWeekend, isAnomaly, anomalyType, multiplier}]}
 *   groundTruth = [{productSku, dayIndex, date, type, multiplier}]
 */
export function generateDataset(seed, options = {}) {
  const { productCount = PRODUCT_COUNT, dayCount = DAY_COUNT, endDate = new Date() } = options;
  const prng = createPrng(seed * 7919 + 13);
  const days = buildDays({ dayCount, endDate });

  const products = [];
  const series = [];
  const usedByProduct = new Map();
  const usedPairs = new Set();

  // ── Pass 1: products and their baseline daily series ───────────────────────
  for (let p = 0; p < productCount; p++) {
    const dailyMean = prng.uniform(MEAN_MIN_UNITS, MEAN_MAX_UNITS);
    const noiseSd = NOISE_SD_FACTOR * Math.sqrt(dailyMean);
    const sku = `VAL-${pad(p + 1, 3)}`;
    const name = `Test Product ${pad(p + 1, 2)}`;

    products.push({ sku, name, dailyMean, noiseSd });
    usedByProduct.set(p, []);

    const points = days.map((day) => {
      const expected = dailyMean * (day.isWeekend ? WEEKEND_MULTIPLIER : 1);
      const units = Math.max(0, Math.round(expected + prng.normal() * noiseSd));
      return {
        dayIndex: day.dayIndex,
        date: day.date,
        units,
        isWeekend: day.isWeekend,
        isAnomaly: false,
        anomalyType: null,
        multiplier: null,
      };
    });

    series.push({ sku, name, dailyMean, points });
  }

  // ── Pass 2: anomaly injection ──────────────────────────────────────────────
  const groundTruth = [];
  for (const spec of buildAnomalySpecs()) {
    const { productIndex, dayIndex } = pickSlot({
      prng,
      productCount,
      dayCount,
      usedByProduct,
      usedPairs,
    });

    const point = series[productIndex].points[dayIndex - 1];
    point.units = Math.max(1, Math.round(point.units * spec.multiplier));
    point.isAnomaly = true;
    point.anomalyType = spec.type;
    point.multiplier = spec.multiplier;

    usedByProduct.get(productIndex).push(dayIndex);
    usedPairs.add(slotKey(productIndex, dayIndex));

    groundTruth.push({
      productSku: products[productIndex].sku,
      dayIndex,
      date: point.date,
      type: spec.type,
      multiplier: spec.multiplier,
    });
  }

  groundTruth.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.dayIndex - b.dayIndex));

  return { seed, products, days, series, groundTruth, productCount, dayCount };
}

/**
 * Counts product-days with zero units. Those days produce no sale_transactions
 * row (CHECK quantity_sold > 0) and are therefore absent from
 * product_daily_velocity — the harness reports them, it does not fix them.
 * @param {{series: Array}} dataset Dataset from generateDataset.
 * @returns {number} Number of zero-unit product-days.
 */
export function countZeroSaleProductDays(dataset) {
  let zeros = 0;
  for (const product of dataset.series) {
    for (const point of product.points) {
      if (point.units === 0) zeros++;
    }
  }
  return zeros;
}
