/**
 * backend/scripts/validation/holtWinters.selftest.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Dependency-free self-test for services/holtWinters.js and the pure parts of
 * services/forecastService.js (series building, velocity window, engine flag).
 *
 * Run from backend/:  npm run test:holt-winters
 * Exits 1 if any assertion fails.
 *
 * The assertions cover the properties the dashboard relies on:
 *   1. a flat series forecasts the same flat value,
 *   2. a repeating weekly pattern is reproduced exactly one week ahead,
 *   3. too little history is refused instead of fitted,
 *   4. forecasts are never negative, even on a collapsing series,
 *   5. an all-zero series forecasts zeros (no NaN),
 *   6. two identical calls give identical output (deterministic),
 *   7. the contiguous series zero-fills gaps and drops pre-launch days,
 *   8. the velocity average matches SUM(units) / N over [asOf−N, asOf−1],
 *   9. FORECAST_ENGINE parsing never switches engine on a typo.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import {
  MIN_HISTORY_DAYS,
  SEASON_LENGTH,
  fitHoltWinters,
  forecastHoltWinters,
  isScorableSeries,
  selectParams,
} from '../../src/services/holtWinters.js';
import {
  buildContiguousSeries,
  resolveForecastEngine,
  velocityAverage,
} from '../../src/services/forecastService.js';

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

/** @returns {boolean} Every value is within `tolerance` of `expected`. */
function allClose(actual, expected, tolerance = 1e-6) {
  return actual.length === expected.length
    && actual.every((value, i) => Math.abs(value - expected[i]) <= tolerance);
}

/** @returns {string} ISO date `offset` days after `startIso` (UTC-safe). */
function isoDate(startIso, offset) {
  const date = new Date(`${startIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

console.log('holtWinters self-test');

// ── 1. A flat series forecasts the same flat value ────────────────────────────
{
  const series = new Array(28).fill(10);
  const result = forecastHoltWinters(series, SEASON_LENGTH);
  check('flat series (10/day) -> forecasts 10/day', allClose(result.forecast, new Array(7).fill(10)));
}

// ── 2. A repeating weekly pattern is reproduced one week ahead ────────────────
{
  const pattern = [10, 12, 14, 16, 18, 20, 22];
  const series = Array.from({ length: 28 }, (_unused, i) => pattern[i % SEASON_LENGTH]);
  const result = forecastHoltWinters(series, SEASON_LENGTH);
  check('repeating weekly pattern -> same pattern next week', allClose(result.forecast, pattern));
  check('model keeps exactly one season of seasonal factors',
    fitHoltWinters(series).seasonals.length === SEASON_LENGTH);
}

// ── 3. Too little history is refused, not fitted ──────────────────────────────
{
  const short = new Array(MIN_HISTORY_DAYS - 1).fill(7);
  check('13 days of history -> not scorable', isScorableSeries(short) === false);
  check('13 days of history -> no forecast (caller falls back)',
    forecastHoltWinters(short, SEASON_LENGTH) === null);
}

// ── 4. Forecasts are never negative ───────────────────────────────────────────
{
  const collapsing = [...new Array(21).fill(20), ...new Array(7).fill(0)];
  const result = forecastHoltWinters(collapsing, SEASON_LENGTH);
  check('collapsing series -> every forecast is finite and >= 0',
    result.forecast.every((value) => Number.isFinite(value) && value >= 0));
}

// ── 5. An all-zero series forecasts zeros, deterministically ──────────────────
{
  const zeros = new Array(28).fill(0);
  const result = forecastHoltWinters(zeros, SEASON_LENGTH);
  const picked = selectParams(zeros);
  const pickedAgain = selectParams(zeros);
  check('all-zero series -> zero forecast, no NaN',
    result.forecast.every((value) => value === 0));
  check('an all-zero series ties every parameter set -> first grid hit wins',
    picked.sse === 0 && pickedAgain.params.alpha === picked.params.alpha
      && pickedAgain.params.beta === picked.params.beta
      && pickedAgain.params.gamma === picked.params.gamma);
}

// ── 6. Determinism ────────────────────────────────────────────────────────────
{
  const series = [4, 6, 5, 9, 12, 7, 3, 5, 7, 6, 10, 13, 8, 4, 6, 8, 7, 11, 14, 9, 5, 7, 9, 8, 12, 15, 10, 5];
  const first = forecastHoltWinters(series, SEASON_LENGTH);
  const second = forecastHoltWinters(series, SEASON_LENGTH);
  check('identical input -> identical forecast and parameters',
    JSON.stringify(first.forecast) === JSON.stringify(second.forecast)
      && JSON.stringify(first.params) === JSON.stringify(second.params));
  check('selected parameters lie inside the documented grid',
    first.params.alpha > 0 && first.params.alpha <= 1
      && first.params.beta >= 0 && first.params.beta <= 1
      && first.params.gamma > 0 && first.params.gamma <= 1);
}

// ── 7. Contiguous series: gaps become zeros, pre-launch days disappear ────────
{
  const units = new Map([['2026-09-05', 5]]);
  const series = buildContiguousSeries(units, '2026-09-01', '2026-09-07', '2026-09-04');
  check('series starts at the first sale, not the window start',
    series.dates[0] === '2026-09-04' && series.dates.length === 4);
  check('a calendar day with no sale is a zero, not a gap',
    JSON.stringify(series.values) === JSON.stringify([0, 5, 0, 0]));
  check('window end (the as-of date) is included',
    series.dates[series.dates.length - 1] === '2026-09-07');
}

// ── 8. Velocity window: [asOf − N, asOf − 1], divided by N ────────────────────
{
  const dates = Array.from({ length: 28 }, (_unused, i) => isoDate('2026-09-01', i));
  const values = dates.map((date) => {
    if (date === '2026-09-13') return 100; // one day before the window
    if (date === '2026-09-14') return 3;   // first day inside the window
    if (date === '2026-09-27') return 4;   // last day inside the window
    if (date === '2026-09-28') return 100; // the as-of date itself
    return 0;
  });
  const average = velocityAverage({ dates, values }, '2026-09-28', 14);
  check('velocity = SUM(units in window) / 14, excluding the as-of day',
    Math.abs(average - 0.5) < 1e-12);
}

// ── 9. FORECAST_ENGINE parsing ────────────────────────────────────────────────
{
  check("FORECAST_ENGINE='holt_winters' -> holt_winters",
    resolveForecastEngine('holt_winters') === 'holt_winters');
  check('case and padding are ignored',
    resolveForecastEngine('  HOLT_WINTERS ') === 'holt_winters');
  check("an unknown value -> 'velocity' (safe default)",
    resolveForecastEngine('xgboost') === 'velocity' && resolveForecastEngine('') === 'velocity');
}

if (failures === 0) {
  console.log('\n✅ holtWinters self-test passed');
} else {
  console.error(`\n❌ holtWinters self-test failed (${failures} assertion(s))`);
  process.exitCode = 1;
}

