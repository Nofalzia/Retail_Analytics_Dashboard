/**
 * services/rollingZScore.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Pure rolling z-score detector (v2).
 *
 * Fixes the self-masking flaw of the v1 logic in detectionEngine.js: v1 computed
 * ONE mean/σ over a window and then tested the days inside that same window
 * against it, so an anomaly diluted its own z-score. It also could not see
 * zero-sale days because the product_daily_velocity view only contains days that
 * had sales.
 *
 * v2 builds, for every evaluated day, a baseline from the PREVIOUS windowDays
 * calendar days only — the day under test is never part of its own baseline —
 * zero-fills calendar days with no sales, and applies a counting-noise (Poisson)
 * floor to σ so that a suspiciously flat baseline cannot produce huge z-scores.
 *
 * Pure module: no database access, no randomness, no side effects. Fully
 * unit-testable (see scripts/validation/rollingZScore.selftest.js).
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Default detection parameters (single source of truth for the engine).
 *
 * windowDays                — calendar days of history used as each day's
 *                             baseline (14 = two full retail weeks; balances
 *                             sensitivity against weekend-driven variance).
 * minBaselineDays           — minimum calendar days that must have elapsed since
 *                             the product's first sale before a day is scored at
 *                             all (new products get no meaningless statistics).
 * zAlert                    — |z| at/above which a day is a candidate anomaly
 *                             (2.5 ≈ the 99th percentile of a normal baseline).
 * minRelativeDeviation      — required |observed − mean| / max(mean, 1); stops
 *                             changes that are statistically large but
 *                             commercially tiny on high-volume products.
 * minAbsoluteDeviationUnits — required |observed − mean| in whole units; stops
 *                             low-volume counting noise from being reported.
 * sdFloorMode               — 'poisson': σ is floored at sqrt(max(mean, 1)), the
 *                             counting-noise standard deviation, so a flat
 *                             baseline cannot yield an arbitrary z-score.
 *                             'none': use the raw sample σ.
 */
export const DEFAULT_PARAMS = {
  windowDays: 14,
  minBaselineDays: 7,
  zAlert: 2.5,
  minRelativeDeviation: 0.25,
  minAbsoluteDeviationUnits: 3,
  sdFloorMode: 'poisson',
};

/** @returns {number} Arithmetic mean of a list (0 for an empty list). */
function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** @returns {number} Sample standard deviation (divides by N-1; 0 for < 2 values). */
function sampleStdDev(values, mu) {
  if (values.length < 2) return 0;
  let sumSquares = 0;
  for (const value of values) sumSquares += (value - mu) ** 2;
  return Math.sqrt(sumSquares / (values.length - 1));
}

/** @returns {string} The ISO date (YYYY-MM-DD) shifted by `deltaDays`. */
function shiftIsoDate(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/** @returns {number} Whole calendar days from `fromIso` to `toIso`. */
function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** @returns {boolean} Whether a Map or plain object contains `date`. */
function hasDate(dailyUnitsByDate, date) {
  return dailyUnitsByDate instanceof Map
    ? dailyUnitsByDate.has(date)
    : Object.prototype.hasOwnProperty.call(dailyUnitsByDate, date);
}

/** @returns {number} The units recorded for `date` (0 when absent). */
function getUnits(dailyUnitsByDate, date) {
  const value = dailyUnitsByDate instanceof Map
    ? dailyUnitsByDate.get(date)
    : dailyUnitsByDate[date];
  return value === undefined ? 0 : Number(value);
}

/**
 * Scores one observed day against an explicit baseline of prior daily units.
 * The baseline must EXCLUDE the observed day.
 * @param {number[]} baselineUnits Prior daily unit counts (already zero-filled).
 * @param {number} observedUnits Units sold on the day under test.
 * @param {object} [params] Detection parameters (defaults to DEFAULT_PARAMS).
 * @returns {{z: number, mean: number, sd: number, relativeDeviation: number,
 *   flagged: boolean, direction: 'up'|'down'}} Day score. `sd` is the sample
 *   standard deviation, floored by the Poisson counting-noise rule when
 *   `sdFloorMode === 'poisson'`. `flagged` is true only when |z| >= zAlert AND
 *   the relative AND absolute deviation guards all pass.
 */
export function scoreDay(baselineUnits, observedUnits, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const mu = mean(baselineUnits);
  let sd = sampleStdDev(baselineUnits, mu);
  if (p.sdFloorMode === 'poisson') {
    // Counting-noise floor: for a mean count μ the variance of the count itself
    // is ~μ, so σ can never be materially below sqrt(μ). Clamp μ at 1 so that a
    // baseline of all zeros still cannot create a division by zero.
    sd = Math.max(sd, Math.sqrt(Math.max(mu, 1)));
  }

  const diff = observedUnits - mu;
  const relativeDeviation = Math.abs(diff) / Math.max(mu, 1);
  // A zero σ can only occur with sdFloorMode 'none' and a perfectly constant
  // baseline; there is no statistical evidence to flag, so z is defined as 0.
  const z = sd === 0 ? 0 : diff / sd;

  const flagged =
    Math.abs(z) >= p.zAlert &&
    relativeDeviation >= p.minRelativeDeviation &&
    Math.abs(diff) >= p.minAbsoluteDeviationUnits;

  return { z, mean: mu, sd, relativeDeviation, flagged, direction: diff >= 0 ? 'up' : 'down' };
}

/**
 * Scores every evaluated date of one product against its own rolling baseline.
 * For each date the baseline is the PREVIOUS `windowDays` calendar days,
 * zero-filling calendar days with no sales (so a "drop to zero" is visible).
 * Calendar days that fall before `firstSaleDate` are ignored — the product did
 * not exist yet, so they are not real zero-sale days. A date is skipped
 * entirely when fewer than `minBaselineDays` calendar days have elapsed since
 * `firstSaleDate`.
 * @param {Map<string, number>|Object<string, number>} dailyUnitsByDate Units per
 *   ISO date. Only days WITH sales need to be present; missing days are treated
 *   as 0 unless `zeroFill` is explicitly false.
 * @param {string} firstSaleDate ISO date (YYYY-MM-DD) of the product's first sale.
 * @param {string[]} evalDates ISO dates to evaluate, in ascending order.
 * @param {object} [params] Detection parameters; an extra `zeroFill` boolean
 *   (default true) turns the zero-filling of no-sale baseline days on/off.
 * @returns {Array<{date: string, observedUnits: number, z: number, mean: number,
 *   sd: number, relativeDeviation: number, flagged: boolean, direction: 'up'|'down'}>}
 *   One entry per scored day; skipped dates are simply absent.
 */
export function scoreSeries(dailyUnitsByDate, firstSaleDate, evalDates, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const zeroFill = p.zeroFill !== false;
  const scored = [];

  for (const date of evalDates) {
    if (daysBetween(firstSaleDate, date) < p.minBaselineDays) continue;

    const baselineUnits = [];
    for (let offset = p.windowDays; offset >= 1; offset--) {
      const baselineDate = shiftIsoDate(date, -offset);
      if (baselineDate < firstSaleDate) continue; // product did not exist yet
      if (hasDate(dailyUnitsByDate, baselineDate)) {
        baselineUnits.push(getUnits(dailyUnitsByDate, baselineDate));
      } else if (zeroFill) {
        baselineUnits.push(0);
      }
    }

    const observedUnits = getUnits(dailyUnitsByDate, date);
    const score = scoreDay(baselineUnits, observedUnits, p);
    scored.push({ date, observedUnits, ...score });
  }

  return scored;
}

/**
 * Maps a z-score to an alert severity, relative to the configured zAlert.
 * @param {number} z Signed z-score.
 * @param {object} [params] Detection parameters (defaults to DEFAULT_PARAMS).
 * @returns {'info'|'warning'|'critical'} critical when |z| >= zAlert + 1.5,
 *   warning when |z| >= zAlert + 0.5, otherwise info.
 */
export function severityFor(z, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const absZ = Math.abs(z);
  if (absZ >= p.zAlert + 1.5) return 'critical';
  if (absZ >= p.zAlert + 0.5) return 'warning';
  return 'info';
}
