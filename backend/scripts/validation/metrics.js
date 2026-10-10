/**
 * backend/scripts/validation/metrics.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Pure evaluation metrics for the detection-validation harness (T7a).
 *
 * Matching rule (identical for the engine and both baselines): a flagged
 * product-day and a ground-truth anomaly match when and only when they share
 * the exact same (sku, date) pair. No tolerance window, no date fuzziness, no
 * per-product aggregation.
 *
 * Every function here is pure — no I/O, no randomness, no database access.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Canonical key for a (sku, date) pair.
 * @param {string} sku Product SKU.
 * @param {string|Date} date ISO date (YYYY-MM-DD) or Date instance.
 * @returns {string} `sku|YYYY-MM-DD` key.
 */
export function pairKey(sku, date) {
  const iso = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  return `${sku}|${iso}`;
}

/**
 * Normalises a list of flagged things or ground-truth entries into a key set.
 * @param {Array<{sku: string, date?: string, saleDate?: string, alert_date?: string}>|Set<string>} items
 *   Items carrying sku + a date field, or already-built key strings.
 * @returns {Set<string>} Set of canonical pair keys.
 */
export function toPairSet(items) {
  const set = new Set();
  if (!items) return set;
  for (const item of items) {
    if (typeof item === 'string') {
      set.add(item);
      continue;
    }
    const date = item.date ?? item.saleDate ?? item.alert_date;
    set.add(pairKey(item.sku, date));
  }
  return set;
}

/**
 * Confusion counts for one method against the ground truth.
 * @param {Array|Set} flagged Product-days the method flagged.
 * @param {Array|Set} groundTruth Injected anomalies ({productSku|sku, date}).
 * @returns {{tp: number, fp: number, fn: number, flaggedTotal: number, groundTruthTotal: number}}
 *   tp = flagged & truth, fp = flagged & not truth, fn = truth & not flagged.
 */
export function confusionCounts(flagged, groundTruth) {
  const flaggedKeys = toPairSet(flagged);
  const truthKeys = toPairSet(normaliseTruth(groundTruth));

  let tp = 0;
  let fp = 0;
  for (const key of flaggedKeys) {
    if (truthKeys.has(key)) tp++;
    else fp++;
  }

  let fn = 0;
  for (const key of truthKeys) {
    if (!flaggedKeys.has(key)) fn++;
  }

  return { tp, fp, fn, flaggedTotal: flaggedKeys.size, groundTruthTotal: truthKeys.size };
}

/**
 * Directive: returns 0 instead of NaN/Infinity when the denominator is 0.
 * @param {number} numerator Numerator.
 * @param {number} denominator Denominator.
 * @returns {number} numerator / denominator, or 0 if the denominator is 0.
 */
export function safeDivide(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Precision / recall / F1 from confusion counts.
 * Precision and recall are 0 when their denominator is 0 (documented
 * convention: "no flags ⇒ no precision", not NaN).
 * @param {{tp: number, fp: number, fn: number}} counts Confusion counts.
 * @returns {{precision: number, recall: number, f1: number}} Metrics in [0, 1].
 */
export function classificationMetrics(counts) {
  const precision = safeDivide(counts.tp, counts.tp + counts.fp);
  const recall = safeDivide(counts.tp, counts.tp + counts.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/**
 * Recall broken down by one dimension of the ground truth (anomaly type or
 * injected multiplier).
 * @param {Array|Set} flagged Product-days the engine flagged.
 * @param {Array} groundTruth Ground-truth entries ({productSku, date, type, multiplier}).
 * @param {'type'|'multiplier'} dimension Ground-truth field to group by.
 * @returns {Array<{value: string|number, total: number, detected: number, recall: number}>}
 *   One bucket per distinct dimension value, ordered by first appearance.
 */
export function recallByDimension(flagged, groundTruth, dimension) {
  const flaggedKeys = toPairSet(flagged);
  const truth = normaliseTruth(groundTruth);
  const buckets = new Map();

  for (const gt of truth) {
    const value = gt[dimension];
    const key = String(value);
    if (!buckets.has(key)) buckets.set(key, { value, total: 0, detected: 0 });
    const bucket = buckets.get(key);
    bucket.total++;
    if (flaggedKeys.has(pairKey(gt.sku, gt.date))) bucket.detected++;
  }

  return [...buckets.values()].map((bucket) => ({
    ...bucket,
    recall: safeDivide(bucket.detected, bucket.total),
  }));
}

/**
 * Ground-truth entries use `productSku`; metrics functions accept either that
 * or a plain `sku` field.
 * @param {Array} groundTruth Ground-truth entries.
 * @returns {Array} Entries normalised to carry `sku`.
 */
function normaliseTruth(groundTruth) {
  if (!groundTruth) return [];
  return [...groundTruth].map((gt) =>
    typeof gt === 'string' ? gt : { ...gt, sku: gt.sku ?? gt.productSku },
  );
}
