/**
 * backend/scripts/validation/runDetectionValidation.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T7a — detection validation harness.
 *
 * Validates the rule-based rolling z-score engine
 * (src/services/detectionEngine.js → runZScoreDetection) against synthetic data
 * with KNOWN injected anomalies, and compares it with a naive fixed-percentage
 * baseline.
 *
 * Pipeline per seed:
 *   1. generate a reproducible dataset (20 products × 90 days, 36 injected
 *      anomalies) — generateSyntheticData.js
 *   2. load it into an isolated sandbox tenant ('validation-sandbox') — sandboxDb.js
 *   3. call the REAL runZScoreDetection(tenantId, storeId)
 *   4. read the resulting anomaly_alerts rows and score them at three severity
 *      cut-offs: all alerts (|z| > 1.5), warning and above (>= 2.0), critical (>= 2.5)
 *   5. score the two naive baselines (|deviation| > 30% / 50% vs the previous
 *      14-day mean) on the same in-memory series
 *   6. aggregate mean ± sd across seeds and write
 *      docs/validation/detection_results.md + .csv
 *
 * Run from backend/:  npm run validate:detection
 * Exits 1 on any failed assertion.
 *
 * Run ONE instance at a time: all runs share the single sandbox tenant, so two
 * harness processes running concurrently will delete/insert each other's data
 * and the determinism assertion will fail.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { runZScoreDetection } from '../../src/services/detectionEngine.js';

const SEEDS = [1, 2, 3, 4, 5];
const UNIT_PRICE = 100;
const COST_PRICE = 60;
const ENGINE_WINDOW_DAYS = 14; // must match ROLLING_WINDOW_DAYS in detectionEngine.js

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.resolve(SCRIPT_DIR, '../../../docs/validation');

const ENGINE_METHODS = ['engine_all', 'engine_warning_plus', 'engine_critical'];
const BASELINE_METHODS = ['baseline_0.30', 'baseline_0.50'];
const METHOD_ORDER = [...ENGINE_METHODS, ...BASELINE_METHODS];

const METHOD_LABELS = {
  engine_all: 'engine: all alerts (|z| > 1.5)',
  engine_warning_plus: 'engine: warning+ (|z| >= 2.0)',
  engine_critical: 'engine: critical (|z| >= 2.5)',
  'baseline_0.30': 'baseline: |dev| > 30% (prev 14d mean)',
  'baseline_0.50': 'baseline: |dev| > 50% (prev 14d mean)',
};
const LABEL_WIDTH = 34;

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
 * Applies a severity cut-off to the engine's alerts.
 * @param {Array<{severity: string}>} alerts All sales_spike/sales_drop alerts.
 * @param {string} method One of ENGINE_METHODS.
 * @returns {Array} Filtered alerts.
 */
function selectCutoff(alerts, method) {
  if (method === 'engine_all') return alerts;
  if (method === 'engine_warning_plus') {
    return alerts.filter((a) => a.severity === 'warning' || a.severity === 'critical');
  }
  return alerts.filter((a) => a.severity === 'critical');
}

/**
 * Converts a dataset series into sale_transactions rows.
 * Zero-unit product-days are skipped: quantity_sold has CHECK (> 0), so those
 * days simply cannot exist in the database (they are counted and reported).
 * @param {object} dataset Dataset from generateDataset.
 * @param {Map<string, string>} productIds sku → product UUID.
 * @returns {Array<{productId: string, saleDate: string, units: number, unitPrice: number, costPrice: number}>}
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

/**
 * Runs one seed end to end: generate → load → detect → evaluate.
 * @param {number} seed Seed for the dataset.
 * @param {object} sandbox Sandbox handles from ensureSandbox.
 * @param {string} windowStartDate ISO date of the engine's data window start (CURRENT_DATE - 14).
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
    alerts.length <= insertInfo.inserted,
    `seed ${seed}: engine produced ${alerts.length} alerts from ${insertInfo.inserted} sale rows`,
  );

  const truth = dataset.groundTruth;
  const metrics = {};

  for (const method of ENGINE_METHODS) {
    const flagged = selectCutoff(alerts, method);
    const counts = confusionCounts(flagged, truth);
    metrics[method] = { ...classificationMetrics(counts), ...counts };
  }

  const baselineFlags = evaluateBaselines(dataset.series);
  for (const method of BASELINE_METHODS) {
    const counts = confusionCounts(baselineFlags[method], truth);
    metrics[method] = { ...classificationMetrics(counts), ...counts };
  }
  for (const method of METHOD_ORDER) {
    metrics[method].precision = round(metrics[method].precision);
    metrics[method].recall = round(metrics[method].recall);
    metrics[method].f1 = round(metrics[method].f1);
  }

  const zeroSaleProductDays = countZeroSaleProductDays(dataset);
  const inWindow = truth.filter((gt) => gt.date >= windowStartDate).length;
  const severityCounts = alerts.reduce((acc, a) => {
    acc[a.severity] = (acc[a.severity] ?? 0) + 1;
    return acc;
  }, {});

  return {
    seed,
    metrics,
    engineRecallByType: recallByDimension(
      selectCutoff(alerts, 'engine_all'),
      truth,
      'type',
    ).map((b) => ({ value: b.value, total: b.total, detected: b.detected, recall: round(b.recall) })),
    engineRecallByMultiplier: recallByDimension(
      selectCutoff(alerts, 'engine_all'),
      truth,
      'multiplier',
    ).map((b) => ({ value: b.value, total: b.total, detected: b.detected, recall: round(b.recall) })),
    diagnostics: {
      saleRowsInserted: insertInfo.inserted,
      insertChunks: insertInfo.chunks,
      rowsDeletedBeforeInsert: resetInfo,
      zeroSaleProductDays,
      productDaysScored: dataset.productCount * dataset.dayCount - zeroSaleProductDays,
      groundTruthTotal: truth.length,
      groundTruthInEngineWindow: inWindow,
      engineWindowDays: ENGINE_WINDOW_DAYS,
      engineSummary,
      alertsTotal: alerts.length,
      alertsBySeverity: severityCounts,
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
    };
  }

  const byType = aggregateBuckets(perSeed, 'engineRecallByType');
  const byMultiplier = aggregateBuckets(perSeed, 'engineRecallByMultiplier').sort(
    (a, b) => Number(a.value) - Number(b.value),
  );

  return { methods, byType, byMultiplier };
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
 * @returns {Array<{value: string|number, meanRecall: number, sdRecall: number, total: number, detected: number}>}
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

/**
 * Writes the "Method" section of the markdown report.
 * @returns {string} Markdown fragment.
 */
function buildMethodSection() {
  return `## Method

**Data generation.** For each of 20 generic products (\`Test Product 01\`..\`Test Product 20\`, SKUs
\`VAL-001\`..\`VAL-020\`) the generator draws a baseline daily mean uniformly from [6, 40] units/day and produces 90
daily values ending the day before the run:
\`units = round(dailyMean × weekendMultiplier + N(0, 1.2·√dailyMean))\`, \`weekendMultiplier = 1.2\` on
Saturday/Sunday, rounded and clamped to >= 0. A day whose value rounds to 0 produces no \`sale_transactions\` row
(\`quantity_sold\` has \`CHECK (> 0)\`) and is therefore absent from the \`product_daily_velocity\` view; the harness
counts and reports those days instead of masking them. All randomness comes from one seeded mulberry32 stream, so a
given seed reproduces byte-identical data.

**Ground truth.** 36 anomalies are injected per dataset — 18 spikes (multipliers 1.5, 2.0, 3.0; six each) and 18 drops
(multipliers 0.6, 0.4, 0.2; six each). Injection is restricted to days 21..90, at least 12 days apart within the same
product and never twice on the same product-day. Each ground-truth entry is
\`{productSku, dayIndex, date, type, multiplier}\`.

**Matching rule.** A flagged product-day counts as a true positive only when it matches a ground-truth anomaly on the
exact same \`(SKU, date)\` pair — no tolerance window, no date fuzziness, no per-product aggregation.
Precision = TP/(TP+FP), Recall = TP/(TP+FN), F1 = 2PR/(P+R); a zero denominator yields 0 (never NaN).

**Methods compared.** \`runZScoreDetection\` is called for real against the sandbox and its persisted
\`anomaly_alerts\` rows are scored at three severity cut-offs; then two naive fixed-percentage baselines are evaluated
on the same in-memory series — flag a day when \`|units − mean(previous 14 days)| / mean(previous 14 days) > T\` for
T = 0.30 and T = 0.50, skipping the first 14 days and any day whose 14-day mean is 0.

**Seeds.** 1, 2, 3, 4, 5 — five independent datasets. Reported figures are mean ± population standard deviation
(σ, divide by N) over those seeds. The engine writes severity with strict inequalities (\`|z| > 2.5\` critical,
\`|z| > 2.0\` warning, else info), so "warning+" means \`severity IN ('warning','critical')\`.

`;
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

/** Prints the per-seed confusion counts and metrics. */
function printPerSeedTable(perSeed) {
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

  console.log(`\n── per-seed results ${'─'.repeat(Math.max(0, header.length - 20))}`);
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
function printAggregateTable(agg, perSeed) {
  const header = [
    'method'.padEnd(LABEL_WIDTH),
    'precision'.padStart(19),
    'recall'.padStart(19),
    'F1'.padStart(19),
  ].join(' | ');

  console.log(`\n── aggregate over seeds (mean ± population sd) ${'─'.repeat(20)}`);
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

  const meanZeroSales = mean(perSeed.map((r) => r.diagnostics.zeroSaleProductDays));

  console.log('\n── engine recall at the all-alerts cut-off, by anomaly type ──');
  for (const bucket of agg.byType) {
    console.log(
      `   ${String(bucket.value).padEnd(6)} recall ${fmt(bucket.meanRecall)} ± ${fmt(
        bucket.sdRecall,
      )}  (detected ${bucket.detected}/${bucket.total} anomaly-days pooled over seeds)`,
    );
  }

  console.log('\n── engine recall at the all-alerts cut-off, by injected multiplier ──');
  for (const bucket of agg.byMultiplier) {
    console.log(
      `   ×${String(bucket.value).padEnd(5)} recall ${fmt(bucket.meanRecall)} ± ${fmt(
        bucket.sdRecall,
      )}  (detected ${bucket.detected}/${bucket.total} anomaly-days pooled over seeds)`,
    );
  }

  const inWindow = mean(perSeed.map((r) => r.diagnostics.groundTruthInEngineWindow));
  console.log(
    `\n── NOTE: ${fmt(meanZeroSales)} product-days per seed had zero sales (mean over seeds). ` +
      'Those days produce no sale_transactions row and are therefore MISSING from the ' +
      'product_daily_velocity view — the engine cannot see them (not fixed by this harness).',
  );
  console.log(
    `── NOTE: the engine only reads sale_date >= CURRENT_DATE - ${ENGINE_WINDOW_DAYS} days, so only ` +
      `${fmt(inWindow)} of ${GROUND_TRUTH_TOTAL} injected anomalies per seed are inside its data window.`,
  );
}

/**
 * Writes the diagnostics bullets of the markdown report.
 * @param {object} ctx Report context.
 * @returns {string} Markdown fragment.
 */
function buildDiagnosticsSection(ctx) {
  const { perSeed, dbToday, windowStartDate, foreignBefore, foreignAfter, determinismHash } = ctx;

  const zeroSales = perSeed.map((r) => r.diagnostics.zeroSaleProductDays);
  const inWindow = perSeed.map((r) => r.diagnostics.groundTruthInEngineWindow);
  const alerts = perSeed.map((r) => r.diagnostics.alertsTotal);
  const rows = perSeed.map((r) => r.diagnostics.saleRowsInserted);

  return `## Diagnostics

- Sale rows inserted per seed: ${rows.join(', ')} (mean ${fmt(mean(rows))}, in chunks of 500).
- Product-days with zero sales per seed: ${zeroSales.join(', ')} (mean ${fmt(mean(zeroSales))}). Each of those
  product-days has no \`sale_transactions\` row and is missing from \`product_daily_velocity\` — it is invisible to the
  engine. Reported, not fixed.
- Injected anomalies inside the engine's data window per seed: ${inWindow.join(', ')} of ${GROUND_TRUTH_TOTAL}
  (window is \`sale_date >= CURRENT_DATE - ${ENGINE_WINDOW_DAYS}\`; DB \`CURRENT_DATE\` = ${dbToday}, so the window
  starts ${windowStartDate}).
- \`sales_spike\` + \`sales_drop\` alerts persisted per seed: ${alerts.join(', ')}.
- Determinism check: seed ${perSeed[0].seed} was executed twice in-process and both result hashes are
  \`${determinismHash.hash}\` (sha256 over metrics + type/multiplier breakdowns; run-state counters are excluded
  because they legitimately differ between the first run of a seed and a repeat).
- Isolation check: sale rows owned by tenants other than the sandbox = ${foreignBefore} before the run and
  ${foreignAfter} after the run — unchanged.
- Engine \`runZScoreDetection\` summary (seed ${perSeed[0].seed}):
  \`${JSON.stringify(perSeed[0].diagnostics.engineSummary)}\`.

`;
}

/**
 * Writes the observations/limitations section of the markdown report.
 * @param {object} ctx Report context.
 * @returns {string} Markdown fragment.
 */
function buildLimitationsSection(ctx) {
  const { perSeed } = ctx;
  const inWindow = perSeed[0].diagnostics.groundTruthInEngineWindow;

  return `## Observations — where the engine's real behaviour differed from the intended design

1. **Not a rolling window per day.** \`runZScoreDetection\` selects only
   \`sale_date >= CURRENT_DATE - ROLLING_WINDOW_DAYS\` (14 days) from \`product_daily_velocity\`, computes a **single**
   mean μ and population σ over that whole window, then tests every day of that same window against those numbers.
   In seed 1 only ${inWindow} of the ${GROUND_TRUTH_TOTAL} injected anomalies fall inside that window (per-seed counts
   are listed in Diagnostics), so recall is
   structurally capped and the engine columns describe *recent-window* behaviour, not *historical* detection.
2. **The tested day is inside its own baseline.** Because the anomaly contributes to μ and σ that it is compared
   against, a large spike inflates σ and shrinks its own |z|. The naive baselines look strictly backwards and do not
   have this self-masking effect.
3. **Zero-sales days are invisible.** \`quantity_sold\` must be > 0, so a day with no sales has no row and no velocity
   entry; a "drop to zero" cannot be detected at all by this engine.
4. **Alert identity and lag.** \`alert_date\` equals the sale date of the day tested (no detection delay), and
   \`uq_anomaly_per_product_per_day\` allows at most one row per \`(tenant, store, product, alert_type, date)\`.
5. **Severity boundaries are strict.** \`zToSeverity\` uses \`>\`, so a z-score of exactly 2.0 or 2.5 lands in the
   lower bucket (\`info\` / \`warning\` respectively). The three cut-offs above are read from the persisted
   \`severity\` column, not recomputed from \`z_score\`.
6. **Comparator caveat.** The baselines are scored over the full 90-day series (all 36 anomalies) while the engine can
   only reach the last 14 days, so the baseline rows are a reference point rather than a like-for-like competitor.
`;
}

/**
 * Assembles the full markdown report.
 * @param {object} ctx Report context (aggregates, per-seed results, diagnostics).
 * @returns {string} Markdown document.
 */
function buildMarkdown(ctx) {
  const { agg, perSeed, sandbox, determinismHash } = ctx;

  const aggregateTable = markdownTable(
    ['Method', 'Precision (mean ± sd)', 'Recall (mean ± sd)', 'F1 (mean ± sd)', 'TP / FP / FN (mean)'],
    METHOD_ORDER.map((method) => [
      METHOD_LABELS[method],
      fmtPair(agg.methods[method].precision),
      fmtPair(agg.methods[method].recall),
      fmtPair(agg.methods[method].f1),
      `${fmt(agg.methods[method].tp.mean)} / ${fmt(agg.methods[method].fp.mean)} / ${fmt(
        agg.methods[method].fn.mean,
      )}`,
    ]),
  );

  const perSeedTable = markdownTable(
    ['Seed', ...METHOD_ORDER.map((m) => METHOD_LABELS[m])],
    perSeed.map((result) => [
      result.seed,
      ...METHOD_ORDER.map(
        (m) =>
          `${fmt(result.metrics[m].precision)} / ${fmt(result.metrics[m].recall)} / ${fmt(result.metrics[m].f1)}`,
      ),
    ]),
  );

  const typeTable = markdownTable(
    ['Anomaly type', 'Ground-truth days (pooled)', 'Detected (pooled)', 'Mean recall ± sd'],
    agg.byType.map((b) => [b.value, b.total, b.detected, `${fmt(b.meanRecall)} ± ${fmt(b.sdRecall)}`]),
  );

  const multiplierTable = markdownTable(
    ['Injected multiplier', 'Ground-truth days (pooled)', 'Detected (pooled)', 'Mean recall ± sd'],
    agg.byMultiplier.map((b) => [
      `×${b.value}`,
      b.total,
      b.detected,
      `${fmt(b.meanRecall)} ± ${fmt(b.sdRecall)}`,
    ]),
  );

  return `# Detection validation results (T7a) — rule-based z-score engine vs naive baselines

Generated: ${determinismHash.generatedAt}
Harness: \`backend/scripts/validation/runDetectionValidation.js\` — run with \`npm run validate:detection\` from \`backend/\`.
Sandbox tenant: \`${sandbox.tenantSlug}\` (\`${sandbox.tenantId}\`) — isolated; no other tenant is read, written or deleted.

${buildMethodSection()}## Aggregate metrics (mean ± population sd over seeds 1–5)

${aggregateTable}

## Per-seed metrics (precision / recall / F1)

${perSeedTable}

## Engine recall at the all-alerts cut-off, by anomaly type

${typeTable}

## Engine recall at the all-alerts cut-off, by injected multiplier

${multiplierTable}

${buildDiagnosticsSection(ctx)}${buildLimitationsSection(ctx)}`;
}

/**
 * Builds the CSV export (one row per seed × method, then mean and sd rows).
 * @param {Array<object>} perSeed Per-seed results.
 * @param {{methods: Object}} agg Aggregated metrics.
 * @returns {string} CSV text with header `seed,method,precision,recall,f1`.
 */
function buildCsv(perSeed, agg) {
  const rows = [['seed', 'method', 'precision', 'recall', 'f1']];

  for (const result of perSeed) {
    for (const method of METHOD_ORDER) {
      const m = result.metrics[method];
      rows.push([result.seed, method, m.precision, m.recall, m.f1]);
    }
  }

  for (const statistic of ['mean', 'sd']) {
    for (const method of METHOD_ORDER) {
      const m = agg.methods[method];
      rows.push([statistic, method, m.precision[statistic], m.recall[statistic], m.f1[statistic]]);
    }
  }

  return `${rows.map((row) => row.join(',')).join('\n')}\n`;
}

/** End-to-end harness: seeds 1–5, determinism check, reports. */
async function main() {
  const generatedAt = new Date().toISOString();

  console.log('T7a — detection validation harness (rule-based z-score engine vs naive baselines)');
  console.log(
    `seeds: ${SEEDS.join(', ')} | products: 20 | days: 90 | injected anomalies per seed: ${GROUND_TRUTH_TOTAL}`,
  );

  const foreignBefore = await countForeignSaleRows();
  console.log(`isolation pre-check: sale rows owned by non-sandbox tenants = ${foreignBefore}`);

  const dbToday = await currentDbDate();
  const windowStartDate = shiftIsoDate(dbToday, -ENGINE_WINDOW_DAYS);
  console.log(
    `DB CURRENT_DATE = ${dbToday}; engine data window starts ${windowStartDate} (last ${ENGINE_WINDOW_DAYS} days)`,
  );

  const sandbox = await ensureSandbox(generateDataset(SEEDS[0]));
  console.log(`sandbox ready: tenant "${sandbox.tenantSlug}" (${sandbox.tenantId}), store ${sandbox.storeId}\n`);

  const perSeed = [];
  for (const seed of SEEDS) {
    const result = await runSeed(seed, sandbox, windowStartDate);
    perSeed.push(result);
    console.log(
      `  seed ${seed}: ${result.diagnostics.saleRowsInserted} sale rows in ${
        result.diagnostics.insertChunks
      } chunks | ${result.diagnostics.alertsTotal} sales_spike/drop alerts | zero-sale product-days ${
        result.diagnostics.zeroSaleProductDays
      } | ground truth inside engine window ${
        result.diagnostics.groundTruthInEngineWindow
      }/${GROUND_TRUTH_TOTAL}`,
    );
  }

  // Determinism: execute the first seed a second time and compare result hashes.
  const firstHash = hashResult(perSeed[0]);
  const repeat = await runSeed(SEEDS[0], sandbox, windowStartDate);
  const repeatHash = hashResult(repeat);
  assert(
    firstHash === repeatHash,
    `determinism check failed for seed ${SEEDS[0]}: ${firstHash} !== ${repeatHash} ` +
      '(a second harness process writing to the same sandbox tenant would cause this)',
  );
  console.log(`\n✔ determinism check passed (seed ${SEEDS[0]} twice → sha256 ${firstHash.slice(0, 16)}…)`);

  const agg = aggregate(perSeed);
  printPerSeedTable(perSeed);
  printAggregateTable(agg, perSeed);

  const foreignAfter = await countForeignSaleRows();
  assert(
    foreignBefore === foreignAfter,
    `non-sandbox sale rows changed: ${foreignBefore} → ${foreignAfter}`,
  );
  console.log(`\n✔ isolation check passed (non-sandbox sale rows ${foreignBefore} → ${foreignAfter})`);

  const determinismHash = { hash: firstHash, generatedAt };
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(
    path.join(OUTPUT_DIR, 'detection_results.md'),
    buildMarkdown({
      agg,
      perSeed,
      sandbox,
      dbToday,
      windowStartDate,
      foreignBefore,
      foreignAfter,
      determinismHash,
    }),
    'utf8',
  );
  await writeFile(path.join(OUTPUT_DIR, 'detection_results.csv'), buildCsv(perSeed, agg), 'utf8');

  console.log(`✔ wrote ${path.join(OUTPUT_DIR, 'detection_results.md')}`);
  console.log(`✔ wrote ${path.join(OUTPUT_DIR, 'detection_results.csv')}`);
  console.log('\n✅ validate:detection finished');
}

main()
  .catch((err) => {
    console.error('\n❌', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeSandboxPool();
  });
