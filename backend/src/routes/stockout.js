/**
 * routes/stockout.js
 * ──────────────────────────────────────────────────────────────────────────────
 * GET /api/stockout
 *
 * Powers StockoutPrediction.jsx. For each product:
 *   1. Gets the most recent quantity_on_hand from inventory_logs
 *   2. Calculates average daily sales velocity over the last N days
 *   3. Computes estimated days remaining = quantity_on_hand / avg_daily_velocity
 *
 * Products with NO inventory snapshot at all are omitted from `products`: an
 * unknown stock level must never be reported as 0 units on hand. The response
 * carries hasInventoryData so the UI can tell "nothing counted yet" apart from
 * "everything is out of stock".
 *
 * This is the same depletion-rate math already in StockoutPrediction.jsx
 * (the Phase 1 static version), but now driven by real database data.
 *
 * Phase 3 will add z-score deviation detection on top of this baseline.
 *
 * Demand basis (FORECAST_ENGINE, see services/forecastService.js):
 *   velocity      — default. The average daily units above, unchanged.
 *   holt_winters  — a 7-day Holt-Winters forecast per product, averaged to a
 *                   daily demand figure.
 * The flag is the only switch: with the default the SQL, the response keys and
 * every value are exactly what they were before the engine existed, and the
 * forecast-only fields below are added only when the flag is on, so the default
 * screen cannot change by accident. Per row, `daily_demand_basis` says which
 * figure produced that product's days_remaining ('holt_winters' or
 * 'velocity_fallback' when the product has too little history to fit).
 *
 * Query params:
 *   storeId       — UUID (required)
 *   velocityDays  — number of past days to calculate avg velocity (default: 14)
 *   urgencyOnly   — 'true' to return only products at risk (days_remaining < 14)
 *
 * The velocity window ends at the store's as-of date (its latest sale_date), not
 * at today: an export that ends months ago must still produce a velocity, so
 * "now" is wherever this store's data ends. See utils/asOfDate.js.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }        from 'express';
import { requireAuth, requireDashboardRead } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query }         from '../db/pool.js';
import { getStoreAsOfDate } from '../utils/asOfDate.js';
import {
  FORECAST_HORIZON_DAYS,
  forecastDailyDemand,
  resolveForecastEngine,
} from '../services/forecastService.js';

const router = Router();

/**
 * Classifies a product exactly the way the route's SQL does, so a forecast-based
 * projection uses the same tier boundaries as the velocity-based one.
 * @param {number} quantityOnHand Latest counted stock (0 when never counted).
 * @param {number} dailyDemand Average units sold/forecast per day.
 * @returns {{daysRemaining: number|null, urgencyTier: string, ratio: number}}
 *   `daysRemaining` is the rounded ratio the SQL's ROUND() produced.
 */
function projectCover(quantityOnHand, dailyDemand) {
  if (!(dailyDemand > 0)) return { daysRemaining: null, urgencyTier: 'no_data', ratio: Infinity };
  const ratio = quantityOnHand / dailyDemand;
  let urgencyTier = 'healthy';
  if (quantityOnHand === 0) urgencyTier = 'stockout';
  else if (ratio < 7) urgencyTier = 'critical';
  else if (ratio < 14) urgencyTier = 'warning';
  return { daysRemaining: Math.round(ratio), urgencyTier, ratio };
}

/** @returns {number} Days of cover on a row's active demand basis (Infinity when none). */
function coverRatio(row) {
  const demand = Number(row.avg_daily_velocity) || 0;
  return demand > 0 ? (Number(row.quantity_on_hand) || 0) / demand : Infinity;
}

/**
 * Replaces each stockout row's velocity demand with the Holt-Winters forecast.
 *
 * `avg_daily_velocity` keeps its name because that is the key every consumer
 * already reads; it now carries whichever demand basis the flag selected, and
 * `velocity_avg_daily_units` keeps the old 14-day figure for comparison.
 * Products the forecast could not fit (too little history, no sales) fall back
 * to their SQL velocity and are labelled 'velocity_fallback'.
 *
 * @param {Array<object>} rows Rows from the stockout query.
 * @param {{tenantId: string, storeId: string, asOfDate: string, velocityDays: number}} scope
 * @returns {Promise<Array<object>>} Rows with forecast demand applied.
 */
async function applyForecastDemand(rows, { tenantId, storeId, asOfDate, velocityDays }) {
  const demand = await forecastDailyDemand(query, tenantId, storeId, {
    asOfDate,
    engine: 'holt_winters',
    horizonDays: FORECAST_HORIZON_DAYS,
    velocityDays,
  });
  const byProduct = new Map(demand.products.map((product) => [product.productId, product]));

  return rows.map((row) => {
    const forecast = byProduct.get(row.product_id) ?? null;
    const velocityAvgDailyUnits = Number(row.avg_daily_velocity) || 0;
    const dailyDemand = forecast ? forecast.forecastAvgDailyUnits : velocityAvgDailyUnits;
    const { daysRemaining, urgencyTier } = projectCover(
      Number(row.quantity_on_hand) || 0, dailyDemand,
    );

    return {
      ...row,
      avg_daily_velocity: dailyDemand,
      days_remaining: daysRemaining,
      urgency_tier: urgencyTier,
      daily_demand_basis: forecast?.method ?? 'velocity_fallback',
      forecast_avg_daily_units: forecast ? forecast.forecastAvgDailyUnits : null,
      velocity_avg_daily_units: velocityAvgDailyUnits,
    };
  });
}

// Read-only route: owner / manager / system_admin only.
router.get('/', requireAuth, resolveTenant, requireDashboardRead, async (req, res) => {
  const { tenantId } = req;
  const storeId      = req.query.storeId;
  const velocityDays = Math.max(1, Math.min(parseInt(req.query.velocityDays) || 14, 90));
  const urgencyOnly  = req.query.urgencyOnly === 'true';
  const forecastEngine = resolveForecastEngine();
  // The urgency threshold is demand-based. With the forecast engine the demand
  // figure is only known after the forecast runs, so the filter moves to JS;
  // with the default engine it stays in the SQL exactly as it was.
  const filterUrgencyInSql = urgencyOnly && forecastEngine === 'velocity';

  if (!storeId) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'storeId is required.' });
  }

  try {
    // Anchor "now" to the store's latest sale date. Without this a store whose
    // data ends weeks ago would have an empty velocity window and every product
    // would report no_data.
    const asOfDate = await getStoreAsOfDate(query, tenantId, storeId);

    // The single query that does all three steps:
    // Step 1 (latest_inventory): uses the latest_inventory_per_product view
    // Step 2 (velocity): aggregates sale_transactions over the window
    // Step 3 (days_remaining): arithmetic in SELECT
    const { rows } = await query(
      `WITH velocity AS (
         -- Average units sold per day over the velocity window, per product
         SELECT
           st.product_id,
           SUM(st.quantity_sold)::float / GREATEST($3, 1) AS avg_daily_units
         FROM sale_transactions st
         WHERE st.tenant_id = $1
           AND st.store_id  = $2
           AND st.sale_date >= $4::date - MAKE_INTERVAL(days => $3::int)
         GROUP BY st.product_id
       )
       SELECT
         p.id                                                AS product_id,
         p.name                                             AS product_name,
         p.sku,
         p.reorder_threshold,
         COALESCE(li.quantity_on_hand, 0)                   AS quantity_on_hand,
         li.last_counted_date,
         COALESCE(v.avg_daily_units, 0)                     AS avg_daily_velocity,
         CASE
           WHEN COALESCE(v.avg_daily_units, 0) = 0 THEN NULL
           ELSE ROUND(
             COALESCE(li.quantity_on_hand, 0)::numeric / v.avg_daily_units
           )
         END                                                AS days_remaining,
         CASE
           WHEN COALESCE(v.avg_daily_units, 0) = 0 THEN 'no_data'
           WHEN COALESCE(li.quantity_on_hand, 0) = 0 THEN 'stockout'
           WHEN COALESCE(li.quantity_on_hand, 0)::float / v.avg_daily_units < 7  THEN 'critical'
           WHEN COALESCE(li.quantity_on_hand, 0)::float / v.avg_daily_units < 14 THEN 'warning'
           ELSE 'healthy'
         END                                                AS urgency_tier
       FROM products p
       -- INNER JOIN on purpose: a product with no inventory snapshot has an
       -- unknown stock level, so it is left out of the list rather than reported
       -- as 0 units on hand (which would read as "already out of stock").
       JOIN latest_inventory_per_product li
         ON li.product_id = p.id AND li.store_id = $2 AND li.tenant_id = $1
       LEFT JOIN velocity v ON v.product_id = p.id
       WHERE p.tenant_id = $1
         AND p.is_active = TRUE
         ${filterUrgencyInSql ? "AND COALESCE(li.quantity_on_hand, 0)::float / NULLIF(COALESCE(v.avg_daily_units, 0), 0) < 14" : ''}
       ORDER BY
         CASE
           WHEN COALESCE(v.avg_daily_units, 0) = 0 THEN 99
           ELSE COALESCE(li.quantity_on_hand, 0)::float / v.avg_daily_units
         END ASC NULLS LAST`,
      [tenantId, storeId, velocityDays, asOfDate],
    );

    // Does this store have any inventory data at all? An empty products list
    // cannot answer that on its own, and "nothing has been counted yet" is a very
    // different thing to say than "every product is out of stock". Scoped to the
    // tenant + store, and to the same active products the list above considers.
    const { rows: [{ has_inventory_data: hasInventoryData }] } = await query(
      `SELECT EXISTS (
         SELECT 1
         FROM latest_inventory_per_product li
         JOIN products p ON p.id = li.product_id AND p.tenant_id = li.tenant_id
         WHERE li.tenant_id = $1
           AND li.store_id  = $2
           AND p.is_active  = TRUE
       ) AS has_inventory_data`,
      [tenantId, storeId],
    );

    // Summary counts for the dashboard badges
    let products = rows;
    if (forecastEngine === 'holt_winters') {
      products = await applyForecastDemand(rows, { tenantId, storeId, asOfDate, velocityDays });

      // Same predicate as the SQL's `... / NULLIF(avg, 0) < 14`: a product with
      // no demand has no cover figure and is not at risk.
      if (urgencyOnly) products = products.filter((row) => coverRatio(row) < 14);

      // The SQL ordered by velocity; the ranking now has to follow the forecast.
      products = [...products].sort((a, b) => {
        const ratioA = coverRatio(a);
        const ratioB = coverRatio(b);
        if (ratioA === ratioB) return 0;
        return ratioA < ratioB ? -1 : 1;
      });
    }

    const summary = products.reduce(
      (acc, row) => { acc[row.urgency_tier] = (acc[row.urgency_tier] || 0) + 1; return acc; },
      { stockout: 0, critical: 0, warning: 0, healthy: 0, no_data: 0 },
    );

    return res.json({
      // The date the velocity window ends on (= the store's latest sale date, or
      // today when the store has no sales). The UI labels the analysis with it.
      asOfDate,
      velocityWindowDays: velocityDays,
      // Additive: false when this store has never had an inventory count.
      hasInventoryData,
      // Forecast-only keys: absent at the default engine, so the default
      // response stays byte-for-byte what it was and the UI can gate its label
      // on their presence.
      ...(forecastEngine === 'holt_winters' ? {
        forecastEngine,
        forecastHorizonDays: FORECAST_HORIZON_DAYS,
        forecastFallbackCount: products.filter((row) => row.daily_demand_basis === 'velocity_fallback').length,
      } : {}),
      summary,
      products,
    });
  } catch (err) {
    console.error('[stockout] Query error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR', message: 'Failed to calculate stockout predictions.' });
  }
});

export default router;
