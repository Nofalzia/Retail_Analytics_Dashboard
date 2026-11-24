/**
 * services/holtWinters.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Holt-Winters triple exponential smoothing (additive) for daily demand.
 *
 * One contiguous daily series in — numbers out. This module knows nothing about
 * SQL, Express or tenants, which is what makes it unit-testable
 * (scripts/validation/holtWinters.selftest.js) and lets the Phase 2 backtest run
 * the exact same estimator the API serves.
 *
 * Why this method: retail demand is level + trend + a repeating weekday shape,
 * and four weeks of history are enough for four seasonal cycles. It is
 * deterministic, needs no library and no data beyond the product's own past.
 *
 * Initialisation (standard additive form):
 *   level    = mean of season 1
 *   trend    = (mean of season 2 − mean of season 1) / season length
 *   seasonal = y[i] − level, for every day of season 1
 * then one pass over the remaining days updates level / trend / seasonal. The
 * one-step-ahead squared error of that pass is the ONLY fitting criterion used.
 *
 * Parameter selection is a grid search over PARAM_GRID minimising that SSE,
 * evaluated only on the series handed in. The caller decides how much history
 * to hand in, which is what keeps a sealed hold-out sealed: a fold can only ever
 * see its own training days.
 *
 * Forecasts are clipped at 0: units sold cannot be negative, and a negative
 * daily demand would turn a days-of-cover figure negative as well.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** One retail week. Season length of the seasonal component. */
export const SEASON_LENGTH = 7;

/** Minimum history: two full seasons, i.e. the two weeks the init needs. */
export const MIN_HISTORY_DAYS = SEASON_LENGTH * 2;

/**
 * Smoothing parameters used when no grid search is asked for.
 * Provisional until Phase 2 freezes the chosen values in
 * docs/validation/frozen_config.json; the API fits with PARAM_GRID, so these are
 * the documented fallback rather than the shipped selection rule.
 */
export const DEFAULT_PARAMS = Object.freeze({ alpha: 0.3, beta: 0.05, gamma: 0.2 });

/**
 * Grid searched on the training series only. Kept small on purpose: with 14–28
 * observations a wide grid mostly fits noise, and every extra combination is
 * cost the API pays per product per request.
 */
export const PARAM_GRID = Object.freeze({
  alpha: Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
  beta:  Object.freeze([0, 0.05, 0.1, 0.2]),
  gamma: Object.freeze([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]),
});

/** Two SSE values closer than this are treated as a tie (first grid hit wins). */
const TIE_EPSILON = 1e-9;

/** @returns {number} Arithmetic mean of a list (0 for an empty list). */
function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/**
 * Can this series be fitted at all? Two full weeks of finite, non-negative
 * daily units are required; anything else (too short, NaN, negative) is refused
 * so the caller can fall back to a velocity baseline instead of fitting noise.
 * @param {unknown} dailyUnits Candidate series, oldest day first.
 * @returns {boolean}
 */
export function isScorableSeries(dailyUnits) {
  if (!Array.isArray(dailyUnits) || dailyUnits.length < MIN_HISTORY_DAYS) return false;
  return dailyUnits.every((value) => Number.isFinite(value) && value >= 0);
}

/** @throws {RangeError} when a smoothing parameter is outside its valid range. */
function assertParams(params) {
  const { alpha, beta, gamma } = params;
  if (!(alpha > 0 && alpha <= 1)) {
    throw new RangeError(`holtWinters: alpha must be in (0, 1], got ${alpha}.`);
  }
  if (!(beta >= 0 && beta <= 1)) {
    throw new RangeError(`holtWinters: beta must be in [0, 1], got ${beta}.`);
  }
  if (!(gamma > 0 && gamma <= 1)) {
    throw new RangeError(`holtWinters: gamma must be in (0, 1], got ${gamma}.`);
  }
}

/**
 * Fits level, trend and the last season's seasonal factors to one series.
 * @param {number[]} dailyUnits Units per day, oldest first, contiguous calendar
 *   days (missing sale days must be present as 0).
 * @param {{alpha: number, beta: number, gamma: number}} [params] Smoothing
 *   parameters; see DEFAULT_PARAMS.
 * @returns {{
 *   level: number, trend: number, seasonals: number[],
 *   fitted: Array<number|null>, sse: number, observations: number,
 *   params: {alpha: number, beta: number, gamma: number},
 * }|null} `fitted[t]` is the one-step-ahead prediction for day t (null for the
 *   first season, which only seeds the model); `seasonals` holds exactly
 *   SEASON_LENGTH values, oldest first, so index (h − 1) % 7 forecasts day +h.
 *   Null when the series cannot be fitted.
 */
export function fitHoltWinters(dailyUnits, params = DEFAULT_PARAMS) {
  assertParams(params);
  if (!isScorableSeries(dailyUnits)) return null;

  const { alpha, beta, gamma } = params;
  const n = dailyUnits.length;

  let level = mean(dailyUnits.slice(0, SEASON_LENGTH));
  let trend = (mean(dailyUnits.slice(SEASON_LENGTH, SEASON_LENGTH * 2)) - level) / SEASON_LENGTH;

  const seasonal = new Array(n);
  for (let t = 0; t < SEASON_LENGTH; t++) seasonal[t] = dailyUnits[t] - level;

  const fitted = new Array(n).fill(null);
  let sse = 0;

  for (let t = SEASON_LENGTH; t < n; t++) {
    const seasonalT = seasonal[t - SEASON_LENGTH];
    const prediction = level + trend + seasonalT;
    fitted[t] = Math.max(0, prediction);
    const error = dailyUnits[t] - prediction;
    sse += error * error;

    const previousLevel = level;
    level = alpha * (dailyUnits[t] - seasonalT) + (1 - alpha) * (level + trend);
    trend = beta * (level - previousLevel) + (1 - beta) * trend;
    seasonal[t] = gamma * (dailyUnits[t] - level) + (1 - gamma) * seasonalT;
  }

  return {
    level,
    trend,
    seasonals: seasonal.slice(n - SEASON_LENGTH),
    fitted,
    sse,
    observations: n - SEASON_LENGTH,
    params: { alpha, beta, gamma },
  };
}

/**
 * Projects a fitted model forward.
 * @param {object|null} model Result of fitHoltWinters().
 * @param {number} horizonDays Number of days to project (>= 1).
 * @returns {number[]|null} One non-negative daily figure per day
 *   (day +1 first), or null when there is no model.
 * @throws {RangeError} when horizonDays is not a positive integer.
 */
export function forecastFromModel(model, horizonDays) {
  if (!model) return null;
  const horizon = Math.floor(horizonDays);
  if (!Number.isFinite(horizon) || horizon < 1) {
    throw new RangeError(`holtWinters: horizonDays must be a positive integer, got ${horizonDays}.`);
  }

  const { level, trend, seasonals } = model;
  const forecast = new Array(horizon);
  for (let h = 1; h <= horizon; h++) {
    const raw = level + h * trend + seasonals[(h - 1) % SEASON_LENGTH];
    forecast[h - 1] = Number.isFinite(raw) ? Math.max(0, raw) : 0;
  }
  return forecast;
}

/**
 * Grid-searches the parameters that minimise the in-sample SSE.
 * @param {number[]} dailyUnits Training series, oldest first.
 * @param {{alpha: number[], beta: number[], gamma: number[]}} [grid]
 * @returns {{params: {alpha: number, beta: number, gamma: number}, sse: number}|null}
 *   Best combination (first one wins a tie, so the result is deterministic),
 *   or null when the series cannot be fitted.
 */
export function selectParams(dailyUnits, grid = PARAM_GRID) {
  if (!isScorableSeries(dailyUnits)) return null;

  let best = null;
  for (const alpha of grid.alpha) {
    for (const beta of grid.beta) {
      for (const gamma of grid.gamma) {
        const candidate = { alpha, beta, gamma };
        const model = fitHoltWinters(dailyUnits, candidate);
        // A series of all zeros ties every combination at SSE 0; keeping the
        // first hit makes the selection reproducible instead of arbitrary.
        if (model && (best === null || model.sse < best.sse - TIE_EPSILON)) {
          best = { params: candidate, sse: model.sse };
        }
      }
    }
  }
  return best;
}

/**
 * Fits (optionally selecting parameters by grid search) and forecasts in one
 * call — the entry point the forecast service and the backtest both use.
 * @param {number[]} dailyUnits Training series, oldest first.
 * @param {number} horizonDays Days to project (>= 1).
 * @param {{selection?: 'grid'|'fixed', params?: object, grid?: object}} [options]
 *   `selection` defaults to 'grid'; 'fixed' uses `params` or DEFAULT_PARAMS.
 * @returns {{
 *   forecast: number[], params: {alpha: number, beta: number, gamma: number},
 *   sse: number, observations: number, model: object,
 * }|null} Null when the series cannot be fitted (caller falls back to velocity).
 * @throws {RangeError} on an unknown selection mode or an invalid parameter.
 */
export function forecastHoltWinters(dailyUnits, horizonDays, options = {}) {
  const selection = options.selection ?? 'grid';
  if (selection !== 'grid' && selection !== 'fixed') {
    throw new RangeError(`holtWinters: selection must be 'grid' or 'fixed', got '${selection}'.`);
  }
  if (!isScorableSeries(dailyUnits)) return null;

  let params = options.params ?? DEFAULT_PARAMS;
  if (selection === 'grid') {
    const picked = selectParams(dailyUnits, options.grid ?? PARAM_GRID);
    if (!picked) return null;
    params = picked.params;
  }

  const model = fitHoltWinters(dailyUnits, params);
  return {
    forecast: forecastFromModel(model, horizonDays),
    params,
    sse: model.sse,
    observations: model.observations,
    model,
  };
}

