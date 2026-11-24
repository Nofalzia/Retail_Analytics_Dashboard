/**
 * services/isolationForest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure Isolation Forest detector (Liu, Ting & Zhou, ICDM 2008) for product-day
 * sales anomalies. It is meant to run ALONGSIDE the rolling z-score in
 * services/rollingZScore.js, not to replace it.
 *
 * WHY A SECOND DETECTOR
 * A z-score asks "how many standard deviations from the mean is this day?" and
 * therefore assumes one roughly-normal shape per (product, day). Isolation
 * Forest asks a different question — "how few random splits does it take to
 * separate this product-day from the rest of the tenant's history?" — and needs
 * no distributional assumption. It can therefore pick up odd *combinations*
 * (normal units on an abnormal revenue, a weekday-profile break) that a
 * single-series z-score cannot express.
 *
 * MODEL SHAPE
 *   • One model per tenant, fitted on that tenant's own history. No cross-tenant
 *     pooling: ~200 units/day is a routine day for one tenant and an outlier for
 *     another, so a shared feature space would encode the wrong baseline.
 *   • `treeCount` (100) trees. Each tree is built on `min(subsampleSize, n)`
 *     product-days drawn WITHOUT replacement, split by a random feature and a
 *     random threshold between that node's min and max of the feature, until
 *     the standard `ceil(log2(psi))` height limit.
 *   • Anomaly score s(x) = 2^(-E[h(x)] / c(psi)) ∈ (0, 1]; c(psi) is the
 *     average unsuccessful search length in a binary search tree (the 2008
 *     normaliser). Higher = more isolated = more anomalous.
 *
 * FEATURES (four, cheap, and explainable to a store manager)
 *   1. `units`                  — units sold that day (0 when there is no row).
 *   2. `revenue`                — that day's revenue (sum of the line totals).
 *   3. `residualVsWeekdayMean`  — units − mean(units on the same weekday over the
 *                                 previous `weekdayLookback` weeks). Removes the
 *                                 weekly cycle instead of asking the forest to
 *                                 rediscover it from a 14-day window.
 *   4. `ratioToPrevious14dMean` — units / max(mean(previous 14 days), 1), clipped
 *                                 to [0, ratioClip]. Scale-free, so one model can
 *                                 hold low- and high-volume products.
 * `units` and `revenue` are collinear when a product has one fixed price; on
 * real POS data prices move, so they are kept separate. A day is featurised
 * only once the product has `historyDays` (14) calendar days of its own history,
 * so no day is ever compared against an empty or one-point baseline.
 *
 * Pure module: no database access, no I/O, no Math.random. Every draw comes from
 * the seeded mulberry32 stream below, so the same data + seed always fit the
 * same forest and produce the same scores
 * (see scripts/validation/isolationForest.selftest.js).
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Default parameters (single source of truth for the detector).
 *
 * seed             — PRNG seed for subsampling and split selection.
 * treeCount        — number of trees (100 is the 2008 paper default).
 * subsampleSize    — per-tree subsample size ψ (256 as in the paper); the
 *                    effective size is `min(256, n)`.
 * historyDays      — calendar days of the product's own history that must exist
 *                    before a day may be featurised (14).
 * weekdayLookback  — weeks of same-weekday history averaged for the residual
 *                    feature (4 = one month).
 * minWeekdayPriors — same-weekday observations required before the residual is
 *                    meaningful (2 = two full weeks).
 * ratioClip        — upper clip for the ratio feature; a day can be "10× the
 *                    14-day mean" but not 1,000×.
 * contamination    — expected fraction of product-days that are anomalies. Sets
 *                    the flag threshold to the (1 − contamination) quantile of
 *                    the fitted scores. Tuned on development seeds only.
 * scoreThreshold   — explicit score cut-off; when set it overrides
 *                    `contamination` (the validation harness uses it for a
 *                    frozen, budget-matched comparison).
 * minSamples       — below this many product-days no model is fitted at all
 *                    (`fit` returns null); a 3-day-old tenant must not receive
 *                    confident anomaly claims.
 */
export const DEFAULT_IFOREST_PARAMS = {
  seed: 20261117,
  treeCount: 100,
  subsampleSize: 256,
  historyDays: 14,
  weekdayLookback: 4,
  minWeekdayPriors: 2,
  ratioClip: 20,
  contamination: 0.03,
  scoreThreshold: null,
  minSamples: 30,
};

/** Feature order of every vector this module produces or consumes. */
export const FEATURE_NAMES = Object.freeze([
  'units',
  'revenue',
  'residualVsWeekdayMean',
  'ratioToPrevious14dMean',
]);

/** Euler–Mascheroni constant, used by the standard c(n) normaliser. */
const EULER_MASCHERONI = 0.5772156649015329;

/** @returns {object} The parameter object with defaults applied. */
function resolveParams(params) {
  return { ...DEFAULT_IFOREST_PARAMS, ...(params ?? {}) };
}

/** @returns {number} Arithmetic mean of a list (0 for an empty list). */
function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** @returns {number} `value` limited to `[min, max]`. */
function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** @returns {string} The ISO date (YYYY-MM-DD) shifted by `deltaDays`. */
function shiftIsoDate(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Creates a mulberry32 generator (Tommy Ettinger's 32-bit PRNG).
 *
 * Deliberately duplicated from scripts/validation/prng.js: production code must
 * not import from the validation scripts. It is the same ten lines, and the
 * forest's reproducibility (same data + seed → same trees) is pinned by the
 * self-test; the two copies have to be kept in sync by hand.
 * @param {number} seed Any integer (coerced to uint32).
 * @returns {() => number} Function returning uniform values in [0, 1).
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * c(n): the average path length of an unsuccessful search in a binary search
 * tree of n nodes — the normaliser from the 2008 paper.
 * @param {number} n Node count.
 * @returns {number} c(n) >= 0.
 */
function averagePathLengthFactor(n) {
  if (n <= 1) return 0;
  if (n === 2) return 1;
  return 2 * (Math.log(n - 1) + EULER_MASCHERONI) - (2 * (n - 1)) / n;
}

/**
 * Turns raw product-day sales into labelled feature samples.
 *
 * Rows may be line items or already-aggregated days: they are summed per
 * (productKey, date). The calendar is the union of the dates present in `sales` —
 * exactly what the database can know, because `sale_transactions` has no row for a
 * zero-unit day. Any product-day absent from that calendar is treated as 0 units
 * and 0 revenue, the same zero-fill convention services/rollingZScore.js uses.
 *
 * A product-day is emitted only when the product already has `historyDays` (14)
 * calendar days of its own history and at least `minWeekdayPriors` earlier
 * observations of the same weekday, so every feature is computed against real
 * history rather than against an empty baseline.
 *
 * @param {Array<{productKey: string, date: string, units: number, revenue?: number}>} sales
 *   Rows for ONE tenant (the caller scopes by req.tenantId; this module never
 *   mixes tenants itself).
 * @param {object} [params] Detector parameters (defaults to DEFAULT_IFOREST_PARAMS).
 * @returns {{samples: Array<{productKey: string, date: string, features: number[]}>,
 *   dates: string[], productCount: number, skippedProducts: number}}
 *   `samples` is ordered by (productKey, date) so fits are reproducible.
 */
export function buildFeatureSamples(sales, params = DEFAULT_IFOREST_PARAMS) {
  const p = resolveParams(params);
  if (!Array.isArray(sales)) throw new TypeError('buildFeatureSamples: sales must be an array');

  /** @type {Map<string, Map<string, {units: number, revenue: number}>>} */
  const byProduct = new Map();
  const calendar = new Set();

  for (const row of sales) {
    const productKey = row?.productKey === undefined || row?.productKey === null
      ? ''
      : String(row.productKey);
    const date = row?.date === undefined || row?.date === null ? '' : String(row.date);
    if (!productKey || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const units = Number(row.units);
    if (!Number.isFinite(units) || units < 0) continue;
    const rawRevenue = row.revenue === undefined || row.revenue === null ? 0 : Number(row.revenue);
    const revenue = Number.isFinite(rawRevenue) && rawRevenue > 0 ? rawRevenue : 0;

    let byDate = byProduct.get(productKey);
    if (!byDate) {
      byDate = new Map();
      byProduct.set(productKey, byDate);
    }
    const day = byDate.get(date) ?? { units: 0, revenue: 0 };
    day.units += units;
    day.revenue += revenue;
    byDate.set(date, day);
    calendar.add(date);
  }

  const dates = [...calendar].sort();
  const samples = [];
  let skippedProducts = 0;

  for (const productKey of [...byProduct.keys()].sort()) {
    const byDate = byProduct.get(productKey);
    let firstSaleDate = null;
    for (const date of byDate.keys()) {
      if (firstSaleDate === null || date < firstSaleDate) firstSaleDate = date;
    }
    const unitsOn = (iso) => byDate.get(iso)?.units ?? 0;
    let emitted = 0;

    for (const date of dates) {
      if (date < firstSaleDate) continue;

      const previousDays = [];
      for (let back = 1; back <= p.historyDays; back += 1) {
        const iso = shiftIsoDate(date, -back);
        if (iso < firstSaleDate) break;
        previousDays.push(unitsOn(iso));
      }
      if (previousDays.length < p.historyDays) continue;

      const weekdayPriors = [];
      for (let week = 1; week <= p.weekdayLookback; week += 1) {
        const iso = shiftIsoDate(date, -7 * week);
        if (iso < firstSaleDate) break;
        weekdayPriors.push(unitsOn(iso));
      }
      if (weekdayPriors.length < p.minWeekdayPriors) continue;

      const units = unitsOn(date);
      const revenue = byDate.get(date)?.revenue ?? 0;
      const recentMean = mean(previousDays);
      samples.push({
        productKey,
        date,
        features: [
          units,
          revenue,
          units - mean(weekdayPriors),
          clamp(units / Math.max(recentMean, 1), 0, p.ratioClip),
        ],
      });
      emitted += 1;
    }

    if (emitted === 0) skippedProducts += 1;
  }

  return { samples, dates, productCount: byProduct.size, skippedProducts };
}

/**
 * Draws `sampleSize` distinct indices from `[0, populationSize)` using a partial
 * Fisher–Yates shuffle, so every subsample is uniform and reproducible per seed.
 * @param {number} populationSize Available rows.
 * @param {number} sampleSize Rows to draw (<= populationSize).
 * @param {() => number} rand Uniform generator in [0, 1).
 * @returns {number[]} Distinct indices, in draw order.
 */
function drawSubsampleIndices(populationSize, sampleSize, rand) {
  const pool = new Array(populationSize);
  for (let i = 0; i < populationSize; i += 1) pool[i] = i;
  for (let i = 0; i < sampleSize; i += 1) {
    const j = i + Math.floor(rand() * (populationSize - i));
    const swap = pool[i];
    pool[i] = pool[j];
    pool[j] = swap;
  }
  return pool.slice(0, sampleSize);
}

/**
 * Recursively builds one isolation tree over a subsample.
 *
 * A node becomes a leaf when it is deeper than `heightLimit`, holds at most one
 * row, or when the chosen feature is constant across its rows (no split exists) —
 * the same stopping rules as the 2008 paper.
 * @param {number[][]} featureVectors All rows (the tree only reads `indices`).
 * @param {number[]} indices Rows that reached this node.
 * @param {number} depth Current depth (root = 0).
 * @param {number} heightLimit Maximum depth.
 * @param {number} featureCount Number of features per row.
 * @param {() => number} rand Uniform generator in [0, 1).
 * @returns {{leaf: true, size: number}|{feature: number, split: number, left: object, right: object}}
 *   Tree node; leaves carry the number of rows they hold (needed for c(size)).
 */
function buildTree(featureVectors, indices, depth, heightLimit, featureCount, rand) {
  if (depth >= heightLimit || indices.length <= 1) return { leaf: true, size: indices.length };

  const feature = Math.floor(rand() * featureCount);
  let min = Infinity;
  let max = -Infinity;
  for (const index of indices) {
    const value = featureVectors[index][feature];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === max) return { leaf: true, size: indices.length };

  const split = min + rand() * (max - min);
  const left = [];
  const right = [];
  for (const index of indices) {
    if (featureVectors[index][feature] <= split) left.push(index);
    else right.push(index);
  }
  if (left.length === 0 || right.length === 0) return { leaf: true, size: indices.length };

  return {
    feature,
    split,
    left: buildTree(featureVectors, left, depth + 1, heightLimit, featureCount, rand),
    right: buildTree(featureVectors, right, depth + 1, heightLimit, featureCount, rand),
  };
}

/**
 * Path length h(x) of one row in one tree: the number of edges walked to reach a
 * leaf, plus c(size) of that leaf as the adjustment for the rows still unsplit.
 * @param {object} node Tree node from buildTree.
 * @param {number[]} features The row being scored.
 * @returns {number} Path length >= 0.
 */
function pathLength(node, features) {
  if (node.leaf) return averagePathLengthFactor(node.size);
  const next = features[node.feature] <= node.split ? node.left : node.right;
  return 1 + pathLength(next, features);
}

/**
 * The (1 − contamination) quantile of a list of scores, used as the flag
 * threshold when no explicit `scoreThreshold` is given.
 * @param {number[]} scores Fitted scores.
 * @param {number} contamination Expected anomalous fraction (clamped to [0, 1]).
 * @returns {number} Score cut-off such that roughly `contamination × n` rows are
 *   at or above it.
 */
function quantileThreshold(scores, contamination) {
  const sorted = [...scores].sort((a, b) => a - b);
  const fraction = clamp(Number.isFinite(contamination) ? contamination : 0, 0, 1);
  const index = clamp(Math.ceil((1 - fraction) * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[index];
}

/**
 * Fits one Isolation Forest on feature vectors from a SINGLE tenant's history.
 *
 * Returns null (rather than a model with no evidence behind it) when there are
 * fewer than `minSamples` rows or no features at all — the caller must then emit
 * no anomaly claims at all.
 *
 * The returned model also carries the flag `threshold` (an explicit
 * `scoreThreshold`, else the (1 − contamination) quantile of the scores this
 * model gives its own training rows) and `flaggedOnTraining`, so a caller can
 * report the expected flag volume without re-deriving it.
 *
 * @param {number[][]} featureVectors Rows in FEATURE_NAMES order.
 * @param {object} [params] Detector parameters (defaults to DEFAULT_IFOREST_PARAMS).
 * @returns {null|{params: object, featureNames: readonly string[], featureCount: number,
 *   treeCount: number, subsampleSize: number, heightLimit: number, normalization: number,
 *   trees: object[], trainedOn: number, threshold: number, flaggedOnTraining: number}}
 *   The fitted forest, or null when there is not enough data.
 * @throws {TypeError} If a row is not an array of finite numbers of equal length.
 */
export function fitIsolationForest(featureVectors, params = DEFAULT_IFOREST_PARAMS) {
  const p = resolveParams(params);
  if (!Array.isArray(featureVectors)) {
    throw new TypeError('fitIsolationForest: featureVectors must be an array');
  }
  if (featureVectors.length < p.minSamples) return null;

  const featureCount = Array.isArray(featureVectors[0]) ? featureVectors[0].length : 0;
  if (featureCount === 0) return null;
  for (const vector of featureVectors) {
    if (!Array.isArray(vector) || vector.length !== featureCount) {
      throw new TypeError('fitIsolationForest: every row must be an array of the same length');
    }
    for (const value of vector) {
      if (!Number.isFinite(value)) {
        throw new TypeError('fitIsolationForest: every feature value must be finite');
      }
    }
  }

  const treeCount = Math.max(1, Math.floor(p.treeCount));
  const subsampleSize = Math.max(2, Math.min(Math.floor(p.subsampleSize), featureVectors.length));
  const heightLimit = Math.ceil(Math.log2(subsampleSize));
  const rand = mulberry32(p.seed);

  const trees = [];
  for (let tree = 0; tree < treeCount; tree += 1) {
    const indices = drawSubsampleIndices(featureVectors.length, subsampleSize, rand);
    trees.push(buildTree(featureVectors, indices, 0, heightLimit, featureCount, rand));
  }

  const model = {
    params: p,
    featureNames: FEATURE_NAMES,
    featureCount,
    treeCount,
    subsampleSize,
    heightLimit,
    normalization: averagePathLengthFactor(subsampleSize),
    trees,
    trainedOn: featureVectors.length,
    threshold: 0,
    flaggedOnTraining: 0,
  };

  const scores = featureVectors.map((vector) => scoreIsolationForest(model, vector));
  const explicit = p.scoreThreshold === null || p.scoreThreshold === undefined
    ? null
    : Number(p.scoreThreshold);
  model.threshold = Number.isFinite(explicit) ? explicit : quantileThreshold(scores, p.contamination);
  model.flaggedOnTraining = scores.filter((score) => score >= model.threshold).length;
  return model;
}

/**
 * Anomaly score of one feature vector: s = 2^(-E[h(x)] / c(ψ)), clamped to [0, 1].
 * @param {null|object} model A model from fitIsolationForest.
 * @param {number[]} features A row in FEATURE_NAMES order.
 * @returns {null|number} Score in [0, 1] (higher = more anomalous), or null when
 *   the model is missing or the row has the wrong shape.
 */
export function scoreIsolationForest(model, features) {
  if (!model || !Array.isArray(model.trees) || model.trees.length === 0) return null;
  if (!Array.isArray(features) || features.length !== model.featureCount) return null;

  let total = 0;
  for (const tree of model.trees) total += pathLength(tree, features);
  const expectedPath = total / model.trees.length;
  const normalizer = model.normalization > 0 ? model.normalization : 1;
  return clamp(2 ** (-expectedPath / normalizer), 0, 1);
}

/**
 * The `budget` highest-scoring days, with a deterministic tie-break.
 *
 * Ties happen on real data (identical integer features), so the tie-break is
 * explicit: score descending, then productKey ascending, then date ascending.
 * That makes a budget-matched comparison reproducible instead of depending on
 * sort stability.
 * @param {Array<{productKey: string, date: string, score: number}>} scored Rows from detectAnomalies.
 * @param {number} budget How many rows to keep.
 * @returns {Array<{productKey: string, date: string, score: number}>} Top `budget` rows.
 */
export function topScoredDays(scored, budget) {
  const sorted = [...scored].sort((a, b) => (
    b.score - a.score
    || a.productKey.localeCompare(b.productKey)
    || a.date.localeCompare(b.date)
  ));
  const limit = Math.max(0, Math.floor(Number.isFinite(budget) ? budget : 0));
  return sorted.slice(0, limit);
}

/**
 * End-to-end convenience wrapper for one tenant: featurise → fit → score → flag.
 *
 * `scored` contains EVERY featurised day (so a caller can apply its own budget
 * via topScoredDays), while `flagged` already applies `model.threshold`.
 * @param {Array<{productKey: string, date: string, units: number, revenue?: number}>} sales
 *   One tenant's product-day rows.
 * @param {object} [params] Detector parameters (defaults to DEFAULT_IFOREST_PARAMS).
 * @returns {{model: null|object, threshold: null|number, dates: string[],
 *   productCount: number, skippedProducts: number, sampleCount: number,
 *   scored: Array<{productKey: string, date: string, features: number[], score: number}>,
 *   flagged: Array<{productKey: string, date: string, features: number[], score: number}>}}
 *   Detection result; `model` and `threshold` are null when there is too little
 *   history to fit.
 */
export function detectAnomalies(sales, params = DEFAULT_IFOREST_PARAMS) {
  const p = resolveParams(params);
  const { samples, dates, productCount, skippedProducts } = buildFeatureSamples(sales, p);
  const model = fitIsolationForest(samples.map((sample) => sample.features), p);
  const shape = { dates, productCount, skippedProducts, sampleCount: samples.length };

  if (model === null) {
    return { model: null, threshold: null, ...shape, scored: [], flagged: [] };
  }

  const scored = samples.map((sample) => ({
    productKey: sample.productKey,
    date: sample.date,
    features: sample.features,
    score: scoreIsolationForest(model, sample.features),
  }));
  const flagged = scored.filter((day) => day.score >= model.threshold);
  return { model, threshold: model.threshold, ...shape, scored, flagged };
}
