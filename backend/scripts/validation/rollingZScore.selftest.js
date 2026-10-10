/**
 * backend/scripts/validation/rollingZScore.selftest.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Tiny dependency-free self-test for services/rollingZScore.js (v2).
 *
 * Run from backend/:  npm run test:zscore
 * Exits 1 if any of the five assertions fails.
 *
 * The five assertions are:
 *   1. a constant series is never flagged,
 *   2. a clear spike is flagged,
 *   3. zero-filling no-sale baseline days lowers the baseline mean,
 *   4. a product with too little history ("new product") is skipped,
 *   5. the direction sign is 'up' for a spike and 'down' for a drop.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { DEFAULT_PARAMS, scoreDay, scoreSeries } from '../../src/services/rollingZScore.js';

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

/** @returns {Map<string, number>} A map with `units` on every one of `dates`. */
function constantMap(dates, units) {
  const map = new Map();
  for (const date of dates) map.set(date, units);
  return map;
}

/** @returns {string[]} ISO dates from `startIso`, `count` days long. */
function dateRange(startIso, count) {
  const out = [];
  const base = new Date(`${startIso}T00:00:00Z`);
  for (let i = 0; i < count; i++) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

console.log('rollingZScore self-test');

// ── 1. Constant series is never flagged ───────────────────────────────────────
{
  const days = dateRange('2026-01-01', 30);
  const map = constantMap(days, 10);
  const scored = scoreSeries(map, '2026-01-01', days, DEFAULT_PARAMS);
  check('constant series -> never flagged', scored.length > 0 && scored.every((d) => !d.flagged));
}

// ── 2. A clear spike is flagged ───────────────────────────────────────────────
{
  const baseline = new Array(DEFAULT_PARAMS.windowDays).fill(10);
  const spike = scoreDay(baseline, 30, DEFAULT_PARAMS);
  check('clear spike (30 vs baseline 10) -> flagged', spike.flagged === true);
}

// ── 3. Zero-filling no-sale baseline days lowers the mean ─────────────────────
{
  // Only two baseline days have sales; the other twelve are absent -> zeros.
  const map = new Map([
    ['2026-03-13', 10],
    ['2026-03-14', 10],
  ]);
  const filled = scoreSeries(map, '2026-03-01', ['2026-03-15'], DEFAULT_PARAMS)[0];
  const unfilled = scoreSeries(map, '2026-03-01', ['2026-03-15'], {
    ...DEFAULT_PARAMS,
    zeroFill: false,
  })[0];
  check('zero-fill lowers the baseline mean', filled.mean < unfilled.mean);
}

// ── 4. A new product (too little history) is skipped ──────────────────────────
{
  const map = new Map([['2026-03-13', 10]]);
  const scored = scoreSeries(map, '2026-03-12', ['2026-03-15'], DEFAULT_PARAMS);
  check('new product (3 days of history) -> skipped', scored.length === 0);
}

// ── 5. Direction sign ─────────────────────────────────────────────────────────
{
  const baseline = new Array(DEFAULT_PARAMS.windowDays).fill(10);
  const spike = scoreDay(baseline, 30, DEFAULT_PARAMS);
  const drop = scoreDay(baseline, 0, DEFAULT_PARAMS);
  check("direction is 'up' for a spike and 'down' for a drop",
    spike.direction === 'up' && drop.direction === 'down');
}

if (failures === 0) {
  console.log('\n✅ rollingZScore self-test passed (5/5)');
} else {
  console.error(`\n❌ rollingZScore self-test failed (${failures} assertion(s))`);
  process.exitCode = 1;
}
