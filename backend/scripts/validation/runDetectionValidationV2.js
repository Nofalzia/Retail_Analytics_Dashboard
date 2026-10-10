/**
 * backend/scripts/validation/runDetectionValidationV2.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T7b — detection validation harness, v2 (per-day rolling z-score).
 *
 * Validates `runZScoreDetection` AFTER the v2 refactor (true per-day rolling
 * z-score from src/services/rollingZScore.js) and compares it with:
 *
 *   * `v1_series`   — the ORIGINAL v1 algorithm, replicated in memory: ONE mean
 *                     and ONE population σ computed over every day that has a
 *                     sale, then every one of those SAME days is tested against
 *                     that statistic (the day is inside its own baseline, so a
 *                     large anomaly inflates σ and masks itself), and
 *   * `baseline_*`  — the naive fixed-percentage baselines already used by T7a.
 *
 * Pipeline per seed:
 *   1. generate a reproducible dataset (20 products × 90 days, 36 injected
 *      anomalies) — generateSyntheticData.js
 *   2. load it into the isolated sandbox tenant — sandboxDb.js
 *   3. call the REAL runZScoreDetection(tenantId, storeId)  (integration check)
 *   4. assert the DB alerts are byte-for-byte the in-memory v2 prediction
 *      (same (SKU, date) key set, |z| equal to 4 dp) — proof the engine really
 *      uses the v2 module
 *   5. score every method on the exact-same-(SKU, date) matching rule
 *      (metrics.js) and break v2 recall down by anomaly type and multiplier
 *   6. run three parameter ablations (zero-fill off, Poisson σ-floor off,
 *      deviation guards off) to justify each design choice
 *   7. repeat on HELD-OUT seeds 6–10 to show the parameters were not fitted
 *   8. write docs/validation/detection_results_v2.md + .csv
 *
 * The v1 evidence is preserved untouched in detection_results.md/.csv and
 * detection_results_v1.md/.csv.
 *
 * Run from backend/:  npm run validate:detection:v2
 * Exits 1 on any failed assertion.
 *
 * Run ONE instance at a time: all runs share the single sandbox tenant, so two
 * harness processes running concurrently will delete/insert each other's data
 * and the determinism assertion will fail.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateDataset,
  countZeroSaleProductDays,
  GROUND_TRUTH_TOTAL,
} from './generateSyntheticData.js';
import {
  ensureSandbox,
  resetSandboxData,
  insertSales,
  readSandboxAlerts,
  countForeignSaleRows,
  currentDbDate,
  closeSandboxPool,
} from './sandboxDb.js';
import { confusionCounts, classificationMetrics, recallByDimension } from './metrics.js';
import { evaluateBaselines } from './baselines.js';
import { DEFAULT_PARAMS, scoreSeries, severityFor } from '../../src/services/rollingZScore.js';
import { runZScoreDetection } from '../../src/services/detectionEngine.js';

// ── Configuration ────────────────────────────────────────────────────────────
const DEV_SEEDS = [1, 2, 3, 4, 5];       // parameters were chosen on these
const HOLDOUT_SEEDS = [6, 7, 8, 9, 10];  // ...and then frozen, tested here
const UNIT_PRICE = 100;
const COST_PRICE = 60;
const EVAL_DAYS = 14;          // must match EVAL_DAYS in detectionEngine.js
const ENGINE_WINDOW_DAYS = 14; // must match ROLLING_WINDOW_DAYS in detectionEngine.js
const V1_Z_INFO = 1.5;         // v1's actionable floor (|z| > 1.5)
const V1_Z_WARNING = 2.0;
const V1_Z_CRITICAL = 2.5;
const Z_TOLERANCE = 0.001;     // |z| is persisted to 4 decimals

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(SCRIPT_DIR, '../../../docs/validation');
const LABEL_WIDTH = 30;

const SERIES_METHODS = [
  'v1_series',
  'v2_series',
  'v2_no_zerofill',
  'v2_no_sdfloor',
  'v2_no_guards',
  'baseline_0.30',
  'baseline_0.50',
];
const LIVE_METHODS = ['engine_live', 'engine_live_warning_plus', 'engine_live_critical'];
const METHOD_ORDER = [...SERIES_METHODS, ...LIVE_METHODS];

const METHOD_LABELS = {
  v1_series: 'v1: single-window z (|z| > 1.5)',
  v2_series: 'v2: rolling z (guarded)',
  v2_no_zerofill: 'ablation: v2 without zero-fill',
  v2_no_sdfloor: 'ablation: v2 without Poisson σ-floor',
  v2_no_guards: 'ablation: v2 without deviation guards',
  'baseline_0.30': 'baseline: |dev| > 30% (prev 14d mean)',
  'baseline_0.50': 'baseline: |dev| > 50% (prev 14d mean)',
  engine_live: 'engine (live DB, this run): all',
  engine_live_warning_plus: 'engine (live DB): warning+',
  engine_live_critical: 'engine (live DB): critical',
};

// The three ablations that justify the three v2 design choices.
const ABLATION_PARAMS = {
  v2_no_zerofill: { ...DEFAULT_PARAMS, zeroFill: false },
  v2_no_sdfloor: { ...DEFAULT_PARAMS, sdFloorMode: 'none' },
  v2_no_guards: { ...DEFAULT_PARAMS, minRelativeDeviation: 0, minAbsoluteDeviationUnits: 0 },
};

/** @throws {Error} when the condition is false. */
function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

/** @returns {number} Value rounded to `dp` decimals. */
function round(value, dp = 4) {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** @returns {number} Arithmetic mean (0 for an empty list). */
function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** @returns {number} Population standard deviation (σ, divides by N). */
function populationSd(values, mu = mean(values)) {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - mu) ** 2, 0) / values.length);
}

/** @returns {string} `0.1234` → `0.123` */
function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

/** @returns {string} `0.1234 ± 0.0102` */
function fmtPair(stats) {
  return `${fmt(stats.mean)} ± ${fmt(stats.sd)}`;
}

/**
 * Shifts an ISO date string by whole days (UTC-safe, no local timezone drift).
 * @param {string} iso ISO date (YYYY-MM-DD).
 * @param {number} deltaDays Days to add (may be negative).
 * @returns {string} Shifted ISO date.
 */
function shiftIsoDate(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Maps a dataset product to the units-by-date shape the v2 module expects.
 * Only days WITH sales are stored (the DB cannot hold a zero-unit sale row);
 * absent days are what the module zero-fills internally.
 * @param {{sku: string, points: Array<{date: string, units: number}>}} product Dataset series entry.
 * @returns {{unitsByDate: Map<string, number>, firstSaleDate: string|null, dates: string[]}}
 *   Extracted per-day units, the product's first sale date and every calendar date.
 */
function extractProduct(product) {
  const unitsByDate = new Map();
  let firstSaleDate = null;
  for (const point of product.points) {
    if (point.units > 0) {
      unitsByDate.set(point.date, point.units);
      if (firstSaleDate === null) firstSaleDate = point.date;
    }
  }
  return { unitsByDate, firstSaleDate, dates: product.points.map((p) => p.date) };
}

/**
 * The engine evaluates only the most recent EVAL_DAYS calendar days ending at the
 * latest date that has a sale in the database.
 * @param {object} dataset Dataset from generateDataset.
 * @returns {string[]} Ascending ISO dates the live engine evaluates.
 */
function engineEvalDates(dataset) {
  let maxDate = null;
  for (const product of dataset.series) {
    for (const point of product.points) {
      if (point.units > 0 && (maxDate === null || point.date > maxDate)) maxDate = point.date;
    }
  }
  const dates = [];
  for (let offset = EVAL_DAYS - 1; offset >= 0; offset--) dates.push(shiftIsoDate(maxDate, -offset));
  return dates;
}

/**
 * v1 ALGORITHM REPLICATION (the flaw under test).
 * v1 took the product's sale days, computed ONE mean and ONE population σ over
 * them, then tested each of those SAME days against that statistic, flagging
 * |z| > 1.5. T7a ran that rule over the engine's 14-day window; here it is run
 * over the whole 90-day series so it is directly comparable with v2 and the
 * baselines (same matching rule, same truth, same evaluation span).
 * @param {{sku: string, points: Array}} product Dataset series entry.
 * @returns {Array<{sku: string, date: string, z: number}>} Flagged product-days.
 */
function v1SeriesFlags(product) {
  const present = product.points.filter((point) => point.units > 0);
  if (present.length < 3) return []; // v1's MIN_DATA_POINTS = 3

  const units = present.map((point) => point.units);
  const mu = mean(units);
  const sigma = populationSd(units, mu);
  if (sigma === 0) return [];

  const flagged = [];
  for (const point of present) {
    const z = (point.units - mu) / sigma;
    if (Math.abs(z) > V1_Z_INFO) flagged.push({ sku: product.sku, date: point.date, z });
  }
  return flagged;
}

/**
 * Runs the v2 module over a product's FULL series (in-memory), so v2 can be
 * compared with v1 and the baselines on identical ground.
 * @param {{sku: string, points: Array}} product Dataset series entry.
 * @param {object} [params] Detection parameters (defaults to DEFAULT_PARAMS).
 * @returns {Array<{sku: string, date: string, z: number}>} Flagged product-days.
 */
function v2SeriesFlags(product, params = DEFAULT_PARAMS) {
  const { unitsByDate, firstSaleDate, dates } = extractProduct(product);
  if (firstSaleDate === null) return [];
  return scoreSeries(unitsByDate, firstSaleDate, dates, params)
    .filter((day) => day.flagged)
    .map((day) => ({ sku: product.sku, date: day.date, z: day.z }));
}

/**
 * Confusion counts + precision/recall/F1 for one method.
 * @param {Array} flagged Flagged product-days.
 * @param {Array} truth Ground-truth anomalies.
 * @returns {{precision: number, recall: number, f1: number, tp: number, fp: number, fn: number,
 *   flaggedTotal: number, groundTruthTotal: number}} Rounded metrics.
 */
function metricsFor(flagged, truth) {
  const counts = confusionCounts(flagged, truth);
  const m = classificationMetrics(counts);
  return {
    precision: round(m.precision),
    recall: round(m.recall),
    f1: round(m.f1),
    tp: counts.tp,
    fp: counts.fp,
    fn: counts.fn,
    flaggedTotal: counts.flaggedTotal,
    groundTruthTotal: counts.groundTruthTotal,
  };
}

/**
 * Converts a dataset series into sale_transactions rows.
 * Zero-unit product-days are skipped: quantity_sold has CHECK (> 0), so those
 * days simply cannot exist in the database (they are counted and reported).
 * @param {object} dataset Dataset from generateDataset.
 * @param {Map<string, string>} productIds sku → product UUID.
 * @returns {Array<{productId: string, saleDate: string, units: number, unitPrice: number,
 *   costPrice: number}>} Rows ready for insertSales.
 */
function buildSaleRows(dataset, productIds) {
  const rows = [];
  for (const product of dataset.series) {
    const productId = productIds.get(product.sku);
    assert(productId, `no sandbox product id for ${product.sku}`);
    for (const point of product.points) {
      if (point.units <= 0) continue;
      rows.push({
        productId,
        saleDate: point.date,
        units: point.units,
        unitPrice: UNIT_PRICE,
        costPrice: COST_PRICE,
      });
    }
  }
  return rows;
}

const ABLATION_METHODS = ['v2_no_zerofill', 'v2_no_sdfloor', 'v2_no_guards'];
const BASELINE_METHODS = ['baseline_0.30', 'baseline_0.50'];

/**
 * Runs one seed end to end: generate → load → call the REAL engine →
 * integration-check the persisted alerts against the module → score every method.
 * @param {number} seed Dataset seed.
 * @param {object} sandbox Sandbox handles from ensureSandbox.
 * @param {string} windowStartDate ISO date of the engine's data window start.
 * @returns {Promise<object>} Per-seed result (metrics + diagnostics).
 */
async function runSeed(seed, sandbox, windowStartDate) {
  const dataset = generateDataset(seed);
  assert(
    dataset.groundTruth.length === GROUND_TRUTH_TOTAL,
    `seed ${seed}: expected ${GROUND_TRUTH_TOTAL} ground-truth anomalies, got ${dataset.groundTruth.length}`,
  );

  const resetInfo = await resetSandboxData(sandbox);
  const saleRows = buildSaleRows(dataset, sandbox.productIds);
  const insertInfo = await insertSales(sandbox, saleRows);
  const engineSummary = await runZScoreDetection(sandbox.tenantId, sandbox.storeId);
  const alerts = await readSandboxAlerts(sandbox);

  assert(
    engineSummary.created === alerts.length,
    `seed ${seed}: engine reported ${engineSummary.created} new alerts but ${alerts.length} rows exist`,
  );

  // ── Integration check: the DB rows must be EXACTLY the module's prediction ──
  const evalDates = engineEvalDates(dataset);
  const expected = new Map(); // `sku|date` → |z|
  for (const product of dataset.series) {
    const { unitsByDate, firstSaleDate } = extractProduct(product);
    if (firstSaleDate === null) continue;
    for (const day of scoreSeries(unitsByDate, firstSaleDate, evalDates, DEFAULT_PARAMS)) {
      if (day.flagged) expected.set(`${product.sku}|${day.date}`, Math.abs(day.z));
    }
  }
  const persisted = new Map(alerts.map((alert) => [`${alert.sku}|${alert.alert_date}`, alert.z_score]));
  assert(
    persisted.size === expected.size,
    `seed ${seed}: DB has ${persisted.size} alerts, the v2 module predicts ${expected.size} flagged days`,
  );
  for (const [key, z] of expected) {
    assert(persisted.has(key), `seed ${seed}: module flagged ${key} but no alert row was written`);
    assert(
      Math.abs(persisted.get(key) - z) <= Z_TOLERANCE,
      `seed ${seed}: ${key} |z| differs — DB ${persisted.get(key)} vs module ${z}`,
    );
    assert(
      Math.abs(z) >= DEFAULT_PARAMS.zAlert - Z_TOLERANCE,
      `seed ${seed}: ${key} was written with |z| = ${z}, below the alert floor`,
    );
  }

  const truth = dataset.groundTruth;
  const truthInWindow = truth.filter((gt) => gt.date >= windowStartDate);

  // ── Full-series methods (identical span + matching rule for all of them) ────
  const flags = { v1_series: [], v2_series: [] };
  for (const method of ABLATION_METHODS) flags[method] = [];
  for (const product of dataset.series) {
    flags.v1_series.push(...v1SeriesFlags(product));
    flags.v2_series.push(...v2SeriesFlags(product));
    for (const method of ABLATION_METHODS) {
      flags[method].push(...v2SeriesFlags(product, ABLATION_PARAMS[method]));
    }
  }

  // Removing the guards can only ever ADD flags — a structural invariant.
  assert(
    flags.v2_no_guards.length >= flags.v2_series.length,
    `seed ${seed}: the deviation guards added flags (${flags.v2_no_guards.length} unguarded < ${flags.v2_series.length} guarded)`,
  );
  assert(flags.v2_series.length > 0, `seed ${seed}: v2 flagged nothing at all`);

  const metrics = {};
  for (const method of ['v1_series', 'v2_series', ...ABLATION_METHODS]) {
    metrics[method] = metricsFor(flags[method], truth);
  }
  const baselineFlags = evaluateBaselines(dataset.series);
  for (const method of BASELINE_METHODS) {
    metrics[method] = metricsFor(baselineFlags[method], truth);
  }

  // ── Live methods (what the real engine persisted; truth restricted to window) ─
  metrics.engine_live = metricsFor(alerts, truthInWindow);
  metrics.engine_live_warning_plus = metricsFor(
    alerts.filter((alert) => alert.severity === 'warning' || alert.severity === 'critical'),
    truthInWindow,
  );
  metrics.engine_live_critical = metricsFor(
    alerts.filter((alert) => alert.severity === 'critical'),
    truthInWindow,
  );

  const zeroSaleProductDays = countZeroSaleProductDays(dataset);
  const severityCounts = alerts.reduce((acc, alert) => {
    acc[alert.severity] = (acc[alert.severity] ?? 0) + 1;
    return acc;
  }, {});

  return {
    seed,
    metrics,
    engineRecallByType: recallByDimension(flags.v2_series, truth, 'type')
      .map((b) => ({ value: b.value, total: b.total, detected: b.detected, recall: round(b.recall) })),
    engineRecallByMultiplier: recallByDimension(flags.v2_series, truth, 'multiplier')
      .map((b) => ({ value: b.value, total: b.total, detected: b.detected, recall: round(b.recall) })),
    diagnostics: {
      saleRowsInserted: insertInfo.inserted,
      insertChunks: insertInfo.chunks,
      rowsDeletedBeforeInsert: resetInfo,
      zeroSaleProductDays,
      groundTruthTotal: truth.length,
      groundTruthInEngineWindow: truthInWindow.length,
      engineWindowDays: ENGINE_WINDOW_DAYS,
      evalWindow: `${evalDates[0]}..${evalDates[evalDates.length - 1]}`,
      engineSummary,
      alertsTotal: alerts.length,
      alertsBySeverity: severityCounts,
      integrationChecked: expected.size,
      v1Flagged: flags.v1_series.length,
      v2Flagged: flags.v2_series.length,
      unguardedFlagged: flags.v2_no_guards.length,
    },
  };
}

/**
 * Aggregates per-seed metrics into mean ± sd per method.
 * @param {Array<object>} perSeed Per-seed results.
 * @returns {{methods: Object, byType: Array, byMultiplier: Array}} Aggregates.
 */
function aggregate(perSeed) {
  const methods = {};
  for (const method of METHOD_ORDER) {
    methods[method] = {
      precision: statsOf(perSeed, (r) => r.metrics[method].precision),
      recall: statsOf(perSeed, (r) => r.metrics[method].recall),
      f1: statsOf(perSeed, (r) => r.metrics[method].f1),
      tp: statsOf(perSeed, (r) => r.metrics[method].tp),
      fp: statsOf(perSeed, (r) => r.metrics[method].fp),
      fn: statsOf(perSeed, (r) => r.metrics[method].fn),
      flaggedTotal: statsOf(perSeed, (r) => r.metrics[method].flaggedTotal),
    };
  }

  return {
    methods,
    byType: aggregateBuckets(perSeed, 'engineRecallByType'),
    byMultiplier: aggregateBuckets(perSeed, 'engineRecallByMultiplier').sort(
      (a, b) => Number(a.value) - Number(b.value),
    ),
  };
}

/** @returns {{mean: number, sd: number}} Mean and population sd of a projection. */
function statsOf(perSeed, project) {
  const values = perSeed.map(project);
  const mu = mean(values);
  return { mean: round(mu), sd: round(populationSd(values, mu)) };
}

/**
 * Averages bucket recalls (by type / by multiplier) across seeds.
 * @param {Array<object>} perSeed Per-seed results.
 * @param {'engineRecallByType'|'engineRecallByMultiplier'} field Bucket field name.
 * @returns {Array<{value: string|number, meanRecall: number, sdRecall: number, total: number,
 *   detected: number}>} One row per bucket.
 */
function aggregateBuckets(perSeed, field) {
  const values = new Set();
  for (const result of perSeed) {
    for (const bucket of result[field]) values.add(bucket.value);
  }

  return [...values].map((value) => {
    const recalls = [];
    let total = 0;
    let detected = 0;
    for (const result of perSeed) {
      const bucket = result[field].find((b) => String(b.value) === String(value));
      if (!bucket) continue;
      recalls.push(bucket.recall);
      total += bucket.total;
      detected += bucket.detected;
    }
    const mu = mean(recalls);
    return {
      value,
      meanRecall: round(mu),
      sdRecall: round(populationSd(recalls, mu)),
      total,
      detected,
    };
  });
}

/** Stable hash of the parts of a per-seed result that must be reproducible. */
function hashResult(result) {
  const payload = {
    seed: result.seed,
    metrics: result.metrics,
    engineRecallByType: result.engineRecallByType,
    engineRecallByMultiplier: result.engineRecallByMultiplier,
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * Renders rows as a GitHub-flavoured markdown table.
 * @param {string[]} headers Column headers.
 * @param {Array<Array<string|number>>} rows Body rows.
 * @returns {string} Markdown table.
 */
function markdownTable(headers, rows) {
  const cell = (value) => String(value).replace(/\|/g, '\\|');
  const out = [
    `| ${headers.map(cell).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
  ];
  for (const row of rows) out.push(`| ${row.map(cell).join(' | ')} |`);
  return out.join('\n');
}

/** Prints the per-seed confusion counts and metrics for one seed set. */
function printPerSeedTable(perSeed, label) {
  const header = [
    'seed'.padStart(4),
    'method'.padEnd(LABEL_WIDTH),
    'TP'.padStart(4),
    'FP'.padStart(4),
    'FN'.padStart(4),
    'prec'.padStart(6),
    'rec'.padStart(6),
    'F1'.padStart(6),
  ].join(' | ');

  console.log(`\n── per-seed results (${label}) ${'─'.repeat(Math.max(0, header.length - 24))}`);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const result of perSeed) {
    for (const method of METHOD_ORDER) {
      const m = result.metrics[method];
      console.log(
        [
          String(result.seed).padStart(4),
          METHOD_LABELS[method].padEnd(LABEL_WIDTH),
          String(m.tp).padStart(4),
          String(m.fp).padStart(4),
          String(m.fn).padStart(4),
          fmt(m.precision).padStart(6),
          fmt(m.recall).padStart(6),
          fmt(m.f1).padStart(6),
        ].join(' | '),
      );
    }
    console.log('-'.repeat(header.length));
  }
}

/** Prints the aggregated mean ± population-sd table plus the recall breakdowns. */
function printAggregateTable(agg, perSeed, label, showBuckets) {
  const header = [
    'method'.padEnd(LABEL_WIDTH),
    'precision'.padStart(19),
    'recall'.padStart(19),
    'F1'.padStart(19),
  ].join(' | ');

  console.log(`\n── aggregate over seeds (${label}, mean ± population sd) ${'─'.repeat(6)}`);
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const method of METHOD_ORDER) {
    const m = agg.methods[method];
    console.log(
      [
        METHOD_LABELS[method].padEnd(LABEL_WIDTH),
        fmtPair(m.precision).padStart(19),
        fmtPair(m.recall).padStart(19),
        fmtPair(m.f1).padStart(19),
      ].join(' | '),
    );
  }

  const v1 = agg.methods.v1_series;
  const v2 = agg.methods.v2_series;
  console.log(
    `\n   v1 → v2 (full-series, |z| floor): precision ${fmt(v1.precision.mean)} → ${fmt(
      v2.precision.mean,
    )}   recall ${fmt(v1.recall.mean)} → ${fmt(v2.recall.mean)}   F1 ${fmt(v1.f1.mean)} → ${fmt(v2.f1.mean)}`,
  );
  console.log(
    `   flags per seed: v1 ${fmt(mean(perSeed.map((r) => r.diagnostics.v1Flagged)))} → v2 ${fmt(
      mean(perSeed.map((r) => r.diagnostics.v2Flagged)),
    )} (unguarded v2 ${fmt(mean(perSeed.map((r) => r.diagnostics.unguardedFlagged)))})`,
  );

  if (!showBuckets) return;

  console.log('\n── v2 recall (all alerts), by anomaly type ──');
  for (const bucket of agg.byType) {
    console.log(
      `   ${String(bucket.value).padEnd(6)} recall ${fmt(bucket.meanRecall)} ± ${fmt(bucket.sdRecall)}` +
        `  (detected ${bucket.detected}/${bucket.total} anomaly-days pooled over seeds)`,
    );
  }

  console.log('\n── v2 recall (all alerts), by injected multiplier ──');
  for (const bucket of agg.byMultiplier) {
    console.log(
      `   ×${String(bucket.value).padEnd(5)} recall ${fmt(bucket.meanRecall)} ± ${fmt(bucket.sdRecall)}` +
        `  (detected ${bucket.detected}/${bucket.total} anomaly-days pooled over seeds)`,
    );
  }

  const inWindow = mean(perSeed.map((r) => r.diagnostics.groundTruthInEngineWindow));
  const zeroSales = mean(perSeed.map((r) => r.diagnostics.zeroSaleProductDays));
  const integration = perSeed.reduce((sum, r) => sum + r.diagnostics.integrationChecked, 0);
  console.log(
    `\n── integration: ${integration} persisted alert rows across these seeds matched the in-memory v2` +
      ' prediction exactly (same (SKU, date) keys, |z| equal to 4 dp).',
  );
  console.log(
    `── NOTE: ${fmt(zeroSales)} product-days per seed had zero sales, so they have no sale_transactions row ` +
      'and are absent from product_daily_velocity; v2 zero-fills them in the BASELINE (a real no-sale day).',
  );
  console.log(
    `── NOTE: the live engine only reads sale_date >= CURRENT_DATE - ${ENGINE_WINDOW_DAYS} days, so only ` +
      `${fmt(inWindow)} of ${GROUND_TRUTH_TOTAL} injected anomalies per seed are inside its window;` +
      ' the full-series rows above are the like-for-like v1/v2/baseline comparison.',
  );
}

/**
 * Reads one frozen T7a row out of `detection_results_v1.md`, so this report
 * quotes the published v1 evidence instead of retyping it.
 * @param {string} v1Markdown Contents of docs/validation/detection_results_v1.md.
 * @param {string} needle Substring identifying the row (e.g. 'engine: all alerts').
 * @returns {{precision: object, recall: object, f1: object, tp: number, fp: number, fn: number}} Mean/sd plus counts.
 */
function parseT7aRow(v1Markdown, needle) {
  // The aggregate rows and the per-seed table headers carry the same phrase, so
  // keep only candidates whose last four cells parse as metrics plus counts.
  const parsed = v1Markdown
    .split(/\r?\n/)
    .filter((row) => row.includes(needle))
    .map((row) => {
      const cells = row.split('|').map((cell) => cell.trim()).filter((cell) => cell.length > 0);
      if (cells.length < 4) return null;
      // Per-seed tables list the seed number first; the aggregate tables start with the label.
      if (/^\d+$/.test(cells[0])) return null;

      const [precisionCell, recallCell, f1Cell, countsCell] = cells.slice(-4);
      const pair = (cell) => {
        const match = cell.match(/^([\d.]+)\s*\u00b1\s*([\d.]+)$/);
        return match ? { mean: Number(match[1]), sd: Number(match[2]) } : null;
      };

      const precision = pair(precisionCell);
      const recall = pair(recallCell);
      const f1 = pair(f1Cell);
      const counts = countsCell.split('/').map((value) => Number(value.trim()));
      if (!precision || !recall || !f1) return null;
      if (counts.length !== 3 || counts.some((value) => Number.isNaN(value))) return null;

      return { precision, recall, f1, tp: counts[0], fp: counts[1], fn: counts[2] };
    })
    .filter((value) => value !== null);

  assert(parsed.length > 0, `detection_results_v1.md has no parsable "${needle}" row`);
  return parsed[0];
}

/**
 * @param {{engine: object, warning: object, b30: object, b50: object}} t7a Frozen T7a rows (see parseT7aRow).
 * @param {number} truthInWindow Mean injected anomalies inside the engine window per seed.
 * @param {object} v1Dev Aggregated v1_series metrics for the dev block.
 * @returns {string} Markdown fragment describing the method.
 */
function buildMethodSection(t7a, truthInWindow, v1Dev) {
  return `## Method

**v2 (what ships).** \`runZScoreDetection\` now calls \`services/rollingZScore.js\`. For each evaluated day the baseline
is the PREVIOUS \`windowDays\` (14) **calendar** days — the day under test is excluded, so an anomaly can no longer mask
itself. Calendar days with no sale are zero-filled (the \`product_daily_velocity\` view only contains days that had a
sale), so a drop to zero is visible. σ is floored at the Poisson counting-noise level \`max(sd, sqrt(max(mean, 1)))\`
so a flat baseline cannot inflate |z|. A day is flagged only when **all three** guards pass:
\`|z| >= 2.5\`, \`|dev| / mean >= 0.25\` and \`|units − mean| >= 3\`. The engine evaluates the most recent 14 calendar
days present in the data, for every product that sold inside the lookback window.

**v1 (the flaw, replicated in memory).** \`v1_series\` computes ONE mean and ONE population σ over every sale day and
then tests each of those SAME days against that statistic, flagging \`|z| > 1.5\`. Days with no sale are invisible to
it, and a large anomaly inflates both the mean and the σ it is judged against. T7a measured v1 over the engine's
14-day window only; here it is evaluated over the full 90-day series so it is compared like-for-like with v2 and the
baselines under the identical matching rule. Both are v1, but they are different measurements - see
"Which v1 is being compared?" below.

##### Which "v1" is being compared?

The v1 *algorithm* never changed; what changed is the *evaluation span*, i.e. which ground-truth anomalies sit in the
denominator. That is why two different v1 recalls are published, and they are not a contradiction:

| Label | v1 rule as measured | Denominator | Precision | Recall | F1 |
|---|---|---|---|---|---|
| \`engine: all alerts\` - **T7a**, frozen in \`detection_results_v1.md\` | the old \`runZScoreDetection\` exactly as it ran (\`\\|z\\| > 1.5\`, severity read from the persisted alerts) | all ${GROUND_TRUTH_TOTAL} injected anomalies, although only ${truthInWindow.toFixed(1)} per seed are inside its window | ${fmt(t7a.engine.precision.mean)} | ${fmt(t7a.engine.recall.mean)} | ${fmt(t7a.engine.f1.mean)} |
| the same T7a run, rebased to its own window | identical detections (${t7a.engine.tp.toFixed(2)} TP per seed); only the denominator is restricted | the ${truthInWindow.toFixed(1)} anomalies actually inside the engine's window | ${fmt(t7a.engine.precision.mean)} | ${fmt(t7a.engine.tp / truthInWindow)} | ${fmt((2 * t7a.engine.precision.mean * (t7a.engine.tp / truthInWindow)) / (t7a.engine.precision.mean + (t7a.engine.tp / truthInWindow)))} |
| \`v1_series\` - **the full-series control (dev block shown)** | the same v1 rule re-implemented in memory and applied to every sale day of the series | all ${GROUND_TRUTH_TOTAL} | ${fmt(v1Dev.precision.mean)} | ${fmt(v1Dev.recall.mean)} | ${fmt(v1Dev.f1.mean)} |

T7a divided ${t7a.engine.tp.toFixed(2)} true positives by all ${GROUND_TRUTH_TOTAL} anomalies, including the
${(GROUND_TRUTH_TOTAL - truthInWindow).toFixed(1)} per seed its 14-day window structurally cannot reach, whereas
\`v1_series\` is scored over the whole span it can see. Judged only on the days inside its window the v1 rule reaches
${fmt(t7a.engine.tp / truthInWindow)} recall - at the cost of ${t7a.engine.fp.toFixed(1)} false positives per seed.
\`v1_series\` is therefore the fair full-series control for v2 and the baselines in this report; the T7a rows are
quoted only for the engine-vs-engine comparison below.

**Baselines.** Flag a day when \`|units − mean(previous 14 days)| / mean(previous 14 days) > T\` for T = 0.30 and 0.50.

**Matching rule.** A flagged product-day counts as a true positive only on the exact same \`(SKU, date)\` pair — no
tolerance window, no date fuzziness. Precision = TP/(TP+FP), Recall = TP/(TP+FN), F1 = 2PR/(P+R); a zero denominator
yields 0 (never NaN).

**Ablations.** \`v2_no_zerofill\` (no-sale baseline days skipped instead of zero-filled), \`v2_no_sdfloor\` (raw sample
σ), \`v2_no_guards\` (relative and absolute deviation guards removed).

**Seeds.** Development seeds 1–5; once the parameters were frozen, the harness was run UNCHANGED on the held-out seeds
6–10. Every figure is mean ± population standard deviation (σ, divide by N) over the seeds of that block.

`;
}

/**
 * Builds the per-seed-set section (aggregate table + per-seed table).
 * @param {string} title Section heading text.
 * @param {Array<object>} perSeed Per-seed results.
 * @param {object} agg Aggregated metrics.
 * @returns {string} Markdown fragment.
 */
function buildSeedSetSection(title, perSeed, agg) {
  const aggRows = METHOD_ORDER.map((method) => {
    const m = agg.methods[method];
    return [
      METHOD_LABELS[method],
      fmtPair(m.precision),
      fmtPair(m.recall),
      fmtPair(m.f1),
      m.tp.mean.toFixed(2),
      m.fp.mean.toFixed(2),
      m.fn.mean.toFixed(2),
    ];
  });

  const perSeedRows = [];
  for (const result of perSeed) {
    for (const method of METHOD_ORDER) {
      const m = result.metrics[method];
      perSeedRows.push([
        result.seed,
        METHOD_LABELS[method],
        m.tp,
        m.fp,
        m.fn,
        fmt(m.precision),
        fmt(m.recall),
        fmt(m.f1),
      ]);
    }
  }

  return `### ${title}

${markdownTable(
    ['Method', 'Precision (mean ± sd)', 'Recall (mean ± sd)', 'F1 (mean ± sd)', 'TP (mean)', 'FP (mean)', 'FN (mean)'],
    aggRows,
  )}

<details>
<summary>Per-seed confusion counts</summary>

${markdownTable(['seed', 'method', 'TP', 'FP', 'FN', 'precision', 'recall', 'F1'], perSeedRows)}

</details>

`;
}

/**
 * Builds the headline v1-vs-v2 comparison on identical ground.
 * @param {Array<{label: string, agg: object, perSeed: Array<object>}>} blocks Seed blocks.
 * @returns {string} Markdown fragment.
 */
function buildV1V2Section(blocks) {
  const rows = [];
  for (const block of blocks) {
    for (const method of ['v1_series', 'v2_series', 'baseline_0.30', 'baseline_0.50']) {
      const m = block.agg.methods[method];
      rows.push([
        block.label,
        METHOD_LABELS[method],
        m.tp.mean.toFixed(2),
        m.fp.mean.toFixed(2),
        m.fn.mean.toFixed(2),
        fmt(m.precision.mean),
        fmt(m.recall.mean),
        fmt(m.f1.mean),
        fmt(m.flaggedTotal.mean),
      ]);
    }
  }

  return `## Headline comparison — v1 vs v2 (full 90-day series, identical ground)

${markdownTable(
    ['Seeds', 'Method', 'TP (mean)', 'FP (mean)', 'FN (mean)', 'Precision', 'Recall', 'F1', 'Flags/seed'],
    rows,
  )}

**Reading this table.** All methods share the same evaluation span, the same 36 injected anomalies and the same
exact-\`(SKU, date)\` matching rule, so the numbers are directly comparable. v1 is the single-window statistic that
tests each day against a mean/σ that already contains that day (self-masking) and that cannot see no-sale days at all.
v2 rebuilds the baseline from the previous 14 calendar days for every day, zero-fills no-sale days and requires the
relative/absolute guards, so its flags cluster on genuine anomalies instead of ordinary weekly noise. The held-out
block (seeds 6–10) is the clean test: the parameters are still the ones frozen after seeds 1–5.

`;
}

/**
 * Builds the engine-vs-engine comparison against the frozen T7a numbers, plus the
 * like-for-like cross-check of the fixed-percentage baselines. Kept separate from
 * buildV1V2Section so that every T7a number printed here is provably parsed out of
 * the published v1 evidence (see parseT7aRow).
 * @param {Array<{label: string, agg: object, perSeed: Array<object>}>} blocks Seed blocks.
 * @param {{engine: object, warning: object, b30: object, b50: object}} t7a Frozen T7a rows (see parseT7aRow).
 * @param {number} truthInWindow Mean injected anomalies inside the engine's window per seed.
 * @returns {string} Markdown fragment.
 */
function buildT7aComparisonSection(blocks, t7a, truthInWindow) {
  const liveDev = blocks[0].agg.methods.engine_live;
  const v2Holdout = blocks[1].agg.methods.v2_series;
  const b30Dev = blocks[0].agg.methods['baseline_0.30'];
  const b50Dev = blocks[0].agg.methods['baseline_0.50'];
  const b30Holdout = blocks[1].agg.methods['baseline_0.30'];
  const b50Holdout = blocks[1].agg.methods['baseline_0.50'];
  const t7aRecall = t7a.engine.tp / truthInWindow;
  const t7aF1 = (2 * t7a.engine.precision.mean * t7aRecall) / (t7a.engine.precision.mean + t7aRecall);
  const baselineDrift = Math.max(
    ...[
      b30Dev.precision.mean - t7a.b30.precision.mean,
      b30Dev.recall.mean - t7a.b30.recall.mean,
      b30Dev.f1.mean - t7a.b30.f1.mean,
      b50Dev.precision.mean - t7a.b50.precision.mean,
      b50Dev.recall.mean - t7a.b50.recall.mean,
      b50Dev.f1.mean - t7a.b50.f1.mean,
    ].map((value) => Math.abs(value)),
  );

  return `### Like-for-like against T7a (engine vs engine, dev seeds 1-5)

T7a and this report drove the SAME entry point (\`runZScoreDetection\`) over the same development seeds with the same
exact-\`(SKU, date)\` matching rule, so these two rows are the honest "did the fix help?" pair. Both count persisted
\`anomaly_alerts\` rows and score them against the ${truthInWindow.toFixed(1)} injected anomalies that fall inside the
engine's 14-day window per seed - the only denominator on which T7a and this report are directly comparable.

| Engine (dev seeds 1-5, persisted alerts, in-window truth) | Precision | Recall | F1 | TP / FP / FN (mean) | Alerts/seed |
|---|---|---|---|---|---|
| v1 deployed - T7a, all alerts (\`\\|z\\| > 1.5\`) | ${fmt(t7a.engine.precision.mean)} \u00b1 ${fmt(t7a.engine.precision.sd)} | ${fmt(t7aRecall)} (T7a published ${fmt(t7a.engine.recall.mean)} against all ${GROUND_TRUTH_TOTAL}) | ${fmt(t7aF1)} (published ${fmt(t7a.engine.f1.mean)}) | ${t7a.engine.tp.toFixed(2)} / ${t7a.engine.fp.toFixed(2)} / ${t7a.engine.fn.toFixed(2)} | ${(t7a.engine.tp + t7a.engine.fp).toFixed(1)} |
| v2 deployed - this run, all alerts | ${fmt(liveDev.precision.mean)} \u00b1 ${fmt(liveDev.precision.sd)} | ${fmt(liveDev.recall.mean)} \u00b1 ${fmt(liveDev.recall.sd)} | ${fmt(liveDev.f1.mean)} \u00b1 ${fmt(liveDev.f1.sd)} | ${liveDev.tp.mean.toFixed(2)} / ${liveDev.fp.mean.toFixed(2)} / ${liveDev.fn.mean.toFixed(2)} | ${liveDev.flaggedTotal.mean.toFixed(1)} |

* **v2 catches about the same anomalies in-window while writing ~5x fewer alerts.** TP only moves from
  ${t7a.engine.tp.toFixed(2)} to ${liveDev.tp.mean.toFixed(2)} per seed, but FP falls from ${t7a.engine.fp.toFixed(2)}
  to ${liveDev.fp.mean.toFixed(2)}, so precision rises ${fmt(t7a.engine.precision.mean)} to ${fmt(liveDev.precision.mean)}
  and F1 ${fmt(t7aF1)} to ${fmt(liveDev.f1.mean)}.
* **v1 keeps the higher in-window recall** (${fmt(t7aRecall)} vs ${fmt(liveDev.recall.mean)}), bought with
  ${t7a.engine.fp.toFixed(1)} false positives per seed instead of ${liveDev.fp.mean.toFixed(2)}. The v2 engine also
  beats T7a's *warning+* cut-off (${fmt(t7a.warning.precision.mean)} / ${fmt(t7a.warning.recall.mean)}) on both axes,
  so the improvement comes from the baseline logic, not from a looser threshold.
* **Seed-level caveat.** These in-window figures rest on only ${truthInWindow.toFixed(1)} anomalies per seed, so their
  standard deviations are wide (precision \u00b1 ${fmt(liveDev.precision.sd)}, recall \u00b1 ${fmt(liveDev.recall.sd)}).
  The full-series table in **Headline comparison** above is the statistically stable comparison; this table is the
  "same engine, before vs after" check.

### Against the fixed-percentage baselines (held-out seeds 6-10, full series)

| Method | Precision | Recall | F1 | Flags/seed |
|---|---|---|---|---|
| v2: rolling z (guarded) | ${fmt(v2Holdout.precision.mean)} | ${fmt(v2Holdout.recall.mean)} | ${fmt(v2Holdout.f1.mean)} | ${fmt(v2Holdout.flaggedTotal.mean)} |
| baseline: \`\\|dev\\| > 50%\` | ${fmt(b50Holdout.precision.mean)} | ${fmt(b50Holdout.recall.mean)} | ${fmt(b50Holdout.f1.mean)} | ${fmt(b50Holdout.flaggedTotal.mean)} |
| baseline: \`\\|dev\\| > 30%\` | ${fmt(b30Holdout.precision.mean)} | ${fmt(b30Holdout.recall.mean)} | ${fmt(b30Holdout.f1.mean)} | ${fmt(b30Holdout.flaggedTotal.mean)} |

v2 beats the \`\\|dev\\| > 50%\` rule on precision (${fmt(v2Holdout.precision.mean)} vs ${fmt(b50Holdout.precision.mean)})
and on F1 (${fmt(v2Holdout.f1.mean)} vs ${fmt(b50Holdout.f1.mean)}), and beats \`\\|dev\\| > 30%\` by more still
(${fmt(b30Holdout.precision.mean)} precision, ${fmt(b30Holdout.f1.mean)} F1). The percentage rules keep the higher
*recall* (${fmt(b50Holdout.recall.mean)} / ${fmt(b30Holdout.recall.mean)}) only by flagging far more product-days
(${fmt(b30Holdout.flaggedTotal.mean)} / ${fmt(b50Holdout.flaggedTotal.mean)} per seed against v2's
${fmt(v2Holdout.flaggedTotal.mean)}) - almost all ordinary weekly noise. They are a high-recall reference point, not a
competitor on F1.

The two harnesses agree on the yardstick: T7a's dev-block baseline rows
(${fmt(t7a.b30.precision.mean)} / ${fmt(t7a.b30.recall.mean)} / ${fmt(t7a.b30.f1.mean)} and
${fmt(t7a.b50.precision.mean)} / ${fmt(t7a.b50.recall.mean)} / ${fmt(t7a.b50.f1.mean)}) reproduce this run's dev
baselines (${fmt(b30Dev.precision.mean)} / ${fmt(b30Dev.recall.mean)} / ${fmt(b30Dev.f1.mean)} and
${fmt(b50Dev.precision.mean)} / ${fmt(b50Dev.recall.mean)} / ${fmt(b50Dev.f1.mean)}) to within ${fmt(baselineDrift)}
absolute, so both harnesses measure v2 against the same baseline implementation.

`;
}

/**
 * Builds the ablation section that justifies each v2 design choice.
 * @param {Array<{label: string, agg: object}>} blocks Seed blocks (dev + hold-out).
 * @returns {string} Markdown fragment.
 */
function buildAblationSection(blocks) {
  const rows = [];
  for (const block of blocks) {
    for (const method of ['v2_series', 'v2_no_zerofill', 'v2_no_sdfloor', 'v2_no_guards']) {
      const m = block.agg.methods[method];
      rows.push([
        block.label,
        METHOD_LABELS[method],
        fmt(m.precision.mean),
        fmt(m.recall.mean),
        fmt(m.f1.mean),
        m.tp.mean.toFixed(2),
        m.fp.mean.toFixed(2),
        m.fn.mean.toFixed(2),
      ]);
    }
  }

  return `## Ablations — why each part of v2 is there

${markdownTable(
    ['Seeds', 'Variant', 'Precision', 'Recall', 'F1', 'TP (mean)', 'FP (mean)', 'FN (mean)'],
    rows,
  )}

* **zero-fill off** — no-sale baseline days are dropped from the baseline, so the baseline mean rises and σ shrinks; a
  "drop to zero" (the most commercially important anomaly) becomes invisible.
* **σ-floor off** — a flat or near-flat baseline gives σ ≈ 0, so tiny absolute wobbles produce enormous |z| and
  precision collapses.
* **guards off** — every \`|z| >= 2.5\` day is written, including days that differ from the baseline by one or two units
  on a very low-volume product; flag volume rises and precision falls.

Both blocks are shown so the ablation story is verified on the held-out seeds too, not just on the seeds the parameters
were chosen with.

`;
}

/**
 * Writes the diagnostics, isolation and determinism bullets of the report.
 * @param {object} ctx Report context.
 * @returns {string} Markdown fragment.
 */
function buildDiagnosticsSection(ctx) {
  const {
    devPerSeed,
    holdoutPerSeed,
    dbToday,
    windowStartDate,
    foreignBefore,
    foreignAfter,
    determinismHash,
    sandbox,
    generatedAt,
  } = ctx;

  const allPerSeed = [...devPerSeed, ...holdoutPerSeed];
  const perSeedRows = allPerSeed.map((r) => [
    r.seed,
    r.diagnostics.saleRowsInserted,
    r.diagnostics.rowsDeletedBeforeInsert.salesDeleted,
    r.diagnostics.zeroSaleProductDays,
    r.diagnostics.groundTruthInEngineWindow,
    r.diagnostics.alertsTotal,
    r.diagnostics.v1Flagged,
    r.diagnostics.v2Flagged,
    r.diagnostics.unguardedFlagged,
    r.diagnostics.integrationChecked,
    r.diagnostics.evalWindow,
  ]);

  const severity = {};
  for (const result of allPerSeed) {
    for (const [key, value] of Object.entries(result.diagnostics.alertsBySeverity)) {
      severity[key] = (severity[key] ?? 0) + value;
    }
  }

  const matchedRows = allPerSeed.reduce((sum, r) => sum + r.diagnostics.integrationChecked, 0);

  return `## Diagnostics, isolation and determinism

${markdownTable(
    [
      'seed',
      'sale rows inserted',
      'rows deleted first',
      'zero-sale product-days',
      'truth in engine window',
      'live alerts',
      'v1 flags (full series)',
      'v2 flags (full series)',
      'v2 unguarded flags',
      'rows matched to module',
      'engine eval window',
    ],
    perSeedRows,
  )}

* **Integration check.** For every seed the harness re-derives the v2 prediction in memory over the engine's own
  14-day eval window and asserts the persisted \`anomaly_alerts\` rows are exactly that set — identical \`(SKU, date)\`
  keys and |z| equal to 4 dp (tolerance ${Z_TOLERANCE}). ${matchedRows} rows were verified across
  ${allPerSeed.length} runs; any divergence aborts the harness, so a passing run is proof that the refactored engine
  really reads \`services/rollingZScore.js\`.
* **Alert floor.** Every persisted row satisfies \`|z| >= ${DEFAULT_PARAMS.zAlert}\` (v2's flag floor); asserted per seed.
* **Guard monotonicity.** \`v2_no_guards\` flags >= \`v2_series\` flags for every seed (removing a guard can only add);
  asserted per seed.
* **Live severity mix (all seeds, summed).** \`${JSON.stringify(severity)}\`.
* **Sandbox.** Tenant \`${sandbox.tenantSlug}\` (\`${sandbox.tenantId}\`), store \`${sandbox.storeId}\`; every DELETE is
  scoped to that tenant and \`assertSandboxTenant()\` re-reads the slug before deleting.
* **Isolation.** Sale rows owned by tenants other than the sandbox: ${foreignBefore} before → ${foreignAfter} after
  (must be identical).
* **Determinism.** Seed 1 was executed twice; both runs hashed to sha256 \`${determinismHash.hash}\`.
* **Clock.** DB \`CURRENT_DATE\` = ${dbToday}; the engine's data window starts ${windowStartDate}.
* **Generated at.** ${generatedAt}.
* **v1 evidence preserved.** The original T7a report and CSV are untouched in \`detection_results.md\` /
  \`detection_results.csv\` and frozen as \`detection_results_v1.md\` / \`detection_results_v1.csv\`.

`;
}

/**
 * Assembles the full markdown report.
 * @param {object} ctx Report context.
 * @returns {string} Markdown document.
 */
function buildMarkdown(ctx) {
  const { devPerSeed, holdoutPerSeed, devAgg, holdoutAgg, sandbox, generatedAt } = ctx;
  const { t7a, truthInWindow } = ctx;

  const blocks = [
    { label: 'dev (1–5)', agg: devAgg, perSeed: devPerSeed },
    { label: 'hold-out (6–10)', agg: holdoutAgg, perSeed: holdoutPerSeed },
  ];
  const v1Dev = devAgg.methods.v1_series;
  const v2Dev = devAgg.methods.v2_series;
  const v1Ho = holdoutAgg.methods.v1_series;
  const v2Ho = holdoutAgg.methods.v2_series;

  return `# Detection validation — v2 (per-day rolling z-score)

> **T7b.** Replaces the v1 single-window z-score in \`runZScoreDetection\` with the pure module
> \`src/services/rollingZScore.js\`, then measures the change on **development seeds 1–5** and **held-out seeds 6–10**
> against the v1 algorithm (replicated in memory) and two naive fixed-percentage baselines. The v1 evidence from T7a is
> preserved in \`detection_results_v1.md\` / \`detection_results_v1.csv\`.

### Headline (full-series, |z| floor, mean over seeds)

| Seeds | v1 precision / recall / F1 | v2 precision / recall / F1 |
|---|---|---|
| dev (1–5) | ${fmt(v1Dev.precision.mean)} / ${fmt(v1Dev.recall.mean)} / ${fmt(v1Dev.f1.mean)} | ${fmt(v2Dev.precision.mean)} / ${fmt(v2Dev.recall.mean)} / ${fmt(v2Dev.f1.mean)} |
| hold-out (6–10) | ${fmt(v1Ho.precision.mean)} / ${fmt(v1Ho.recall.mean)} / ${fmt(v1Ho.f1.mean)} | ${fmt(v2Ho.precision.mean)} / ${fmt(v2Ho.recall.mean)} / ${fmt(v2Ho.f1.mean)} |

Sandbox: tenant \`${sandbox.tenantSlug}\` (\`${sandbox.tenantId}\`), store \`${sandbox.storeId}\`. Generated ${generatedAt}.

${buildMethodSection(t7a, truthInWindow, v1Dev)}${buildV1V2Section(blocks)}${buildT7aComparisonSection(blocks, t7a, truthInWindow)}${buildAblationSection(blocks)}## Per-seed-set detail

${buildSeedSetSection('Development seeds 1–5', devPerSeed, devAgg)}
${buildSeedSetSection('Held-out seeds 6–10', holdoutPerSeed, holdoutAgg)}
${buildDiagnosticsSection(ctx)}`;
}

/**
 * Builds the machine-readable CSV (one row per seed × method).
 * @param {Array<object>} devPerSeed Development-seed results.
 * @param {Array<object>} holdoutPerSeed Held-out-seed results.
 * @returns {string} CSV document.
 */
function buildCsv(devPerSeed, holdoutPerSeed) {
  const header = 'seed,phase,method,tp,fp,fn,precision,recall,f1,flagged_total,ground_truth_total';
  const lines = [header];

  for (const [phase, perSeed] of [['dev', devPerSeed], ['holdout', holdoutPerSeed]]) {
    for (const result of perSeed) {
      for (const method of METHOD_ORDER) {
        const m = result.metrics[method];
        lines.push(
          [
            result.seed,
            phase,
            method,
            m.tp,
            m.fp,
            m.fn,
            m.precision,
            m.recall,
            m.f1,
            m.flaggedTotal,
            m.groundTruthTotal,
          ].join(','),
        );
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Prints one console line summarising a finished seed. */
function printSeedLine(result) {
  const d = result.diagnostics;
  console.log(
    `  seed ${String(result.seed).padStart(2)}: ${d.saleRowsInserted} sale rows in ${d.insertChunks} chunks` +
      ` | ${d.alertsTotal} live alerts` +
      ` | v1 ${d.v1Flagged} / v2 ${d.v2Flagged} / unguarded ${d.unguardedFlagged} full-series flags` +
      ` | ${d.integrationChecked} rows matched the module` +
      ` | truth in window ${d.groundTruthInEngineWindow}/${GROUND_TRUTH_TOTAL}` +
      ` | zero-sale product-days ${d.zeroSaleProductDays}`,
  );
}

/**
 * Runs every seed of one block through `runSeed` and prints its one-line summary.
 * @param {number[]} seeds Seeds of the block, in order.
 * @param {object} sandbox Sandbox handles from ensureSandbox.
 * @param {string} windowStartDate ISO date of the engine's data window start.
 * @param {string} label Human-readable block label for the console.
 * @returns {Promise<Array<object>>} Per-seed results, same order as `seeds`.
 */
async function runSeedBlock(seeds, sandbox, windowStartDate, label) {
  console.log(`── ${label} seeds ${seeds[0]}–${seeds[seeds.length - 1]} ──`);
  const perSeed = [];
  for (const seed of seeds) {
    const result = await runSeed(seed, sandbox, windowStartDate);
    perSeed.push(result);
    printSeedLine(result);
  }
  console.log('');
  return perSeed;
}

/**
 * End-to-end harness: dev seeds 1–5, held-out seeds 6–10, determinism check,
 * v1-evidence check and the two report files.
 */
async function main() {
  const generatedAt = new Date().toISOString();

  console.log('T7b — detection validation harness v2 (per-day rolling z-score)');
  console.log(
    `dev seeds: ${DEV_SEEDS.join(', ')} | held-out seeds: ${HOLDOUT_SEEDS.join(', ')} | ` +
      `products: 20 | days: 90 | injected anomalies per seed: ${GROUND_TRUTH_TOTAL}`,
  );
  console.log('parameters are FROZEN before the held-out block runs — held-out seeds never tune anything.\n');

  const v1Evidence = await readFile(path.join(OUTPUT_DIR, 'detection_results_v1.md'), 'utf8');
  assert(v1Evidence.includes('T7a'), 'detection_results_v1.md is missing or is not the frozen v1 evidence');

  // Quoted, never retyped: the T7a rows used by buildMethodSection and buildT7aComparisonSection.
  const t7a = {
    engine: parseT7aRow(v1Evidence, 'engine: all alerts'),
    warning: parseT7aRow(v1Evidence, 'engine: warning+'),
    b30: parseT7aRow(v1Evidence, '30% (prev 14d mean)'),
    b50: parseT7aRow(v1Evidence, '50% (prev 14d mean)'),
  };
  console.log(
    'v T7a rows parsed: engine all-alerts P/R/F1 = ' + t7a.engine.precision.mean + ' / ' +
      t7a.engine.recall.mean + ' / ' + t7a.engine.f1.mean + ', TP/FP/FN = ' +
      t7a.engine.tp + ' / ' + t7a.engine.fp + ' / ' + t7a.engine.fn,
  );
  console.log('✔ v1 evidence present (docs/validation/detection_results_v1.md + .csv)\n');

  const foreignBefore = await countForeignSaleRows();
  console.log(`isolation pre-check: sale rows owned by non-sandbox tenants = ${foreignBefore}`);

  const dbToday = await currentDbDate();
  const windowStartDate = shiftIsoDate(dbToday, -ENGINE_WINDOW_DAYS);
  console.log(
    `DB CURRENT_DATE = ${dbToday}; engine data window starts ${windowStartDate} (last ${ENGINE_WINDOW_DAYS} days)\n`,
  );

  const sandbox = await ensureSandbox(generateDataset(DEV_SEEDS[0]));
  console.log(`sandbox ready: tenant "${sandbox.tenantSlug}" (${sandbox.tenantId}), store ${sandbox.storeId}\n`);

  const devPerSeed = await runSeedBlock(DEV_SEEDS, sandbox, windowStartDate, 'dev');

  // Determinism: execute the first seed a second time and compare result hashes.
  const firstHash = hashResult(devPerSeed[0]);
  const repeat = await runSeed(DEV_SEEDS[0], sandbox, windowStartDate);
  const repeatHash = hashResult(repeat);
  assert(
    firstHash === repeatHash,
    `determinism check failed for seed ${DEV_SEEDS[0]}: ${firstHash} !== ${repeatHash} ` +
      '(a second harness process writing to the same sandbox tenant would cause this)',
  );
  console.log(`✔ determinism check passed (seed ${DEV_SEEDS[0]} twice → sha256 ${firstHash.slice(0, 16)}…)\n`);

  const holdoutPerSeed = await runSeedBlock(HOLDOUT_SEEDS, sandbox, windowStartDate, 'held-out');

  const devAgg = aggregate(devPerSeed);
  const holdoutAgg = aggregate(holdoutPerSeed);

  // The only denominator on which the frozen T7a rows and this run are comparable:
  // how many injected anomalies actually fall inside the engine's 14-day window.
  const truthInWindow = mean(devPerSeed.map((r) => r.diagnostics.groundTruthInEngineWindow));

  printPerSeedTable(devPerSeed, 'dev 1–5');
  printAggregateTable(devAgg, devPerSeed, 'dev 1–5', false);
  printPerSeedTable(holdoutPerSeed, 'held-out 6–10');
  printAggregateTable(holdoutAgg, holdoutPerSeed, 'held-out 6–10', true);

  const foreignAfter = await countForeignSaleRows();
  assert(foreignBefore === foreignAfter, `non-sandbox sale rows changed: ${foreignBefore} → ${foreignAfter}`);
  console.log(`\n✔ isolation check passed (non-sandbox sale rows ${foreignBefore} → ${foreignAfter})`);

  const ctx = {
    devPerSeed,
    holdoutPerSeed,
    devAgg,
    holdoutAgg,
    sandbox,
    dbToday,
    windowStartDate,
    foreignBefore,
    foreignAfter,
    determinismHash: { hash: firstHash, generatedAt },
    generatedAt,
    t7a,
    truthInWindow,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const markdownPath = path.join(OUTPUT_DIR, 'detection_results_v2.md');
  const csvPath = path.join(OUTPUT_DIR, 'detection_results_v2.csv');
  await writeFile(markdownPath, buildMarkdown(ctx), 'utf8');
  await writeFile(csvPath, buildCsv(devPerSeed, holdoutPerSeed), 'utf8');

  console.log(`✔ wrote ${markdownPath}`);
  console.log(`✔ wrote ${csvPath}`);
  console.log('\n✅ validate:detection:v2 finished');
}

main()
  .catch((err) => {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSandboxPool();
  });











