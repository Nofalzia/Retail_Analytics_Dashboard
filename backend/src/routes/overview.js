/**
 * routes/overview.js
 * ──────────────────────────────────────────────────────────────────────────────
 * GET /api/overview
 *
 * Powers the BusinessOwnerDashboard. Returns:
 *   - KPI snapshot: total revenue, total orders, gross margin for the period
 *   - Daily revenue trend (for the line chart)
 *   - Top 5 products by revenue
 *   - Inventory summary (products below reorder threshold)
 *
 * Query params:
 *   storeId   — UUID (optional: omit for all-stores aggregate)
 *   startDate — ISO date string (default: 30 days ago)
 *   endDate   — ISO date string (default: today)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }       from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query }        from '../db/pool.js';

const router = Router();

router.get('/', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId } = req;

  // ── Parse query params ─────────────────────────────────────────────────────
  const endDate   = req.query.endDate   || new Date().toISOString().slice(0, 10);
  const startDate = req.query.startDate || (() => {
    const d = new Date(); d.setDate(d.getDate() - 30); return d.toISOString().slice(0, 10);
  })();
  const storeId   = req.query.storeId || null;

  // Shared WHERE clause fragment — all queries below use these params
  const storeFilter   = storeId ? 'AND st.store_id = $4' : '';
  const baseParams    = storeId
    ? [tenantId, startDate, endDate, storeId]
    : [tenantId, startDate, endDate];

  try {
    // ── KPI snapshot ──────────────────────────────────────────────────────────
    const { rows: [kpi] } = await query(
      `SELECT
         COALESCE(SUM(st.total_revenue), 0)                              AS total_revenue,
         COALESCE(SUM(st.total_cost), 0)                                 AS total_cogs,
         COALESCE(SUM(st.total_revenue) - SUM(st.total_cost), 0)        AS gross_profit,
         COALESCE(COUNT(DISTINCT st.id), 0)                              AS total_transactions,
         COALESCE(SUM(st.quantity_sold), 0)                              AS total_units_sold,
         CASE WHEN SUM(st.total_revenue) > 0
              THEN ROUND(
                ((SUM(st.total_revenue) - SUM(st.total_cost)) / SUM(st.total_revenue)) * 100, 2
              )
              ELSE 0
         END                                                             AS gross_margin_pct
       FROM sale_transactions st
       WHERE st.tenant_id = $1
         AND st.sale_date BETWEEN $2 AND $3
         ${storeFilter}`,
      baseParams,
    );

    // ── Daily revenue trend ───────────────────────────────────────────────────
    const { rows: dailyTrend } = await query(
      `SELECT
         st.sale_date::text                  AS date,
         SUM(st.total_revenue)               AS revenue,
         SUM(st.total_revenue - st.total_cost) AS profit
       FROM sale_transactions st
       WHERE st.tenant_id = $1
         AND st.sale_date BETWEEN $2 AND $3
         ${storeFilter}
       GROUP BY st.sale_date
       ORDER BY st.sale_date ASC`,
      baseParams,
    );

    // ── Top 5 products by revenue ─────────────────────────────────────────────
    const { rows: topProducts } = await query(
      `SELECT
         p.name                              AS product_name,
         p.sku,
         SUM(st.quantity_sold)               AS units_sold,
         SUM(st.total_revenue)               AS revenue,
         SUM(st.total_revenue - st.total_cost) AS gross_profit
       FROM sale_transactions st
       JOIN products p ON p.id = st.product_id
       WHERE st.tenant_id = $1
         AND st.sale_date BETWEEN $2 AND $3
         ${storeFilter}
       GROUP BY p.id, p.name, p.sku
       ORDER BY revenue DESC
       LIMIT 5`,
      baseParams,
    );

    // ── Inventory health: products at or below reorder threshold ──────────────
    const { rows: lowStockItems } = await query(
      `SELECT
         p.name                              AS product_name,
         p.sku,
         p.reorder_threshold,
         li.quantity_on_hand,
         li.last_counted_date
       FROM latest_inventory_per_product li
       JOIN products p ON p.id = li.product_id
       WHERE li.tenant_id = $1
         ${storeId ? 'AND li.store_id = $2' : ''}
         AND li.quantity_on_hand <= p.reorder_threshold
         AND p.reorder_threshold > 0
       ORDER BY li.quantity_on_hand ASC
       LIMIT 10`,
      storeId ? [tenantId, storeId] : [tenantId],
    );

    return res.json({
      period:      { startDate, endDate },
      kpi,
      dailyTrend,
      topProducts,
      lowStockItems,
    });
  } catch (err) {
    console.error('[overview] Query error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR', message: 'Failed to fetch overview data.' });
  }
});

export default router;
