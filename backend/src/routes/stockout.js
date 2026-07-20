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
 * This is the same depletion-rate math already in StockoutPrediction.jsx
 * (the Phase 1 static version), but now driven by real database data.
 *
 * Phase 3 will add z-score deviation detection on top of this baseline.
 *
 * Query params:
 *   storeId       — UUID (required)
 *   velocityDays  — number of past days to calculate avg velocity (default: 14)
 *   urgencyOnly   — 'true' to return only products at risk (days_remaining < 14)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }        from 'express';
import { requireAuth }   from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query }         from '../db/pool.js';

const router = Router();

router.get('/', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId } = req;
  const storeId      = req.query.storeId;
  const velocityDays = Math.max(1, Math.min(parseInt(req.query.velocityDays) || 14, 90));
  const urgencyOnly  = req.query.urgencyOnly === 'true';

  if (!storeId) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'storeId is required.' });
  }

  try {
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
           AND st.sale_date >= CURRENT_DATE - MAKE_INTERVAL(days => $3::int)
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
       LEFT JOIN latest_inventory_per_product li
         ON li.product_id = p.id AND li.store_id = $2 AND li.tenant_id = $1
       LEFT JOIN velocity v ON v.product_id = p.id
       WHERE p.tenant_id = $1
         AND p.is_active = TRUE
         ${urgencyOnly ? "AND COALESCE(li.quantity_on_hand, 0)::float / NULLIF(COALESCE(v.avg_daily_units, 0), 0) < 14" : ''}
       ORDER BY
         CASE
           WHEN COALESCE(v.avg_daily_units, 0) = 0 THEN 99
           ELSE COALESCE(li.quantity_on_hand, 0)::float / v.avg_daily_units
         END ASC NULLS LAST`,
      [tenantId, storeId, velocityDays],
    );

    // Summary counts for the dashboard badges
    const summary = rows.reduce(
      (acc, row) => { acc[row.urgency_tier] = (acc[row.urgency_tier] || 0) + 1; return acc; },
      { stockout: 0, critical: 0, warning: 0, healthy: 0, no_data: 0 },
    );

    return res.json({
      velocityWindowDays: velocityDays,
      summary,
      products: rows,
    });
  } catch (err) {
    console.error('[stockout] Query error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR', message: 'Failed to calculate stockout predictions.' });
  }
});

export default router;
