/**
 * backend/scripts/validation/runIsolationForestValidation.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Validation harness for the Isolation Forest detector
 * (src/services/isolationForest.js) on the SAME synthetic series, the SAME
 * ground truth and the SAME exact-(SKU, date) matching rule that
 * runDetectionValidationV2.js used to validate the rolling z-score.
 *
 * WHY THIS IS COMPARABLE BY CONSTRUCTION, NOT BY CLAIM
 * The generator draws from a seeded stream, and `generateDataset` only depends on
 * the clock through its `endDate` option. The committed v2 hold-out was scored on
 * the series generated on 2026-10-10 (last day 2026-10-09), so this harness pins
 * `endDate` to 2026-10-10 and ASSERTS the last day is 2026-10-09. It then
 * re-derives the v2 prediction in memory and asserts it reproduces the published
 * hold-out numbers (0.379 / 0.544 / 0.446, 19.60 TP / 32.20 FP / 16.40 FN per
 * seed). If either assertion fails the comparison is not like-for-like and the
 * script aborts instead of printing a number.
 *
 * NO DATABASE IS TOUCHED. v2 was validated through the real engine against a
 * sandbox tenant; Isolation Forest is not wired into the engine yet, so this
 * harness only reads the deterministic generator and the pure modules.
 *
 * PHASES (the protocol is written down in docs/validation/frozen_config_iforest.json)
 *   --phase dev       tune `contamination` over CONTAMINATION_GRID on dev seeds
 *                     1-5 only; print every grid point and the choice.
 *   --phase freeze    re-run the same dev tuning and WRITE
 *                     docs/validation/frozen_config_iforest.json (refuses to
 *                     overwrite an existing frozen file without --force).
 *   --phase holdout   read the frozen config, run held-out seeds 6-10 ONCE, write
 *                     iforest_results.md + .csv, then mark the config evaluated so
 *                     the hold-out cannot be looked at a second time.
 *   --phase real      read the real London Bakers workbook, fit ONE model on the
 *                     tenant's 35 days and write iforest_real_flags.md with the top
 *                     flagged product-days and an empty "manager confirmed?" column.
 *   --phase overlap   diagnostic on the SAME spent seeds: how many injected
 *                     anomalies each detector catches alone, jointly, and never,
 *                     plus the F1 of their union and intersection. Appends one
 *                     delimited section to iforest_results.md and NEVER rewrites
 *                     the frozen config (no threshold is chosen here).
 *
 * Runs from backend/:
 *   node scripts/validation/runIsolationForestValidation.js --phase dev
 *   node scripts/validation/runIsolationForestValidation.js --phase freeze
 *   node scripts/validation/runIsolationForestValidation.js --phase holdout
 *   node scripts/validation/runIsolationForestValidation.js --phase overlap
 *   node scripts/validation/runIsolationForestValidation.js --phase real --input "<workbook.xlsx>"
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as XLSX from 'xlsx';

import { generateDataset, GROUND_TRUTH_TOTAL } from './generateSyntheticData.js';
import { confusionCounts, classificationMetrics, pairKey, toPairSet } from './metrics.js';
import { DEFAULT_PARAMS as V2_PARAMS, scoreSeries } from '../../src/services/rollingZScore.js';
import {
  DEFAULT_IFOREST_PARAMS,
  FEATURE_NAMES,
  detectAnomalies,
  topScoredDays,
} from '../../src/services/isolationForest.js';

// ── Configuration ────────────────────────────────────────────────────────────
const DEV_SEEDS = [1, 2, 3, 4, 5];       // contamination is tuned on these
const HOLDOUT_SEEDS = [6, 7, 8, 9, 10];  // ...and then frozen, tested here

/** The clock the committed v2 hold-out ran on: 2026-10-10 ⇒ last day 2026-10-09. */
const SEALED_SERIES_END = new Date(2026, 9, 10, 12, 0, 0);
const SEALED_LAST_DAY = '2026-10-09';

/** The v2 numbers published in docs/validation/detection_results_v2.md. */
const V2_HOLDOUT_REFERENCE = {
  precision: 0.379, recall: 0.544, f1: 0.446,
  tp: 19.6, fp: 32.2, fn: 16.4, flags: 51.8,
};
const V2_DEV_REFERENCE = { precision: 0.388, recall: 0.539, f1: 0.450, flags: 50.0 };

/** Fractions of featurised product-days the detector may call anomalous. */
const CONTAMINATION_GRID = [
  0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.05, 0.06, 0.08, 0.10, 0.12, 0.15,
];

/** The v2 harness priced every synthetic unit at 100 (revenue = units × 100). */
const SYNTHETIC_UNIT_PRICE = 100;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');
const DOCS_DIR = path.join(REPO_ROOT, 'docs', 'validation');
const FROZEN_PATH = path.join(DOCS_DIR, 'frozen_config_iforest.json');
const RESULTS_MD_PATH = path.join(DOCS_DIR, 'iforest_results.md');
const RESULTS_CSV_PATH = path.join(DOCS_DIR, 'iforest_results.csv');
const REAL_FLAGS_PATH = path.join(DOCS_DIR, 'iforest_real_flags.md');

/**
 * Aborts the run. Used for every "this would not be a fair comparison" case.
 * @param {string} message What went wrong.
 * @returns {never} Never returns.
 */
function abort(message) {
  throw new Error(message);
}

/** @returns {number} Arithmetic mean (0 for an empty list). */
function meanOf(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** @returns {number} Population standard deviation (0 for an empty list). */
function sdOf(values) {
  if (values.length === 0) return 0;
  const mu = meanOf(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / values.length);
}

/** @returns {number} `value` rounded to `digits` decimals. */
function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** @returns {string} Fixed-point number, or 'n/a' when not finite. */
function fmt(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

/** @returns {string|null} The value of `--name value` in argv, if present. */
function argValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

/** @returns {boolean} Whether `--flag` appears in argv. */
function hasFlag(name) {
  return process.argv.includes(name);
}

// ── The sealed synthetic series, reproduced exactly ──────────────────────────
/** @type {Map<number, object>} seed → dataset, so a grid pass generates once. */
const datasetCache = new Map();

/**
 * Generates one seed's dataset on the sealed clock and asserts it really is the
 * series the v2 hold-out was scored on.
 * @param {number} seed Dataset seed.
 * @returns {object} Dataset from generateDataset.
 */
function sealedSeries(seed) {
  const cached = datasetCache.get(seed);
  if (cached) return cached;

  const dataset = generateDataset(seed, { endDate: SEALED_SERIES_END });
  const lastDay = dataset.days[dataset.days.length - 1].date;
  if (lastDay !== SEALED_LAST_DAY) {
    abort(`seed ${seed}: series ends ${lastDay}, expected ${SEALED_LAST_DAY}; the v2 comparison would not be like-for-like`);
  }
  if (dataset.groundTruth.length !== GROUND_TRUTH_TOTAL) {
    abort(`seed ${seed}: ${dataset.groundTruth.length} ground-truth anomalies, expected ${GROUND_TRUTH_TOTAL}`);
  }
  datasetCache.set(seed, dataset);
  return dataset;
}

/**
 * Converts a dataset into the (product, day) rows the detector eats: only days
 * with a sale, exactly as sale_transactions stores them, priced at
 * SYNTHETIC_UNIT_PRICE so the revenue feature is meaningful.
 * @param {object} dataset Dataset from generateDataset.
 * @returns {Array<{productKey: string, date: string, units: number, revenue: number}>} Rows.
 */
function toDetectorRows(dataset) {
  const rows = [];
  for (const product of dataset.series) {
    for (const point of product.points) {
      if (point.units <= 0) continue;
      rows.push({
        productKey: product.sku,
        date: point.date,
        units: point.units,
        revenue: point.units * SYNTHETIC_UNIT_PRICE,
      });
    }
  }
  return rows;
}

/**
 * v2's in-memory prediction over a product's FULL series — the same replication
 * runDetectionValidationV2.js scores as `v2_series`.
 * @param {object} dataset Dataset from generateDataset.
 * @returns {Array<{sku: string, date: string}>} Flagged product-days.
 */
function v2FlagsFor(dataset) {
  const flagged = [];
  for (const product of dataset.series) {
    const unitsByDate = new Map();
    let firstSaleDate = null;
    for (const point of product.points) {
      if (point.units > 0) {
        unitsByDate.set(point.date, point.units);
        if (firstSaleDate === null) firstSaleDate = point.date;
      }
    }
    if (firstSaleDate === null) continue;

    const dates = product.points.map((point) => point.date);
    for (const day of scoreSeries(unitsByDate, firstSaleDate, dates, V2_PARAMS)) {
      if (day.flagged) flagged.push({ sku: product.sku, date: day.date });
    }
  }
  return flagged;
}

/**
 * Confusion counts + precision/recall/F1 for one method.
 * @param {Array<{sku: string, date: string}>} flagged Flagged product-days.
 * @param {Array} groundTruth Injected anomalies.
 * @returns {{precision: number, recall: number, f1: number, tp: number, fp: number,
 *   fn: number, flaggedTotal: number, groundTruthTotal: number}} Metrics.
 */
function metricsFor(flagged, groundTruth) {
  const counts = confusionCounts(flagged, groundTruth);
  const scored = classificationMetrics(counts);
  return {
    precision: scored.precision,
    recall: scored.recall,
    f1: scored.f1,
    tp: counts.tp,
    fp: counts.fp,
    fn: counts.fn,
    flaggedTotal: counts.flaggedTotal,
    groundTruthTotal: counts.groundTruthTotal,
  };
}

/**
 * Mean and population sd of every headline metric across seeds.
 * @param {Array<object>} perSeed Rows from evaluateSeeds.
 * @param {'iforest'|'iforestBudget'|'v2'} key Which method to summarise.
 * @returns {{precision: {mean: number, sd: number}, recall: {mean: number, sd: number},
 *   f1: {mean: number, sd: number}, tp: number, fp: number, fn: number, flags: number}}
 *   Aggregate metrics.
 */
function summarise(perSeed, key) {
  const pick = (field) => perSeed.map((seed) => seed[key][field]);
  return {
    precision: { mean: meanOf(pick('precision')), sd: sdOf(pick('precision')) },
    recall: { mean: meanOf(pick('recall')), sd: sdOf(pick('recall')) },
    f1: { mean: meanOf(pick('f1')), sd: sdOf(pick('f1')) },
    tp: meanOf(pick('tp')),
    fp: meanOf(pick('fp')),
    fn: meanOf(pick('fn')),
    flags: meanOf(pick('flaggedTotal')),
  };
}

// ── Scoring one set of seeds ─────────────────────────────────────────────────
/**
 * Scores Isolation Forest and v2 on the same series.
 *
 * The budget arm answers a different question from the threshold arm: v2 flags
 * ~50 product-days per seed, so "IF at its own contamination" is compared with
 * both v2 AND with "IF allowed exactly as many flags as v2 took" — otherwise a
 * detector could win precision by simply flagging less.
 * @param {number[]} seeds Dataset seeds.
 * @param {number} contamination Expected anomaly fraction (threshold arm).
 * @returns {Array<{seed: number, threshold: number|null, sampleCount: number,
 *   iforest: object, iforestBudget: object, v2: object}>} Per-seed metrics.
 */
function evaluateSeeds(seeds, contamination) {
  return seeds.map((seed) => {
    const dataset = sealedSeries(seed);
    const detection = detectAnomalies(
      toDetectorRows(dataset),
      { ...DEFAULT_IFOREST_PARAMS, contamination },
    );
    if (detection.model === null) {
      abort(`seed ${seed}: Isolation Forest could not fit (${detection.sampleCount} samples)`);
    }

    const v2Flags = v2FlagsFor(dataset);
    const iforestFlags = detection.flagged.map(({ productKey, date }) => ({ sku: productKey, date }));
    const budgetFlags = topScoredDays(detection.scored, v2Flags.length)
      .map(({ productKey, date }) => ({ sku: productKey, date }));

    return {
      seed,
      threshold: detection.threshold,
      sampleCount: detection.sampleCount,
      iforest: metricsFor(iforestFlags, dataset.groundTruth),
      iforestBudget: metricsFor(budgetFlags, dataset.groundTruth),
      v2: metricsFor(v2Flags, dataset.groundTruth),
    };
  });
}

/**
 * Asserts that the in-memory v2 replication reproduces a reference table, so a
 * comparison against it is like-for-like.
 * @param {object} summary Output of summarise(..., 'v2').
 * @param {{precision: number, recall: number, f1: number}} reference Expected values.
 * @param {string} label Human-readable phase name.
 * @param {number} [tolerance] Absolute tolerance on each mean.
 * @returns {void}
 */
function assertMatchesReference(summary, reference, label, tolerance = 0.002) {
  const checks = [
    ['precision', summary.precision.mean, reference.precision],
    ['recall', summary.recall.mean, reference.recall],
    ['f1', summary.f1.mean, reference.f1],
  ];
  for (const [field, actual, expected] of checks) {
    if (Math.abs(actual - expected) > tolerance) {
      abort(`${label}: v2 ${field} ${fmt(actual, 4)} does not reproduce the published ${fmt(expected, 4)} (tolerance ${tolerance}); refusing to compare`);
    }
  }
}

// ── Phase: dev tuning ────────────────────────────────────────────────────────
/**
 * Runs the contamination grid on dev seeds 1-5 and picks a winner by mean F1.
 * Ties go to the SMALLER contamination — with equal F1 the quieter detector is
 * the one a manager can act on, and the rule has to be fixed before it runs.
 * @returns {{grid: Array<object>, chosen: object, perSeed: object, v2: object,
 *   budget: object}} Tuning outcome.
 */
function tuneOnDevSeeds() {
  const grid = [];
  let best = null;

  for (const contamination of CONTAMINATION_GRID) {
    const perSeed = evaluateSeeds(DEV_SEEDS, contamination);
    const summary = summarise(perSeed, 'iforest');
    const row = {
      contamination,
      precision: round(summary.precision.mean),
      recall: round(summary.recall.mean),
      f1: round(summary.f1.mean),
      f1Sd: round(summary.f1.sd),
      flags: round(summary.flags, 2),
      tp: round(summary.tp, 2),
      fp: round(summary.fp, 2),
      fn: round(summary.fn, 2),
    };
    grid.push(row);

    if (best === null
      || row.f1 > best.row.f1
      || (row.f1 === best.row.f1 && contamination < best.row.contamination)) {
      best = { row, perSeed, summary };
    }
  }

  // The winner's per-seed rows already carry v2's metrics for the same series.
  const v2Summary = summarise(best.perSeed, 'v2');
  assertMatchesReference(v2Summary, V2_DEV_REFERENCE, 'dev seeds 1-5');

  return {
    grid,
    chosen: best.row,
    perSeed: best.perSeed,
    summary: best.summary,
    v2: v2Summary,
    budget: summarise(best.perSeed, 'iforestBudget'),
    v2Flags: v2Summary.flags,
  };
}

/** @returns {string} One markdown table row per seed for both methods. */
function formatPerSeedTable(perSeed) {
  const lines = [
    '| seed | IF flags | IF P | IF R | IF F1 | IF@v2-budget F1 | v2 flags | v2 P | v2 R | v2 F1 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of perSeed) {
    lines.push(`| ${row.seed} | ${row.iforest.flaggedTotal} | ${fmt(row.iforest.precision)} | ${fmt(row.iforest.recall)} | ${fmt(row.iforest.f1)} | ${fmt(row.iforestBudget.f1)} | ${row.v2.flaggedTotal} | ${fmt(row.v2.precision)} | ${fmt(row.v2.recall)} | ${fmt(row.v2.f1)} |`);
  }
  return lines.join('\n');
}

/** @returns {string} The dev grid as one markdown row per contamination. */
function formatGridTable(grid) {
  const lines = [
    '| contamination | flags/seed | precision | recall | F1 | F1 sd | TP | FP | FN |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const row of grid) {
    lines.push(`| ${row.contamination} | ${fmt(row.flags, 1)} | ${fmt(row.precision, 3)} | ${fmt(row.recall, 3)} | ${fmt(row.f1, 3)} | ${fmt(row.f1Sd, 3)} | ${fmt(row.tp, 1)} | ${fmt(row.fp, 1)} | ${fmt(row.fn, 1)} |`);
  }
  return lines.join('\n');
}

/** @returns {string} The banner printed at the top of every phase. */
function banner(title) {
  const line = '─'.repeat(78);
  return `\n${line}\n${title}\n${line}`;
}

/** @returns {Promise<string|null>} File contents, or null when it does not exist. */
async function readTextIfExists(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// ── Phase: dev ───────────────────────────────────────────────────────────────
/**
 * Tunes on dev seeds 1-5 and prints every grid point. Writes nothing.
 * @returns {Promise<object>} The tuning outcome (also used by the freeze phase).
 */
async function runDevPhase() {
  console.log(banner('Isolation Forest — DEV tuning (seeds 1-5, contamination grid)'));
  console.log(`series: 20 products × 90 days ending ${SEALED_LAST_DAY}, ground truth ${GROUND_TRUTH_TOTAL} anomalies/seed`);
  console.log(`forest: ${DEFAULT_IFOREST_PARAMS.treeCount} trees, ψ=${DEFAULT_IFOREST_PARAMS.subsampleSize}, seed ${DEFAULT_IFOREST_PARAMS.seed}`);
  console.log(`features: ${FEATURE_NAMES.join(', ')}`);

  const tuning = tuneOnDevSeeds();

  console.log(`\n${formatGridTable(tuning.grid)}\n`);
  console.log(`chosen contamination: ${tuning.chosen.contamination}  (mean F1 ${fmt(tuning.chosen.f1)})`);
  console.log(`  IF  @ ${tuning.chosen.contamination}: P=${fmt(tuning.summary.precision.mean)} (sd ${fmt(tuning.summary.precision.sd)}) R=${fmt(tuning.summary.recall.mean)} (sd ${fmt(tuning.summary.recall.sd)}) F1=${fmt(tuning.summary.f1.mean)} (sd ${fmt(tuning.summary.f1.sd)}) flags=${fmt(tuning.summary.flags, 1)}`);
  console.log(`  IF  @ matched budget (${fmt(tuning.v2Flags, 1)} flags/seed): P=${fmt(tuning.budget.precision.mean)} R=${fmt(tuning.budget.recall.mean)} F1=${fmt(tuning.budget.f1.mean)}`);
  console.log(`  v2  @ its own threshold: P=${fmt(tuning.v2.precision.mean)} R=${fmt(tuning.v2.recall.mean)} F1=${fmt(tuning.v2.f1.mean)} flags=${fmt(tuning.v2.flags, 1)}`);
  console.log('\nPer seed (threshold arm, budget arm, v2):');
  console.log(formatPerSeedTable(tuning.perSeed));
  return tuning;
}

// ── Phase: freeze ────────────────────────────────────────────────────────────
/**
 * Builds the frozen-protocol object from a dev tuning pass.
 * @param {object} tuning Outcome of tuneOnDevSeeds.
 * @returns {object} The JSON that becomes frozen_config_iforest.json.
 */
function buildFrozenConfig(tuning) {
  return {
    status: 'frozen',
    detector: 'isolation_forest',
    module: 'backend/src/services/isolationForest.js',
    harness: 'backend/scripts/validation/runIsolationForestValidation.js',
    frozenAt: new Date().toISOString(),
    params: { ...DEFAULT_IFOREST_PARAMS, contamination: tuning.chosen.contamination },
    featureNames: [...FEATURE_NAMES],
    series: {
      generator: 'backend/scripts/validation/generateSyntheticData.js',
      productCount: 20,
      dayCount: 90,
      groundTruthPerSeed: GROUND_TRUTH_TOTAL,
      endDateUsed: SEALED_SERIES_END.toISOString(),
      lastDay: SEALED_LAST_DAY,
      note: 'Pinned to the clock the v2 hold-out ran on (2026-10-10), so both detectors are scored on byte-identical series and ground truth.',
    },
    selectionRule: 'Highest mean F1 over dev seeds 1-5 across CONTAMINATION_GRID; ties go to the smaller contamination (quieter detector). Rule fixed before the hold-out was run.',
    devProtocol: {
      seeds: DEV_SEEDS,
      grid: CONTAMINATION_GRID,
      metric: 'mean F1 over the five dev seeds, exact-(SKU, date) matching',
    },
    devResults: {
      chosenContamination: tuning.chosen.contamination,
      iforest: {
        precision: round(tuning.summary.precision.mean),
        precisionSd: round(tuning.summary.precision.sd),
        recall: round(tuning.summary.recall.mean),
        recallSd: round(tuning.summary.recall.sd),
        f1: round(tuning.summary.f1.mean),
        f1Sd: round(tuning.summary.f1.sd),
        flagsPerSeed: round(tuning.summary.flags, 2),
        tp: round(tuning.summary.tp, 2),
        fp: round(tuning.summary.fp, 2),
        fn: round(tuning.summary.fn, 2),
      },
      iforestMatchedBudget: {
        budgetPerSeed: round(tuning.v2Flags, 2),
        precision: round(tuning.budget.precision.mean),
        recall: round(tuning.budget.recall.mean),
        f1: round(tuning.budget.f1.mean),
      },
      v2Reference: {
        precision: round(tuning.v2.precision.mean),
        recall: round(tuning.v2.recall.mean),
        f1: round(tuning.v2.f1.mean),
        flagsPerSeed: round(tuning.v2.flags, 2),
      },
      grid: tuning.grid,
      perSeed: tuning.perSeed.map((row) => ({
        seed: row.seed,
        threshold: round(row.threshold, 6),
        sampleCount: row.sampleCount,
        iforest: {
          precision: round(row.iforest.precision),
          recall: round(row.iforest.recall),
          f1: round(row.iforest.f1),
          flags: row.iforest.flaggedTotal,
          tp: row.iforest.tp,
          fp: row.iforest.fp,
          fn: row.iforest.fn,
        },
        iforestMatchedBudget: { f1: round(row.iforestBudget.f1), flags: row.iforestBudget.flaggedTotal },
        v2: { precision: round(row.v2.precision), recall: round(row.v2.recall), f1: round(row.v2.f1), flags: row.v2.flaggedTotal },
      })),
    },
    holdoutProtocol: {
      seeds: HOLDOUT_SEEDS,
      arms: [
        'threshold at the frozen contamination',
        'top-k budget matched to the v2 flag count of the same seed',
      ],
      evaluated: false,
      evaluatedAt: null,
      note: 'Run exactly once: `npm run validate:iforest -- --phase holdout`. The harness sets evaluated=true after writing the results, so re-reading the hold-out needs --force and has to be disclosed in the report.',
    },
    holdoutResults: null,
    artifacts: [
      'docs/validation/iforest_dev_tuning.md',
      'docs/validation/iforest_results.md',
      'docs/validation/iforest_results.csv',
      'docs/validation/iforest_real_flags.md',
    ],
  };
}

/**
 * Writes the frozen protocol. Refuses to clobber an existing frozen file unless
 * --force is passed, because a config rewritten after seeing hold-out results is
 * no longer a protocol.
 * @param {boolean} force Whether to overwrite an existing frozen file.
 * @returns {Promise<void>}
 */
async function runFreezePhase(force) {
  const existing = await readTextIfExists(FROZEN_PATH);
  if (existing !== null && !force) {
    abort(`${FROZEN_PATH} already exists. A frozen protocol stays frozen — pass --force only to correct it BEFORE any hold-out run, and say so in the report.`);
  }

  const tuning = await runDevPhase();
  const config = buildFrozenConfig(tuning);

  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(FROZEN_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await writeFile(path.join(DOCS_DIR, 'iforest_dev_tuning.md'), buildDevTuningMarkdown(config, tuning), 'utf8');

  console.log(banner('FROZEN — docs/validation/frozen_config_iforest.json'));
  console.log(`contamination ${config.params.contamination} · seed ${config.params.seed} · ${config.params.treeCount} trees · features ${config.featureNames.length}`);
  console.log('The hold-out is now one-shot: run --phase holdout once, then commit the config diff together with the results.');
}

/**
 * Renders docs/validation/iforest_dev_tuning.md.
 * @param {object} config Frozen config.
 * @param {object} tuning Outcome of tuneOnDevSeeds.
 * @returns {string} Markdown body.
 */
function buildDevTuningMarkdown(config, tuning) {
  return [
    '# Isolation Forest — dev tuning (seeds 1-5)',
    '',
    `Generated ${config.frozenAt} by \`${config.harness}\`.`,
    '',
    'Frozen protocol: `docs/validation/frozen_config_iforest.json`. Tuning used **dev seeds 1-5 only**; held-out seeds 6-10 were not read.',
    '',
    '## Series',
    '',
    `- generator \`${config.series.generator}\`, ${config.series.productCount} products × ${config.series.dayCount} days, last day ${config.series.lastDay}`,
    `- \`endDate\` pinned to ${config.series.endDateUsed} — the clock the v2 hold-out ran on`,
    `- ${config.series.groundTruthPerSeed} injected anomalies per seed`,
    `- detector \`${config.module}\`, features ${config.featureNames.join(', ')}`,
    '',
    '## Contamination grid',
    '',
    formatGridTable(tuning.grid),
    '',
    `Selection rule: ${config.selectionRule}`,
    '',
    `**Chosen: contamination ${tuning.chosen.contamination}** (mean F1 ${fmt(tuning.chosen.f1)}, F1 sd across seeds ${fmt(tuning.chosen.f1Sd)}).`,
    '',
    '## Per seed at the chosen threshold',
    '',
    formatPerSeedTable(tuning.perSeed),
    '',
    '`IF@v2-budget F1` scores the forest on its own top-k days, k = the number of flags v2 took on that same seed. It is a fairness arm, not a tuned setting.',
    '',
    '## Dev reference points',
    '',
    '| method | flags/seed | precision | recall | F1 |',
    '| --- | --- | --- | --- | --- |',
    `| IF @ ${tuning.chosen.contamination} | ${fmt(tuning.summary.flags, 1)} | ${fmt(tuning.summary.precision.mean)} | ${fmt(tuning.summary.recall.mean)} | ${fmt(tuning.summary.f1.mean)} |`,
    `| IF @ matched budget | ${fmt(tuning.v2Flags, 1)} | ${fmt(tuning.budget.precision.mean)} | ${fmt(tuning.budget.recall.mean)} | ${fmt(tuning.budget.f1.mean)} |`,
    `| v2 rolling z-score | ${fmt(tuning.v2.flags, 1)} | ${fmt(tuning.v2.precision.mean)} | ${fmt(tuning.v2.recall.mean)} | ${fmt(tuning.v2.f1.mean)} |`,
    '',
    'The v2 row is recomputed in memory and asserted against the published dev means (0.388 / 0.539 / 0.450) before any IF number is read, so all three rows come from identical series and ground truth.',
    '',
  ].join('\n');
}

// ── Phase: hold-out (one shot) ───────────────────────────────────────────────
/**
 * Loads the frozen protocol and refuses anything that is not a clean one-shot:
 * no protocol file, a config that drifted from the module defaults, or a hold-out
 * that was already looked at (only checked for the hold-out phase itself — the
 * real-data phase never reads held-out seeds).
 * @param {{force?: boolean, forHoldout?: boolean}} [options] Guard options.
 * @returns {Promise<object>} The frozen config.
 */
async function loadFrozenConfig(options = {}) {
  const { force = false, forHoldout = false } = options;
  const raw = await readTextIfExists(FROZEN_PATH);
  if (raw === null) {
    abort(`No frozen protocol at ${FROZEN_PATH}. Run --phase freeze first and commit it.`);
  }

  const config = JSON.parse(raw);
  for (const [name, expected] of Object.entries(DEFAULT_IFOREST_PARAMS)) {
    if (name === 'contamination') continue;
    if (config.params[name] !== expected) {
      abort(`frozen params.${name} is ${JSON.stringify(config.params[name])} but the module default is ${JSON.stringify(expected)}; re-freeze before running the hold-out`);
    }
  }
  if (!CONTAMINATION_GRID.includes(config.params.contamination)) {
    abort(`frozen contamination ${config.params.contamination} is not on the dev grid; it was not tuned under the protocol`);
  }
  if (forHoldout && config.holdoutProtocol?.evaluated === true && !force) {
    abort('The hold-out was already evaluated. Re-reading it burns the one-shot — pass --force and disclose it in the report.');
  }
  return config;
}

/**
 * Scores held-out seeds at the frozen threshold and at v2's flag budget.
 * @param {object} config Frozen config.
 * @returns {{perSeed: Array<object>, iforest: object, budget: object, v2: object}} Results.
 */
function evaluateHoldout(config) {
  const perSeed = evaluateSeeds(HOLDOUT_SEEDS, config.params.contamination);
  const iforest = summarise(perSeed, 'iforest');
  const budget = summarise(perSeed, 'iforestBudget');
  const v2 = summarise(perSeed, 'v2');
  assertMatchesReference(v2, V2_HOLDOUT_REFERENCE, 'hold-out seeds 6-10');
  return { perSeed, iforest, budget, v2 };
}

/**
 * Honest, minimal comparison: per-seed F1 deltas, the mean, their spread and how
 * many seeds each arm won. Deliberately does NOT claim a p-value — five seeds
 * with 36 anomalies each cannot support one.
 * @param {Array<object>} perSeed Rows from evaluateSeeds.
 * @param {'iforest'|'iforestBudget'} key Arm to compare against v2.
 * @returns {{deltas: number[], mean: number, sd: number, wins: number, losses: number,
 *   ties: number, min: number, max: number}} Comparison summary.
 */
function compareToV2(perSeed, key) {
  const deltas = perSeed.map((row) => round(row[key].f1 - row.v2.f1, 4));
  return {
    deltas,
    mean: meanOf(deltas),
    sd: sdOf(deltas),
    wins: deltas.filter((delta) => delta > 0).length,
    losses: deltas.filter((delta) => delta < 0).length,
    ties: deltas.filter((delta) => delta === 0).length,
    min: Math.min(...deltas),
    max: Math.max(...deltas),
  };
}

/** @returns {string} The results CSV (one row per method per seed). */
function buildResultsCsv(perSeed) {
  const lines = ['phase,method,seed,flags,tp,fp,fn,precision,recall,f1'];
  const push = (method, row, metrics) => {
    lines.push([
      'holdout', method, row.seed, metrics.flaggedTotal,
      metrics.tp, metrics.fp, metrics.fn,
      round(metrics.precision, 4), round(metrics.recall, 4), round(metrics.f1, 4),
    ].join(','));
  };
  for (const row of perSeed) {
    push('iforest_threshold', row, row.iforest);
    push('iforest_matched_budget', row, row.iforestBudget);
    push('rolling_zscore_v2', row, row.v2);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Runs the hold-out once, writes results, then stamps the config as evaluated.
 * @param {boolean} force Whether a second look was explicitly allowed.
 * @returns {Promise<void>}
 */
async function runHoldoutPhase(force) {
  const config = await loadFrozenConfig({ force, forHoldout: true });
  console.log(banner('Isolation Forest — HOLD-OUT (seeds 6-10, one shot)'));
  console.log(`frozen ${config.frozenAt} · contamination ${config.params.contamination} · seed ${config.params.seed}`);

  const results = evaluateHoldout(config);
  const thresholdCompare = compareToV2(results.perSeed, 'iforest');
  const budgetCompare = compareToV2(results.perSeed, 'iforestBudget');

  const warmupTruth = results.perSeed.map((row) => {
    const dataset = sealedSeries(row.seed);
    return dataset.groundTruth.filter((truth) => truth.dayIndex <= DEFAULT_IFOREST_PARAMS.historyDays).length;
  });
  const unreachable = meanOf(warmupTruth);

  console.log(`\nIF @ ${config.params.contamination}: P=${fmt(results.iforest.precision.mean)} R=${fmt(results.iforest.recall.mean)} F1=${fmt(results.iforest.f1.mean)} (sd ${fmt(results.iforest.f1.sd)}) flags=${fmt(results.iforest.flags, 1)}`);
  console.log(`IF @ matched budget (${fmt(results.v2.flags, 1)}): P=${fmt(results.budget.precision.mean)} R=${fmt(results.budget.recall.mean)} F1=${fmt(results.budget.f1.mean)} (sd ${fmt(results.budget.f1.sd)})`);
  console.log(`v2 @ its own threshold: P=${fmt(results.v2.precision.mean)} R=${fmt(results.v2.recall.mean)} F1=${fmt(results.v2.f1.mean)} (sd ${fmt(results.v2.f1.sd)}) flags=${fmt(results.v2.flags, 1)}`);
  console.log(`\nF1 delta vs v2 — IF threshold: mean ${fmt(thresholdCompare.mean, 4)} (sd ${fmt(thresholdCompare.sd, 4)}, wins ${thresholdCompare.wins}/5)`);
  console.log(`F1 delta vs v2 — IF matched budget: mean ${fmt(budgetCompare.mean, 4)} (sd ${fmt(budgetCompare.sd, 4)}, wins ${budgetCompare.wins}/5)`);

  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(RESULTS_CSV_PATH, buildResultsCsv(results.perSeed), 'utf8');
  await writeFile(
    RESULTS_MD_PATH,
    buildResultsMarkdown(config, results, thresholdCompare, budgetCompare, unreachable),
    'utf8',
  );

  const updated = {
    ...config,
    holdoutProtocol: { ...config.holdoutProtocol, evaluated: true, evaluatedAt: new Date().toISOString() },
    holdoutResults: {
      iforest: {
        precision: round(results.iforest.precision.mean),
        recall: round(results.iforest.recall.mean),
        f1: round(results.iforest.f1.mean),
        f1Sd: round(results.iforest.f1.sd),
        flagsPerSeed: round(results.iforest.flags, 2),
      },
      iforestMatchedBudget: {
        precision: round(results.budget.precision.mean),
        recall: round(results.budget.recall.mean),
        f1: round(results.budget.f1.mean),
        f1Sd: round(results.budget.f1.sd),
        budgetPerSeed: round(results.v2.flags, 2),
      },
      v2Reference: {
        precision: round(results.v2.precision.mean),
        recall: round(results.v2.recall.mean),
        f1: round(results.v2.f1.mean),
        flagsPerSeed: round(results.v2.flags, 2),
      },
      f1DeltaVsV2: {
        threshold: { mean: round(thresholdCompare.mean), sd: round(thresholdCompare.sd), wins: thresholdCompare.wins, perSeed: thresholdCompare.deltas },
        matchedBudget: { mean: round(budgetCompare.mean), sd: round(budgetCompare.sd), wins: budgetCompare.wins, perSeed: budgetCompare.deltas },
      },
      perSeed: results.perSeed.map((row) => ({
        seed: row.seed,
        threshold: round(row.threshold, 6),
        iforest: { precision: round(row.iforest.precision), recall: round(row.iforest.recall), f1: round(row.iforest.f1), flags: row.iforest.flaggedTotal },
        iforestMatchedBudget: { precision: round(row.iforestBudget.precision), recall: round(row.iforestBudget.recall), f1: round(row.iforestBudget.f1), flags: row.iforestBudget.flaggedTotal },
        v2: { precision: round(row.v2.precision), recall: round(row.v2.recall), f1: round(row.v2.f1), flags: row.v2.flaggedTotal },
      })),
    },
  };
  await writeFile(FROZEN_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');

  console.log(banner('WROTE'));
  console.log('docs/validation/iforest_results.md');
  console.log('docs/validation/iforest_results.csv');
  console.log('frozen_config_iforest.json → holdoutProtocol.evaluated = true (commit this diff with the results)');
}

/**
 * Renders docs/validation/iforest_results.md from the hold-out run.
 * @param {object} config Frozen config.
 * @param {{perSeed: Array<object>, iforest: object, budget: object, v2: object}} results Hold-out results.
 * @param {object} thresholdCompare compareToV2 output for the threshold arm.
 * @param {object} budgetCompare compareToV2 output for the budget arm.
 * @param {number} unreachable Anomalies per seed injected inside the 14-day warm-up.
 * @returns {string} Markdown body.
 */
function buildResultsMarkdown(config, results, thresholdCompare, budgetCompare, unreachable) {
  const verdictFor = (label, compare) => {
    const direction = compare.mean > 0 ? 'leads' : compare.mean < 0 ? 'trails' : 'ties';
    const noise = Math.abs(compare.mean) <= compare.sd
      ? ' The mean is smaller than the spread across seeds, so this is not a settled win either way.'
      : '';
    return `- **${label}** ${direction} v2 by ${fmt(Math.abs(compare.mean), 4)} F1 on average, winning ${compare.wins}/5 seeds (delta sd ${fmt(compare.sd, 4)}, range ${fmt(compare.min, 3)}..${fmt(compare.max, 3)}).${noise}`;
  };

  return [
    '# Isolation Forest vs rolling z-score (v2) — held-out seeds 6-10',
    '',
    `Run ${config.holdoutProtocol.evaluatedAt ?? config.frozenAt} by \`${config.harness}\` against the protocol frozen in \`docs/validation/frozen_config_iforest.json\`.`,
    '',
    'This was a ONE-SHOT evaluation: the contamination was fixed on dev seeds 1-5, written to the frozen config, and only then were seeds 6-10 scored. The harness refuses a second pass without `--force`.',
    '',
    'Seeds and the forest PRNG seed are fixed, so repeating the phase reproduces the numbers below byte for byte: a rerun is a reproducibility check, not a new look, because nothing in the protocol can change between passes.',
    '',
    '## Frozen settings',
    '',
    '| setting | value |',
    '| --- | --- |',
    `| detector | \`${config.module}\` |`,
    `| contamination | ${config.params.contamination} |`,
    `| trees / subsample | ${config.params.treeCount} / ψ ${config.params.subsampleSize} |`,
    `| PRNG seed | ${config.params.seed} |`,
    `| history days / weekday lookback | ${config.params.historyDays} / ${config.params.weekdayLookback} |`,
    `| features | ${config.featureNames.join(', ')} |`,
    `| series | 20 products × 90 days, last day ${config.series.lastDay}, ${config.series.groundTruthPerSeed} anomalies/seed |`,
    '',
    '## Headline (mean over 5 held-out seeds)',
    '',
    '| arm | flags/seed | precision | recall | F1 | F1 sd |',
    '| --- | --- | --- | --- | --- | --- |',
    `| IF, frozen threshold | ${fmt(results.iforest.flags, 1)} | ${fmt(results.iforest.precision.mean)} | ${fmt(results.iforest.recall.mean)} | ${fmt(results.iforest.f1.mean)} | ${fmt(results.iforest.f1.sd)} |`,
    `| IF, budget matched to v2 (${fmt(results.v2.flags, 1)} flags) | ${fmt(results.budget.flags, 1)} | ${fmt(results.budget.precision.mean)} | ${fmt(results.budget.recall.mean)} | ${fmt(results.budget.f1.mean)} | ${fmt(results.budget.f1.sd)} |`,
    `| v2 rolling z-score | ${fmt(results.v2.flags, 1)} | ${fmt(results.v2.precision.mean)} | ${fmt(results.v2.recall.mean)} | ${fmt(results.v2.f1.mean)} | ${fmt(results.v2.f1.sd)} |`,
    '',
    'The v2 row is recomputed in memory on the same series and asserted against the published hold-out means (0.379 / 0.544 / 0.446) before this file is written, so the comparison is like-for-like by construction rather than by assertion.',
    '',
    '## Per seed',
    '',
    formatPerSeedTable(results.perSeed),
    '',
    `Per-seed F1 delta vs v2 — threshold arm: ${thresholdCompare.deltas.map((delta) => fmt(delta, 3)).join(', ')}; budget arm: ${budgetCompare.deltas.map((delta) => fmt(delta, 3)).join(', ')}.`,
    '',
    '## Reading the comparison honestly',
    '',
    verdictFor('IF at its frozen threshold', thresholdCompare),
    verdictFor('IF at v2\'s flag budget', budgetCompare),
    '',
    `Structural handicap: the forest needs ${config.params.historyDays} days of history before a day can be featurised, and ${fmt(unreachable, 1)} of the ${config.series.groundTruthPerSeed} injected anomalies per seed land inside that warm-up. They are counted in recall's denominator but can never be flagged, so IF's recall is capped around ${fmt(1 - unreachable / config.series.groundTruthPerSeed, 3)} before it looks at any data. v2 has no such blind spot.`,
    '',
    '## What this does and does not show',
    '',
    '- It shows how each detector ranks the same injected multiplicative spikes on the same synthetic series, under the same exact-(SKU, date) matching rule.',
    '- It does NOT show real-world value. The truth here is a known multiplier applied to one product-day; a shop\'s real anomalies (mis-scans, returns, promos, stockouts) are not generated by this process, and both detectors are being graded on the phenomenon the generator models.',
    '- Five seeds × 36 anomalies is a small sample. Per-seed spread is reported instead of a significance test because a p-value on five paired observations would overstate what this evidence supports.',
    '- The forest is scored through the pure module only: it is not wired into the detection engine, produces no severity, no explanation text and no DB alert rows yet. Nothing here justifies switching the production detector; the recommendation follows below.',
    '',
    ...buildRecommendationSection(config, thresholdCompare, budgetCompare),
    '## Reproduce',
    '',
    '```',
    'cd backend',
    'npm run validate:iforest -- --phase dev      :: grid preview, writes nothing',
    'npm run validate:iforest -- --phase freeze   :: writes frozen_config_iforest.json',
    'npm run validate:iforest -- --phase holdout  :: one shot; refuses to repeat',
    'npm run validate:iforest -- --phase overlap  :: flag overlap vs v2 (idempotent)',
    '```',
    '',
  ].join('\n');
}

/**
 * Renders the decision section. The wording is driven by the measured deltas so
 * the file cannot claim more than the numbers say; re-running the harness on a
 * different protocol re-derives the text instead of leaving a stale verdict.
 * @param {object} config Frozen config.
 * @param {object} thresholdCompare compareToV2 output for the threshold arm.
 * @param {object} budgetCompare compareToV2 output for the budget arm.
 * @returns {string[]} Markdown lines.
 */
function buildRecommendationSection(config, thresholdCompare, budgetCompare) {
  const thresholdSettled = Math.abs(thresholdCompare.mean) > thresholdCompare.sd;
  const budgetSettled = Math.abs(budgetCompare.mean) > budgetCompare.sd;
  const beatsAtBudget = budgetCompare.mean > 0 && budgetSettled;

  const decision = beatsAtBudget
    ? '**The evidence supports switching the production detector to the Isolation Forest.** At v2\'s own flag budget it wins by more than one standard deviation of the per-seed delta, so the advantage is not an artefact of flagging fewer days.'
    : '**Do not switch the production detector.** At the frozen contamination the forest flags fewer days than v2, and when it is cut to v2\'s flag count it does not beat v2 on this harness. The threshold-arm difference is not large enough relative to the seed-to-seed spread to carry a decision on five seeds.';

  return [
    '## Recommendation',
    '',
    decision,
    '',
    `- Contamination stays at ${config.params.contamination}, the dev choice. It must not be re-tuned on seeds 6-10: that one shot is spent, and re-picking it here would turn this table into a training score.`,
    `- Threshold arm measured ${fmt(thresholdCompare.mean, 4)} ± ${fmt(thresholdCompare.sd, 4)} F1 over v2 (${thresholdCompare.wins}/5 seeds); matched-budget arm measured ${fmt(budgetCompare.mean, 4)} ± ${fmt(budgetCompare.sd, 4)} (${budgetCompare.wins}/5 seeds). Threshold arm settled: ${thresholdSettled ? 'yes' : 'no'}. Matched-budget arm settled: ${budgetSettled ? 'yes' : 'no'}. "Settled" here means only that the mean exceeds its own seed spread — on five seeds that is a weak bar, not a significance test.`,
    '- What the forest IS worth doing next, in order: (1) fill the `manager confirmed?` column in `iforest_real_flags.md` from the shop, which turns the real workbook into a small labelled sample; (2) measure flag-level overlap between IF and v2 on held-out seeds, because a second detector is only worth a UI surface if it surfaces days the first one misses; (3) if both look favourable, wire IF in as a shadow detector that writes no manager-facing alert, deduped by (product, date).',
    '- Known structural handicaps if it is ever wired in: 14 days of history must pass before a product can be scored at all (so a new tenant sees nothing for two weeks, and the first flagged day is always relative to a thin baseline), no severity or explanation text is produced, and `revenue` is absolute so a permanently high-priced item sits at a distribution edge.',
    '- What would overturn this: a larger held-out sweep (more seeds, or more anomalies per seed) where the matched-budget delta stays positive beyond its spread, or a labelled real sample where IF flags days v2 demonstrably misses.',
    '',
  ];
}

// ── Phase: flag overlap with v2 (diagnostic on the already-spent seeds) ──────
// The hold-out section answers "which detector scores better?". This one answers
// "would a manager see anything new if BOTH ran?" — a different question, asked
// on the same five spent seeds, so it can describe the evidence but cannot feed a
// parameter choice. The frozen config is read and never written here.
const OVERLAP_START = '<!-- overlap:start -->';
const OVERLAP_END = '<!-- overlap:end -->';

/**
 * Computes one seed's flag overlap and the F1 of the union / intersection.
 *
 * "Only IF" and "only v2" are counted twice over: once for flags (any flagged
 * product-day) and once for TRUE anomalies (ground-truth pairs one detector
 * caught and the other missed). The second table is the one that decides whether
 * a second detector is worth a UI surface.
 * @param {number} seed Dataset seed.
 * @param {number} contamination Frozen contamination.
 * @returns {object} Per-seed overlap, union and intersection metrics.
 */
function overlapForSeed(seed, contamination) {
  const dataset = sealedSeries(seed);
  const detection = detectAnomalies(
    toDetectorRows(dataset),
    { ...DEFAULT_IFOREST_PARAMS, contamination },
  );
  if (detection.model === null) {
    abort(`seed ${seed}: Isolation Forest could not fit (${detection.sampleCount} samples)`);
  }

  const iforestFlags = detection.flagged.map(({ productKey, date }) => ({ sku: productKey, date }));
  const v2Flags = v2FlagsFor(dataset);
  const iforestKeys = toPairSet(iforestFlags);
  const v2Keys = toPairSet(v2Flags);
  // The generator stores the SKU as `productSku`; pairKey wants `sku`, which is
  // the same normalisation metrics.confusionCounts applies to the ground truth.
  const truthKeys = new Set(
    dataset.groundTruth.map((truth) => pairKey(truth.productSku, truth.date)),
  );

  const unionFlags = new Set([...iforestKeys, ...v2Keys]);
  const intersectionFlags = new Set([...iforestKeys].filter((key) => v2Keys.has(key)));
  const countTruth = (predicate) => [...truthKeys].filter(predicate).length;

  return {
    seed,
    iforest: metricsFor(iforestFlags, dataset.groundTruth),
    v2: metricsFor(v2Flags, dataset.groundTruth),
    union: metricsFor(unionFlags, dataset.groundTruth),
    intersection: metricsFor(intersectionFlags, dataset.groundTruth),
    flags: {
      iforest: iforestKeys.size,
      v2: v2Keys.size,
      both: [...iforestKeys].filter((key) => v2Keys.has(key)).length,
      onlyIforest: [...iforestKeys].filter((key) => !v2Keys.has(key)).length,
      onlyV2: [...v2Keys].filter((key) => !iforestKeys.has(key)).length,
    },
    truth: {
      total: truthKeys.size,
      both: countTruth((key) => iforestKeys.has(key) && v2Keys.has(key)),
      onlyIforest: countTruth((key) => iforestKeys.has(key) && !v2Keys.has(key)),
      onlyV2: countTruth((key) => !iforestKeys.has(key) && v2Keys.has(key)),
      neither: countTruth((key) => !iforestKeys.has(key) && !v2Keys.has(key)),
    },
  };
}

/**
 * Renders the overlap section. Every sentence about a winner is derived from the
 * measured means, so the file states "the union does not beat the better single
 * detector" only when that is what the numbers show.
 * @param {object} config Frozen config.
 * @param {Array<object>} perSeed Output of overlapForSeed, one row per seed.
 * @returns {string} Markdown block, including its delimiters.
 */
function buildOverlapSection(config, perSeed) {
  const flagMean = (key) => meanOf(perSeed.map((row) => row.flags[key]));
  const truthMean = (key) => meanOf(perSeed.map((row) => row.truth[key]));
  const f1Mean = (arm) => meanOf(perSeed.map((row) => row[arm].f1));
  const precisionMean = (arm) => meanOf(perSeed.map((row) => row[arm].precision));
  const recallMean = (arm) => meanOf(perSeed.map((row) => row[arm].recall));
  const flagsMean = (arm) => meanOf(perSeed.map((row) => row[arm].flaggedTotal));

  const arms = ['iforest', 'v2', 'union', 'intersection'];
  const f1 = Object.fromEntries(arms.map((arm) => [arm, f1Mean(arm)]));
  const bestSingle = Math.max(f1.iforest, f1.v2);
  const bestArm = f1.iforest >= f1.v2 ? 'iforest' : 'v2';
  const unionBeatsBoth = f1.union > bestSingle;
  const intersectionBeatsBoth = f1.intersection > bestSingle;

  const verdict = unionBeatsBoth
    ? `The union beats the better single detector (${bestArm === 'iforest' ? 'IF' : 'v2'}) by ${fmt(f1.union - bestSingle, 4)} F1 on average, so the two detectors are not redundant on this harness — they miss different days. That is a reason to keep measuring, not a reason to ship a combined surface: the evidence is still five synthetic seeds.`
    : `The union does NOT beat the better single detector (${bestArm === 'iforest' ? 'IF' : 'v2'}, ${fmt(bestSingle, 4)} F1) — it scores ${fmt(f1.union, 4)}. The extra days IF flags are paid for with extra false flags, so a manager running both would get more alerts of the same quality, not better alerts. On this harness there is no case for a combined surface, and none is being built.`;

  const lines = [
    OVERLAP_START,
    '## Flag overlap with v2 — same held-out seeds, diagnostic only',
    '',
    `Measured ${new Date().toISOString().slice(0, 10)} from the frozen config (contamination ${config.params.contamination}) on seeds ${HOLDOUT_SEEDS.join(', ')} — the SAME seeds the one-shot hold-out already scored. Nothing is tuned, no threshold is chosen, and \`frozen_config_iforest.json\` is not rewritten: this answers "would running both detectors surface anything new?", not "which detector wins?".`,
    '',
    '### What each detector contributed (mean per seed)',
    '',
    '| contribution | mean per seed |',
    '| --- | --- |',
    `| flags — IF only | ${fmt(flagMean('onlyIforest'), 1)} |`,
    `| flags — v2 only | ${fmt(flagMean('onlyV2'), 1)} |`,
    `| flags — both detectors | ${fmt(flagMean('both'), 1)} |`,
    `| true anomalies caught by both | ${fmt(truthMean('both'), 1)} |`,
    `| true anomalies caught by IF only | ${fmt(truthMean('onlyIforest'), 1)} |`,
    `| true anomalies caught by v2 only | ${fmt(truthMean('onlyV2'), 1)} |`,
    `| true anomalies caught by neither | ${fmt(truthMean('neither'), 1)} |`,
    `| injected anomalies per seed | ${fmt(truthMean('total'), 0)} |`,
    '',
    '### F1 of running them together (mean over the five seeds)',
    '',
    '| arm | flags/seed | precision | recall | F1 |',
    '| --- | --- | --- | --- | --- |',
    `| IF alone, frozen threshold | ${fmt(flagsMean('iforest'), 1)} | ${fmt(precisionMean('iforest'))} | ${fmt(recallMean('iforest'))} | ${fmt(f1.iforest)} |`,
    `| v2 alone | ${fmt(flagsMean('v2'), 1)} | ${fmt(precisionMean('v2'))} | ${fmt(recallMean('v2'))} | ${fmt(f1.v2)} |`,
    `| UNION (either detector flags) | ${fmt(flagsMean('union'), 1)} | ${fmt(precisionMean('union'))} | ${fmt(recallMean('union'))} | ${fmt(f1.union)} |`,
    `| INTERSECTION (both flag) | ${fmt(flagsMean('intersection'), 1)} | ${fmt(precisionMean('intersection'))} | ${fmt(recallMean('intersection'))} | ${fmt(f1.intersection)} |`,
    '',
    '### Per seed',
    '',
    '| seed | IF F1 | v2 F1 | union F1 | intersection F1 | TP both | TP only IF | TP only v2 | TP neither |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...perSeed.map((row) => `| ${row.seed} | ${fmt(row.iforest.f1)} | ${fmt(row.v2.f1)} | ${fmt(row.union.f1)} | ${fmt(row.intersection.f1)} | ${row.truth.both} | ${row.truth.onlyIforest} | ${row.truth.onlyV2} | ${row.truth.neither} |`),
    '',
    '### Reading',
    '',
    verdict,
    '',
    `- The intersection ${intersectionBeatsBoth ? 'scores higher' : 'scores lower'} on F1 (${fmt(f1.intersection, 4)}), but at ${fmt(recallMean('intersection'))} recall against ${fmt(recallMean('v2'))} for v2 and ${fmt(recallMean('iforest'))} for IF: it fires only where both detectors agree, so any precision it gains is paid for in true anomalies missed. That describes a possible "confirmed by two methods" screen, not a detector that replaces either one — nothing is being built from it.`,
    '- The union is an upper bound on what a combined surface could show and the intersection is the lower bound. Neither is a shipped design; measuring both brackets what a two-detector screen could be worth before any wiring, schema or UI code exists.',
    '- Same limits as the hold-out section: five synthetic seeds, 36 injected multiplicative spikes each, exact-(SKU, date) matching, no labelled real data. This section is a diagnostic on spent seeds, so on its own it can neither overturn nor improve the hold-out verdict.',
    '',
    '```',
    'cd backend',
    'npm run validate:iforest -- --phase overlap   :: idempotent; rewrites only this section',
    '```',
    '',
    OVERLAP_END,
    '',
  ];
  return lines.join('\n');
}

/**
 * Runs the overlap diagnostic and replaces its delimited section in
 * iforest_results.md, leaving every other line of that report untouched.
 * @returns {Promise<void>} Resolves once the report is written.
 */
async function runOverlapPhase() {
  const config = await loadFrozenConfig(); // no hold-out guard: no threshold is chosen here
  console.log(banner('Isolation Forest — FLAG OVERLAP WITH V2 (diagnostic)'));

  const perSeed = HOLDOUT_SEEDS.map((seed) => overlapForSeed(seed, config.params.contamination));
  assertMatchesReference(summarise(perSeed, 'v2'), V2_HOLDOUT_REFERENCE, 'overlap seeds 6-10');

  const markdown = await readTextIfExists(RESULTS_MD_PATH);
  if (markdown === null) {
    abort(`${RESULTS_MD_PATH} does not exist; run --phase holdout first (this section is appended to that report)`);
  }

  const block = buildOverlapSection(config, perSeed);
  const start = markdown.indexOf(OVERLAP_START);
  let updated;
  if (start === -1) {
    // New section: place it before the reproduce block so the report still ends
    // with "how to run this", not with a diagnostic that belongs beside the results.
    const anchor = markdown.indexOf('\n## Reproduce');
    updated = anchor === -1
      ? `${markdown.replace(/\n*$/, '\n')}\n${block}`
      : `${markdown.slice(0, anchor)}\n${block}${markdown.slice(anchor + 1)}`;
  } else {
    const end = markdown.indexOf(OVERLAP_END, start);
    if (end === -1) abort(`${RESULTS_MD_PATH} has an "${OVERLAP_START}" marker with no matching "${OVERLAP_END}"; fix the file by hand`);
    // Normalise the whitespace on both sides so re-running this phase is a no-op
    // rather than adding one blank line per pass.
    const before = markdown.slice(0, start).replace(/\n*$/, '\n\n');
    const after = markdown.slice(end + OVERLAP_END.length).replace(/^\n*/, '\n');
    updated = `${before}${block.replace(/\n*$/, '\n')}${after}`;
  }
  await writeFile(RESULTS_MD_PATH, updated, 'utf8');

  for (const row of perSeed) {
    const show = (label, metrics) => console.log(
      `  seed ${String(row.seed).padEnd(2)} ${label.padEnd(13)} F1 ${fmt(metrics.f1)}  P ${fmt(metrics.precision)}  R ${fmt(metrics.recall)}  flags ${metrics.flaggedTotal}`,
    );
    show('IF', row.iforest);
    show('v2', row.v2);
    show('union', row.union);
    show('intersection', row.intersection);
    console.log(`  seed ${row.seed}   truth — both ${row.truth.both}, only IF ${row.truth.onlyIforest}, only v2 ${row.truth.onlyV2}, neither ${row.truth.neither}; flags — both ${row.flags.both}, only IF ${row.flags.onlyIforest}, only v2 ${row.flags.onlyV2}`);
  }

  console.log(banner('WROTE'));
  console.log('docs/validation/iforest_results.md → "Flag overlap with v2" section');
  console.log('frozen_config_iforest.json deliberately NOT rewritten — no parameter is chosen here.');
}

// ── Phase: real workbook sanity check ────────────────────────────────────────
const HEADER_ALIASES = {
  date: ['date', 'saledate', 'transactiondate', 'orderdate', 'invoicedate'],
  sku: ['sku', 'productsku', 'productcode', 'itemcode', 'productid'],
  units: ['quantity', 'qty', 'units', 'unitssold', 'quantitysold', 'totalquantity'],
  revenue: ['totalprice', 'linetotal', 'revenue', 'salestotal', 'grosssales', 'totalamount', 'amount'],
  unitPrice: ['unitprice', 'price', 'saleprice'],
  status: ['status', 'orderstatus', 'transactionstatus'],
};
const POS_SHEET_CANDIDATES = ['POS Sales Log', 'pos_sales_log', 'Sheet1'];

/** @returns {string} Lowercase, digits-only key for header matching. */
function normaliseHeader(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** @returns {string} YYYY-MM-DD from a local Date (no UTC shift). */
function isoFromLocalDate(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Parses one cell into an ISO date, covering the shapes a POS export uses:
 * a real Date, an Excel serial number, or a string (ISO or parseable).
 * @param {unknown} value Cell value.
 * @returns {string|null} YYYY-MM-DD, or null when the cell is not a date.
 */
function toIsoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return isoFromLocalDate(value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    const direct = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
    if (direct) return `${direct[1]}-${direct[2]}-${direct[3]}`;
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return isoFromLocalDate(parsed);
  }
  return null;
}

/** @returns {number} `value` as a finite number (0 when it is not). */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** @returns {boolean} Whether an ISO date is a Saturday or Sunday. */
function isWeekendDate(iso) {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Calendar payday heuristic. The workbook has no payroll column, so this is a
 * stated assumption, not a label: the 1st plus the last three days of a month.
 * @param {string} iso ISO date.
 * @returns {boolean} Whether the day sits in the payday window.
 */
function isPaydayWindow(iso) {
  const dayOfMonth = Number(iso.slice(8, 10));
  return dayOfMonth === 1 || dayOfMonth >= 28;
}

/**
 * Reads the POS sheet of the real workbook into (SKU, day) rows: one row per
 * product-day with SUM(quantity) and SUM(line total) — the shape the detector
 * consumes and the shape sale_transactions stores.
 * @param {string} filePath Absolute path to the .xlsx workbook.
 * @returns {Promise<{rows: Array<{productKey: string, date: string, units: number, revenue: number}>,
 *   sheetName: string, rawRows: number, keptRows: number, droppedRows: number,
 *   firstDate: string, lastDate: string, columns: object}>} Read summary.
 */
async function readRealWorkbook(filePath) {
  const workbook = XLSX.read(await readFile(filePath), { type: 'buffer', cellDates: true });
  const sheetName = POS_SHEET_CANDIDATES.find((name) => workbook.SheetNames.includes(name))
    ?? workbook.SheetNames[0];
  const sheetRows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: null, raw: true });
  if (sheetRows.length === 0) abort(`Sheet "${sheetName}" has no rows`);

  const headerKeys = Object.keys(sheetRows[0]);
  const candidates = headerKeys.map((key) => ({ key, normalised: normaliseHeader(key) }));
  // Exact match first, then prefix: a real export writes "Total Price (PKR)"
  // and "Unit Price (PKR)", which normalise to "totalpricepkr"/"unitpricepkr".
  const columnFor = (field) => {
    const aliases = HEADER_ALIASES[field];
    const exact = candidates.find((entry) => aliases.includes(entry.normalised));
    if (exact) return exact.key;
    const prefixed = candidates.find((entry) => aliases.some((alias) => entry.normalised.startsWith(alias)));
    return prefixed?.key ?? null;
  };
  const columns = {
    date: columnFor('date'),
    sku: columnFor('sku'),
    units: columnFor('units'),
    revenue: columnFor('revenue'),
    unitPrice: columnFor('unitPrice'),
    status: columnFor('status'),
  };
  for (const required of ['date', 'sku', 'units']) {
    if (!columns[required]) {
      abort(`Could not find a ${required} column in "${sheetName}". Headers: ${headerKeys.join(', ')}`);
    }
  }
  const usedHeaders = Object.values(columns).filter(Boolean);
  if (new Set(usedHeaders).size !== usedHeaders.length) {
    abort(`Two fields resolved to the same column in "${sheetName}" (${usedHeaders.join(', ')}); refusing to guess. Headers: ${headerKeys.join(', ')}`);
  }

  const byKey = new Map();
  let keptRows = 0;
  let droppedRows = 0;
  for (const raw of sheetRows) {
    const date = toIsoDate(raw[columns.date]);
    const sku = String(raw[columns.sku] ?? '').trim();
    const units = toNumber(raw[columns.units]);
    const status = columns.status ? String(raw[columns.status] ?? '').trim().toUpperCase() : '';
    if (status && status !== 'COMPLETED') { droppedRows += 1; continue; }
    if (date === null || sku === '' || units <= 0) { droppedRows += 1; continue; }

    const lineRevenue = columns.revenue ? toNumber(raw[columns.revenue]) : 0;
    const unitPrice = columns.unitPrice ? toNumber(raw[columns.unitPrice]) : 0;
    const revenue = lineRevenue > 0 ? lineRevenue : units * unitPrice;

    const key = `${sku}\u0000${date}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.units += units;
      existing.revenue += revenue;
    } else {
      byKey.set(key, { productKey: sku, date, units, revenue });
    }
    keptRows += 1;
  }

  const rows = [...byKey.values()].sort((a, b) => (
    a.date < b.date ? -1 : a.date > b.date ? 1 : a.productKey.localeCompare(b.productKey)
  ));
  if (rows.length === 0) abort(`No usable (SKU, day) rows in "${sheetName}"`);

  return {
    rows,
    sheetName,
    rawRows: sheetRows.length,
    keptRows,
    droppedRows,
    firstDate: rows[0].date,
    lastDate: rows[rows.length - 1].date,
    columns,
    hasRevenue: Boolean(columns.revenue || columns.unitPrice),
  };
}

const REAL_REPORT_LIMIT = 30;

/**
 * Fits ONE forest on the real workbook and writes the manager-facing review list.
 * No labels exist in this data, so the report measures nothing but which days the
 * detector ranks highest and how often they land on a weekend / payday window.
 * @param {string} inputPath Path to the workbook.
 * @returns {Promise<void>}
 */
async function runRealPhase(inputPath) {
  if (!inputPath) abort('--phase real needs --input "<path to the workbook>"');
  const config = await loadFrozenConfig();
  const read = await readRealWorkbook(inputPath);
  const detection = detectAnomalies(read.rows, { ...DEFAULT_IFOREST_PARAMS, contamination: config.params.contamination });

  console.log(banner('Isolation Forest — real workbook sanity check'));
  console.log(`${read.sheetName}: ${read.rawRows} raw rows → ${read.keptRows} usable lines → ${read.rows.length} (SKU, day) rows`);
  console.log(`${read.firstDate} .. ${read.lastDate} · ${detection.productCount} products · ${detection.skippedProducts} skipped (too little history)`);
  console.log(`featurised product-days: ${detection.sampleCount} · flagged ${detection.flagged.length} at contamination ${config.params.contamination} (threshold ${fmt(detection.threshold, 4)})`);

  if (detection.model === null || detection.flagged.length === 0) {
    abort('The forest flagged nothing on this workbook — nothing to report. Check history length and contamination.');
  }

  const ranked = [...detection.flagged].sort((a, b) => (
    b.score - a.score || a.productKey.localeCompare(b.productKey) || a.date.localeCompare(b.date)
  ));
  const shown = ranked.slice(0, REAL_REPORT_LIMIT);

  const weekendFlags = ranked.filter((day) => isWeekendDate(day.date)).length;
  const paydayFlags = ranked.filter((day) => isPaydayWindow(day.date)).length;
  const weekendBase = detection.dates.filter(isWeekendDate).length;
  const paydayBase = detection.dates.filter(isPaydayWindow).length;

  await mkdir(DOCS_DIR, { recursive: true });
  await writeFile(
    REAL_FLAGS_PATH,
    buildRealFlagsMarkdown(config, read, detection, shown, ranked.length, {
      weekendFlags,
      paydayFlags,
      weekendBase,
      paydayBase,
    }),
    'utf8',
  );
  console.log(`\nwrote docs/validation/iforest_real_flags.md (top ${shown.length} of ${ranked.length} flags)`);
  console.log(`weekend flags ${weekendFlags}/${ranked.length} (base rate ${weekendBase}/${detection.dates.length} days) · payday-window flags ${paydayFlags}/${ranked.length} (base ${paydayBase}/${detection.dates.length})`);
}

/**
 * Renders docs/validation/iforest_real_flags.md.
 * @param {object} config Frozen config.
 * @param {object} read Output of readRealWorkbook.
 * @param {object} detection Output of detectAnomalies.
 * @param {Array<object>} shown Flags to print (already ranked).
 * @param {number} flagTotal Total flags at the frozen threshold.
 * @param {{weekendFlags: number, paydayFlags: number, weekendBase: number, paydayBase: number}} counts
 *   Calendar context counts.
 * @returns {string} Markdown body.
 */
function buildRealFlagsMarkdown(config, read, detection, shown, flagTotal, counts) {
  const rows = shown.map((day, index) => {
    const [units, revenue, residual, ratio] = day.features;
    const unitsCell = Number.isInteger(units) ? String(units) : units.toFixed(2);
    const revenueCell = read.hasRevenue ? revenue.toFixed(2) : 'n/a';
    return `| ${index + 1} | ${day.productKey} | ${day.date} | ${unitsCell} | ${revenueCell} | ${residual.toFixed(2)} | ${ratio.toFixed(2)} | ${day.score.toFixed(4)} | ${isWeekendDate(day.date) ? 'yes' : ''} | ${isPaydayWindow(day.date) ? 'yes' : ''} |  |`;
  });

  return [
    '# Isolation Forest — real workbook flag list (unlabelled)',
    '',
    `Generated by \`${config.harness} --phase real\` with the frozen parameters (contamination ${config.params.contamination}, ${config.params.treeCount} trees, seed ${config.params.seed}).`,
    '',
    '**This file contains no accuracy claim.** The workbook has no anomaly labels, so nothing here can be scored. It exists to answer one question: on real shop data, does the detector surface product-days a manager would recognise as worth a look?',
    '',
    '## Input',
    '',
    `- sheet \`${read.sheetName}\`: ${read.rawRows} raw rows → ${read.keptRows} usable POS lines → ${read.rows.length} (SKU, day) aggregates`,
    `- window ${read.firstDate} .. ${read.lastDate}; columns ${Object.entries(read.columns).filter(([, value]) => value).map(([field, header]) => `${field}=\`${header}\``).join(', ')}`,
    `- dropped ${read.droppedRows} rows (no parseable date, no SKU, quantity ≤ 0, or Status ≠ COMPLETED)`,
    `- ${detection.productCount} products featurised, ${detection.skippedProducts} skipped for having under ${config.params.historyDays} days of history`,
    `- ${detection.sampleCount} featurised product-days, **${flagTotal} flagged** at threshold ${fmt(detection.threshold, 4)}`,
    read.hasRevenue
      ? '- revenue = the day\'s SUM of line totals (falling back to quantity × unit price when a line total is missing)'
      : '- **no price column was found, so revenue is constant 0**: the revenue feature carries no signal here and the forest is ranking on units, weekday residual and ratio alone',
    '',
    '## Flags, highest score first',
    '',
    '| # | SKU | date | units | revenue | residual vs weekday mean | ratio to prev-14d mean | score | weekend | payday window | manager confirmed? |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    shown.length < flagTotal
      ? `Only the top ${shown.length} of ${flagTotal} flags are listed; the rest score lower.`
      : `All ${flagTotal} flags are listed.`,
    '',
    'The last column is deliberately empty: only someone who knows the shop can say whether a flag was a real event (promo, spoilage, stockout, data-entry error) or noise. Filled in, this table becomes a labelled sample.',
    '',
    '## Calendar context',
    '',
    '| | flags | share of flags | days in data | day base rate |',
    '| --- | --- | --- | --- | --- |',
    `| weekend (Sat/Sun) | ${counts.weekendFlags}/${flagTotal} | ${fmt(counts.weekendFlags / flagTotal, 3)} | ${counts.weekendBase}/${detection.dates.length} | ${fmt(counts.weekendBase / detection.dates.length, 3)} |`,
    `| payday window (1st, 28th–end) | ${counts.paydayFlags}/${flagTotal} | ${fmt(counts.paydayFlags / flagTotal, 3)} | ${counts.paydayBase}/${detection.dates.length} | ${fmt(counts.paydayBase / detection.dates.length, 3)} |`,
    '',
    'The payday window is a CALENDAR HEURISTIC, not data: the workbook has no payroll column, so "1st plus the last three days of the month" is an assumption about this shop, and the comparison with the day base rate is the only thing that makes it meaningful.',
    '',
    '## Caveats',
    '',
    `- ${config.params.historyDays} days of history are consumed as warm-up, so on a 35-day workbook only the last ~21 days per product can ever be flagged. A short flag list is not evidence that the shop was calm.`,
    '- `units` 0 with `ratio` 0 is a zero-sale day: the calendar is filled per product, so "this product did not sell at all" is a first-class anomaly and appears in this list.',
    '- Contamination fixes how many days get flagged; it does not test whether they were anomalous. A different contamination moves the cut-off, not the ranking.',
    '- `revenue` is an absolute feature and ONE model covers all products, so a permanently high-priced item lives at an extreme revenue value. SKU-123 on 2026-09-15 and 2026-09-26 is that effect: 18 units but 26,100 revenue, an elevated ratio and residual, and an extreme absolute revenue. Read a revenue-driven flag as "this product sits at the edge of the revenue distribution", not automatically as a bad day.',
    '- Features are tenant-local: units, that day\'s revenue, the deviation from the same weekday\'s recent mean, and the ratio to the previous 14-day mean. Price changes and promotions show up as revenue deviations by design.',
    '',
    '## Reproduce',
    '',
    '```',
    'cd backend',
    'npm run validate:iforest -- --phase real --input "<path to the workbook.xlsx>"',
    '```',
    '',
  ].join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────────
const USAGE = [
  'Usage: node scripts/validation/runIsolationForestValidation.js --phase <dev|freeze|holdout|overlap|real>',
  '  --phase dev       tune contamination on seeds 1-5 (writes nothing)',
  '  --phase freeze    write docs/validation/frozen_config_iforest.json',
  '  --phase holdout   score held-out seeds 6-10 once (needs the frozen config)',
  '  --phase overlap   flag overlap vs v2 on the same seeds (appends one section)',
  '  --phase real      --input "<workbook.xlsx>" sanity-check real flags',
  '  --force           allow overwriting a frozen config / re-reading the hold-out',
].join('\n');

async function main() {
  const phase = argValue('--phase') ?? 'dev';
  const force = hasFlag('--force');

  if (phase === 'dev') {
    await runDevPhase();
    console.log('\nNothing written. Next: --phase freeze (writes the protocol) — do not tune again after that.');
    return;
  }
  if (phase === 'freeze') {
    await runFreezePhase(force);
    return;
  }
  if (phase === 'holdout') {
    await runHoldoutPhase(force);
    return;
  }
  if (phase === 'overlap') {
    await runOverlapPhase();
    return;
  }
  if (phase === 'real') {
    await runRealPhase(argValue('--input'));
    return;
  }
  abort(`Unknown --phase "${phase}".\n${USAGE}`);
}

main().catch((error) => {
  console.error(`\n❌ ${error.message}\n`);
  process.exit(1);
});

