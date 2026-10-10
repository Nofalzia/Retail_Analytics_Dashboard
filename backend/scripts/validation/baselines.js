/**
 * backend/scripts/validation/baselines.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Naive fixed-percentage baseline for the detection-validation harness (T7a).
 *
 * DOCUMENTED RULE ("what a shopkeeper would do without statistics"):
 *   For every product-day that has at least BASELINE_WINDOW_DAYS (14) days of
 *   history before it, compute the mean of the PREVIOUS 14 days' units (the 14
 *   days strictly before the day under test) and flag the day as an anomaly when
 *
 *       |units − mean| / mean  >  T          with T ∈ {0.30, 0.50}
 *
 *   * The first 14 days of each series are skipped (no baseline exists).
 *   * Days whose previous-14-day mean is 0 are skipped (no division), which is
 *     functionally the same as never flagging them.
 *   * Unlike the engine, the baseline is a *rolling* backward-looking test, so
 *     it is evaluated over the whole 90-day series.
 *
 * Pure module: no I/O, no randomness, no database access.
 * ──────────────────────────────────────────────────────────────────────────────
 */

export const BASELINE_WINDOW_DAYS = 14;
export const BASELINE_THRESHOLDS = [0.30, 0.50];

/**
 * Applies the fixed-percentage rule to a single product's daily points.
 * @param {Array<{dayIndex: number, date: string, units: number}>} points Daily points in ascending date order.
 * @param {number} threshold Deviation ratio T (e.g. 0.30).
 * @param {number} [windowDays] Length of the backward-looking baseline window.
 * @returns {Array<{dayIndex: number, date: string, units: number, windowMean: number, deviation: number}>}
 *   One entry per flagged day.
 */
export function flagFixedPercentage(points, threshold, windowDays = BASELINE_WINDOW_DAYS) {
  const flagged = [];

  for (let i = 0; i < points.length; i++) {
    if (i < windowDays) continue; // skip the first `windowDays` days

    let sum = 0;
    for (let j = i - windowDays; j < i; j++) sum += points[j].units;
    const windowMean = sum / windowDays;
    if (windowMean <= 0) continue;

    const deviation = Math.abs(points[i].units - windowMean) / windowMean;
    if (deviation > threshold) {
      flagged.push({
        dayIndex: points[i].dayIndex,
        date: points[i].date,
        units: points[i].units,
        windowMean,
        deviation,
      });
    }
  }

  return flagged;
}

/**
 * Runs every configured fixed-percentage baseline over a full dataset series.
 * @param {Array<{sku: string, points: Array}>} series Dataset series (one entry per product).
 * @param {number[]} [thresholds] Deviation thresholds to evaluate.
 * @returns {Object<string, Array<{sku: string, dayIndex: number, date: string, units: number,
 *   windowMean: number, deviation: number}>>} Keyed by `baseline_<T>` (e.g. `baseline_0.30`).
 */
export function evaluateBaselines(series, thresholds = BASELINE_THRESHOLDS) {
  const results = {};

  for (const threshold of thresholds) {
    const flagged = [];
    for (const product of series) {
      for (const hit of flagFixedPercentage(product.points, threshold)) {
        flagged.push({ sku: product.sku, ...hit });
      }
    }
    results[`baseline_${threshold.toFixed(2)}`] = flagged;
  }

  return results;
}

/**
 * Human-readable labels for the baseline methods, used by the report.
 * @param {number} threshold Deviation threshold.
 * @returns {string} Label such as `baseline: |dev| > 30% (prev 14d mean)`.
 */
export function baselineLabel(threshold) {
  return `baseline: |dev| > ${(threshold * 100).toFixed(0)}% (prev 14d mean)`;
}
