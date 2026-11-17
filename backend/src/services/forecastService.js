/**
 * services/forecastService.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Turns a store's sales history into per-product daily demand forecasts.
 *
 * Two engines, selected by FORECAST_ENGINE (default 'velocity'):
 *   velocity     — the baseline Stockout Watch has always used: units sold over
 *                  the last N days divided by N. No model, no look-ahead.
 *   holt_winters — additive Holt-Winters, season length 7, fitted per product on
 *                  that product's own history (services/holtWinters.js).
 *
 * Everything the forecast sees is anchored to the store's as-of date (its latest
 * sale date), exactly like the speedometer the stockout route uses: a store whose
 * export ends weeks ago is forecast from where its data ends, never from today.
 *
 * The history window is a CONTIGUOUS calendar series ending on the as-of date,
 * zero-filled for days without sales and starting no earlier than the product's
 * first sale (days before it existed are not real zero-sale days). That is the
 * series Holt-Winters is fitted on.
 *
 * Fallbacks, in the order they apply:
 *   * fewer than MIN_HISTORY_DAYS days of history → the velocity average is used
 *     as a flat forecast and the row is labelled 'velocity_fallback';
 *   * the velocity engine → the same flat baseline, labelled 'velocity'.
 * A forecast can therefore never be missing, only less informed.
 *
 * No database handle is imported here: the caller passes `query` (or a
 * client-bound equivalent), which keeps this module importable from a self-test
 * that has no DATABASE_URL.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getStoreAsOfDate } from '../utils/asOfDate.js';
import {
  DEFAULT_PARAMS,
  MIN_HISTORY_DAYS,
  SEASON_LENGTH,
  forecastHoltWinters,
  isScorableSeries,
} from './holtWinters.js';

/** Engines FORECAST_ENGINE accepts. Anything else falls back to 'velocity'. */
export const FORECAST_ENGINES = Object.freeze(['velocity', 'holt_winters']);

/** Days projected ahead. Seven: one full retail week, the season length. */
export const FORECAST_HORIZON_DAYS = 7;

/** Days of history fitted by default: four weekly cycles. */
export const DEFAULT_HISTORY_DAYS = 28;

/** Days averaged by the velocity baseline — matches routes/stockout.js. */
export const DEFAULT_VELOCITY_DAYS = 14;

/**
 * Reads FORECAST_ENGINE. Unknown or empty values resolve to 'velocity', so a
 * typo in .env can never switch the dashboard onto an engine quietly.
 * @param {string|undefined} [raw] Raw value; defaults to the environment.
 * @returns {'velocity'|'holt_winters'}
 */
export function resolveForecastEngine(raw = process.env.FORECAST_ENGINE) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value === 'holt_winters' ? 'holt_winters' : 'velocity';
}

/** @returns {string} The ISO date (YYYY-MM-DD) shifted by `deltaDays`. */
function shiftIsoDate(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/** @returns {string[]} Every ISO date from `startIso` to `endIso`, inclusive. */
function isoDatesBetween(startIso, endIso) {
  const dates = [];
  for (let date = startIso; date <= endIso; date = shiftIsoDate(date, 1)) {
    dates.push(date);
    if (dates.length > 24 * 366) break; // guard against a malformed range
  }
  return dates;
}

/** @returns {number} A whole number inside [min, max], or `fallback`. */
function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

/**
 * Builds the contiguous daily series a forecast is fitted on.
 *
 * Missing calendar days become 0 (a day with no sales is a real zero-demand
 * day), and days before `firstSaleDate` are dropped: the product did not exist
 * yet, so padding them with zeros would invent a demand collapse.
 *
 * @param {Map<string, number>} unitsByDate Units per ISO date (sale days only).
 * @param {string} startIso First date of the requested window.
 * @param {string} endIso Last date of the requested window (the as-of date).
 * @param {string|null} [firstSaleDate] The product's first ever sale.
 * @returns {{dates: string[], values: number[]}} Oldest day first.
 */
export function buildContiguousSeries(unitsByDate, startIso, endIso, firstSaleDate = null) {
  const from = firstSaleDate && firstSaleDate > startIso ? firstSaleDate : startIso;
  const dates = from <= endIso ? isoDatesBetween(from, endIso) : [];
  const values = dates.map((date) => {
    const units = unitsByDate.get(date);
    return Number.isFinite(units) ? units : 0;
  });
  return { dates, values };
}

/**
 * Units sold per day over the `velocityDays` days BEFORE the as-of date — the
 * same arithmetic as the velocity subquery in routes/stockout.js
 * (SUM(units) / velocityDays over [asOf − velocityDays, asOf − 1]), including
 * its treatment of days without sales as zeros. The as-of date itself is
 * excluded, so this is directly comparable to the baseline the dashboard used.
 *
 * The series must cover the whole velocity window; forecastDailyDemand enforces
 * `historyDays >= velocityDays` for exactly that reason.
 *
 * @param {{dates: string[], values: number[]}} series Contiguous daily series.
 * @param {string} asOfDate Last date of the store's data.
 * @param {number} velocityDays Window length in days (>= 1).
 * @returns {number} Average units per day (0 when the window has no sales).
 */
export function velocityAverage(series, asOfDate, velocityDays) {
  const from = shiftIsoDate(asOfDate, -velocityDays);
  let total = 0;
  for (let i = 0; i < series.dates.length; i++) {
    const date = series.dates[i];
    if (date >= from && date < asOfDate) total += series.values[i];
  }
  return total / Math.max(velocityDays, 1);
}

/**
 * Loads daily units per product for one store and window.
 *
 * One query, tenant-scoped from the JWT value the caller passes in. Products
 * with no sale in the window are returned too (LEFT JOIN), with an empty map and
 * their true first sale date, so the caller can tell "no demand" apart from "no
 * product". The all-time first sale date comes from a separate aggregate so the
 * window never truncates the product's age.
 *
 * @param {(text: string, params?: any[]) => Promise<{rows: any[]}>} runQuery
 * @param {string} tenantId Tenant UUID (never from the request body).
 * @param {string} storeId Store UUID.
 * @param {{startDate: string, endDate: string}} window Inclusive ISO dates.
 * @returns {Promise<Array<{
 *   productId: string, sku: string, productName: string,
 *   firstSaleDate: string|null, unitsByDate: Map<string, number>,
 * }>>}
 */
export async function getDailyUnitsByProduct(runQuery, tenantId, storeId, { startDate, endDate }) {
  const { rows } = await runQuery(
    `WITH scoped AS (
       SELECT st.product_id,
              st.sale_date::text          AS sale_date,
              SUM(st.quantity_sold)::float AS units
       FROM sale_transactions st
       WHERE st.tenant_id = $1
         AND st.store_id  = $2
         AND st.sale_date >= $3::date
         AND st.sale_date <= $4::date
       GROUP BY st.product_id, st.sale_date
     ),
     first_sale AS (
       SELECT st.product_id, MIN(st.sale_date)::text AS first_sale_date
       FROM sale_transactions st
       WHERE st.tenant_id = $1
         AND st.store_id  = $2
       GROUP BY st.product_id
     )
     SELECT p.id  AS product_id,
            p.sku,
            p.name AS product_name,
            fs.first_sale_date,
            s.sale_date,
            s.units
     FROM products p
     JOIN first_sale fs ON fs.product_id = p.id
     LEFT JOIN scoped s ON s.product_id = p.id
     WHERE p.tenant_id = $1
       AND p.is_active = TRUE
     ORDER BY p.sku, s.sale_date`,
    [tenantId, storeId, startDate, endDate],
  );

  const byProduct = new Map();
  for (const row of rows) {
    let entry = byProduct.get(row.product_id);
    if (!entry) {
      entry = {
        productId:     row.product_id,
        sku:           row.sku,
        productName:   row.product_name,
        firstSaleDate: row.first_sale_date ?? null,
        unitsByDate:   new Map(),
      };
      byProduct.set(row.product_id, entry);
    }
    if (row.sale_date != null) {
      entry.unitsByDate.set(row.sale_date, Number(row.units) || 0);
    }
  }
  return [...byProduct.values()];
}

/** @returns {number} Rounded to two decimals, for readable JSON. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Forecasts daily demand per product for one store.
 *
 * @param {(text: string, params?: any[]) => Promise<{rows: any[]}>} runQuery
 * @param {string} tenantId Tenant UUID (from the JWT, never the request body).
 * @param {string} storeId Store UUID.
 * @param {{
 *   asOfDate?: string, engine?: 'velocity'|'holt_winters', horizonDays?: number,
 *   historyDays?: number, velocityDays?: number,
 * }} [options] `asOfDate` defaults to the store's latest sale date; `engine`
 *   defaults to FORECAST_ENGINE; `historyDays` is raised to `velocityDays` and
 *   MIN_HISTORY_DAYS when smaller.
 * @returns {Promise<{
 *   asOfDate: string, engine: string, horizonDays: number,
 *   historyDays: number, velocityDays: number, seasonLength: number,
 *   generatedAt: string,
 *   summary: {products: number, holtWinters: number, velocityFallback: number, velocity: number},
 *   products: Array<{
 *     productId: string, sku: string, productName: string,
 *     method: 'holt_winters'|'velocity_fallback'|'velocity',
 *     historyDays: number, firstSaleDate: string|null,
 *     velocityAvgDailyUnits: number, forecastAvgDailyUnits: number,
 *     forecast: Array<{date: string, units: number}>,
 *     params: {alpha: number, beta: number, gamma: number}|null,
 *     sse: number|null,
 *   }>,
 * }>} `method` says where each row's demand came from; a product whose history
 *   is too short is reported as 'velocity_fallback', never silently dropped.
 */
export async function forecastDailyDemand(runQuery, tenantId, storeId, options = {}) {
  const engine = options.engine ?? resolveForecastEngine();
  if (!FORECAST_ENGINES.includes(engine)) {
    throw new RangeError(`forecast: unknown engine '${engine}'.`);
  }

  const horizonDays  = clampInt(options.horizonDays, FORECAST_HORIZON_DAYS, 1, 30);
  const velocityDays = clampInt(options.velocityDays, DEFAULT_VELOCITY_DAYS, 1, 90);
  const historyDays  = Math.max(
    clampInt(options.historyDays, DEFAULT_HISTORY_DAYS, MIN_HISTORY_DAYS, 180),
    velocityDays,
  );

  const asOfDate = options.asOfDate
    ?? await getStoreAsOfDate(runQuery, tenantId, storeId);
  const startDate = shiftIsoDate(asOfDate, -(historyDays - 1));
  const forecastDates = Array.from(
    { length: horizonDays }, (_unused, i) => shiftIsoDate(asOfDate, i + 1),
  );

  const loaded = await getDailyUnitsByProduct(
    runQuery, tenantId, storeId, { startDate, endDate: asOfDate },
  );

  const products = loaded.map((product) => {
    const series = buildContiguousSeries(
      product.unitsByDate, startDate, asOfDate, product.firstSaleDate,
    );
    const velocityAvgDailyUnits = velocityAverage(series, asOfDate, velocityDays);

    let method = 'velocity';
    let forecast = new Array(horizonDays).fill(velocityAvgDailyUnits);
    let params = null;
    let sse = null;

    if (engine === 'holt_winters') {
      // The model only ever sees this product's own training days.
      const fit = isScorableSeries(series.values)
        ? forecastHoltWinters(series.values, horizonDays, { selection: 'grid' })
        : null;
      if (fit) {
        method = 'holt_winters';
        forecast = fit.forecast;
        params = fit.params;
        sse = fit.sse;
      } else {
        method = 'velocity_fallback';
        forecast = new Array(horizonDays).fill(velocityAvgDailyUnits);
      }
    }

    const rawTotal = forecast.reduce((sum, units) => sum + units, 0);

    return {
      productId:     product.productId,
      sku:           product.sku,
      productName:   product.productName,
      method,
      historyDays:   series.values.length,
      firstSaleDate: product.firstSaleDate,
      velocityAvgDailyUnits,
      // Averaged from the unrounded forecast so days-of-cover cannot drift from
      // the daily figures a caller ends up storing.
      forecastAvgDailyUnits: rawTotal / horizonDays,
      forecast: forecastDates.map((date, i) => ({ date, units: round2(forecast[i]) })),
      params,
      sse,
    };
  });

  const summary = {
    products: products.length,
    holtWinters:      products.filter((p) => p.method === 'holt_winters').length,
    velocityFallback: products.filter((p) => p.method === 'velocity_fallback').length,
    velocity:         products.filter((p) => p.method === 'velocity').length,
  };

  return {
    asOfDate,
    engine,
    horizonDays,
    historyDays,
    velocityDays,
    seasonLength: SEASON_LENGTH,
    generatedAt: new Date().toISOString(),
    summary,
    products,
  };
}

/** Re-exported so callers do not import two modules to describe the model. */
export { DEFAULT_PARAMS, MIN_HISTORY_DAYS };
