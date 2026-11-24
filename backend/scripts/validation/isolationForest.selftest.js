/**
 * backend/scripts/validation/isolationForest.selftest.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Tiny dependency-free self-test for services/isolationForest.js.
 *
 * Run from backend/:  npm run test:iforest
 * Exits 1 if any assertion fails.
 *
 * The assertions are:
 *   1. an injected spike is the top-ranked day and is flagged,
 *   2. the same data + seed fits an identical forest (determinism), a different
 *      seed changes the scores but still ranks the spike first,
 *   3. empty / too-short input yields null instead of a confident model,
 *   4. every sample carries the four documented features and the spike's
 *      residual / ratio features are the ones you would expect,
 *   5. `contamination` flags approximately that fraction of the fitted rows,
 *   6. every score lies in [0, 1] and the budget tie-break is deterministic,
 *   7. featurising starts only once 14 calendar days of history exist.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import {
  DEFAULT_IFOREST_PARAMS,
  FEATURE_NAMES,
  buildFeatureSamples,
  detectAnomalies,
  fitIsolationForest,
  scoreIsolationForest,
  topScoredDays,
} from '../../src/services/isolationForest.js';
import { createPrng } from './prng.js';

let failures = 0;

/** @throws never — records and prints the outcome of one assertion. */
function check(name, condition) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

/** @returns {string[]} ISO dates from `startIso`, `count` days long. */
function dateRange(startIso, count) {
  const out = [];
  const base = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Builds a deterministic product-day dataset: `products` SKUs selling around
 * 10 units/day with N(0, 3) noise, plus one injected spike.
 * @param {{seed: number, products?: number, days?: number, spikeAt?: number|null}} options
 * @returns {{rows: Array<{productKey: string, date: string, units: number, revenue: number}>,
 *   dates: string[], spikeDate: string|null}}
 */
function buildMarketDays({ seed, products = 6, days = 60, spikeAt = null }) {
  const prng = createPrng(seed);
  const dates = dateRange('2026-01-01', days);
  const spikeDate = spikeAt === null ? null : dates[spikeAt];
  const rows = [];

  for (let product = 1; product <= products; product += 1) {
    const productKey = `SKU-${String(product).padStart(2, '0')}`;
    for (const date of dates) {
      let units = Math.max(0, Math.round(10 + 3 * prng.normal()));
      if (date === spikeDate && productKey === 'SKU-01') units += 60;
      if (units === 0) continue; // the DB cannot hold a zero-unit sale row
      rows.push({ productKey, date, units, revenue: units * 100 });
    }
  }

  return { rows, dates, spikeDate };
}

console.log('isolationForest self-test');

const market = buildMarketDays({ seed: 7, spikeAt: 29 });
const detection = detectAnomalies(market.rows, DEFAULT_IFOREST_PARAMS);

// ── 1. An injected spike is the top-ranked day and is flagged ─────────────────
{
  const best = detection.scored.reduce((a, b) => (b.score > a.score ? b : a));
  check('spike is the top-ranked day',
    best.productKey === 'SKU-01' && best.date === market.spikeDate);
  check('spike is flagged at the fitted threshold',
    detection.flagged.some((d) => d.productKey === 'SKU-01' && d.date === market.spikeDate));
}

// ── 2. Determinism, and seed sensitivity that does not move the top row ───────
{
  const again = detectAnomalies(market.rows, DEFAULT_IFOREST_PARAMS);
  const identical = detection.scored.length === again.scored.length
    && detection.scored.every((day, i) => day.score === again.scored[i].score);
  check('same data + seed -> identical scores', identical);

  const reseeded = detectAnomalies(market.rows, { ...DEFAULT_IFOREST_PARAMS, seed: 99 });
  const changed = reseeded.scored.some((day, i) => day.score !== detection.scored[i].score);
  const reseededBest = reseeded.scored.reduce((a, b) => (b.score > a.score ? b : a));
  check('different seed -> different scores, same top row',
    changed && reseededBest.productKey === 'SKU-01' && reseededBest.date === market.spikeDate);
}

// ── 3. Empty / short input yields null, never a confident model ───────────────
{
  check('fit([]) -> null', fitIsolationForest([], DEFAULT_IFOREST_PARAMS) === null);

  const tooFew = Array.from({ length: DEFAULT_IFOREST_PARAMS.minSamples - 1 }, (_, i) => [i, i * 2, 0, 1]);
  check('29 rows with minSamples 30 -> null', fitIsolationForest(tooFew, DEFAULT_IFOREST_PARAMS) === null);

  check('score(null model) -> null', scoreIsolationForest(null, [1, 2, 3, 4]) === null);

  const shortSeries = buildMarketDays({ seed: 3, days: 10 });
  const shortDetection = detectAnomalies(shortSeries.rows, DEFAULT_IFOREST_PARAMS);
  check('10-day history -> no model and no flags',
    shortDetection.model === null && shortDetection.scored.length === 0);
}

// ── 4. Feature columns and the spike's expected feature values ────────────────
{
  const { samples } = buildFeatureSamples(market.rows, DEFAULT_IFOREST_PARAMS);
  const widthOk = samples.every((sample) => sample.features.length === FEATURE_NAMES.length);
  check('every sample has 4 features', widthOk && FEATURE_NAMES.length === 4);
  check('featurising starts on day 15 of the calendar',
    samples[0].date === market.dates[DEFAULT_IFOREST_PARAMS.historyDays]);

  const spike = samples.find((s) => s.productKey === 'SKU-01' && s.date === market.spikeDate);
  const [, revenue, residual, ratio] = spike.features;
  check('spike features: revenue = 100 x units, residual > 20, ratio > 2',
    revenue > 0 && residual > 20 && ratio > 2);
}

// ── 5. `contamination` flags roughly that fraction ────────────────────────────
{
  const model = fitIsolationForest(detection.scored.map((day) => day.features), {
    ...DEFAULT_IFOREST_PARAMS,
    contamination: 0.05,
  });
  const expected = 0.05 * model.trainedOn;
  check('contamination 0.05 -> ~5% of rows flagged',
    Math.abs(model.flaggedOnTraining - expected) <= 1);
}

// ── 6. Score range and deterministic budget tie-break ────────────────────────
{
  const inRange = detection.scored.every((day) => day.score >= 0 && day.score <= 1);
  check('every score is in [0, 1]', inRange && detection.flagged.length > 0);

  const tied = [
    { productKey: 'B', date: '2026-01-02', score: 0.5 },
    { productKey: 'A', date: '2026-01-03', score: 0.5 },
    { productKey: 'A', date: '2026-01-01', score: 0.5 },
    { productKey: 'C', date: '2026-01-01', score: 0.9 },
  ];
  const top = topScoredDays(tied, 3).map((day) => `${day.productKey}|${day.date}`).join(',');
  check('budget tie-break: score desc, then productKey, then date',
    top === 'C|2026-01-01,A|2026-01-01,A|2026-01-03');
  check('budget larger than the list is harmless', topScoredDays(tied, 99).length === tied.length);
}

if (failures === 0) {
  console.log('\n✅ isolationForest self-test passed');
} else {
  console.error(`\n❌ isolationForest self-test failed (${failures} assertion(s))`);
  process.exitCode = 1;
}
