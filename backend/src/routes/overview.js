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
 *   startDate — ISO date string (default: DEFAULT_WINDOW_DAYS before endDate)
 *   endDate   — ISO date string (default: the store's as-of date, i.e. its
 *               latest sale_date — never today, so an export that ends months
 *               ago still produces a populated 30-day window and 14-day trend)
 *
 * The response includes asOfDate so the dashboard can say "Data as of …".
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }       from 'express';
import { requireAuth, requireDashboardRead } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query }        from '../db/pool.js';
import { getStoreAsOfDate } from '../utils/asOfDate.js';

const router = Router();

// Length of the default KPI/trend window, measured back from the as-of date.
const DEFAULT_WINDOW_DAYS = 30;

/** @returns {string} The ISO date (YYYY-MM-DD) shifted by `deltaDays`. */
function shiftIsoDate(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

// Read-only route: owner / manager / system_admin only.
router.get('/', requireAuth, resolveTenant, requireDashboardRead, async (req, res) => {
  const { tenantId } = req;
  const storeId      = req.query.storeId || null;

  try {
    // ── Anchor the analysis to where the data ends ────────────────────────────
    // Anchoring to today would leave the window empty for a store whose latest
    // export is weeks or months old — flat chart, zero KPIs. The as-of date is
    // the store's latest sale_date (today when it has no sales at all).
    const asOfDate = await getStoreAsOfDate(query, tenantId, storeId);

    // ── Parse query params ─────────────────────────────────────────────────────
    const endDate = req.query.endDate || asOfDate;
    let startDate = req.query.startDate || shiftIsoDate(endDate, -DEFAULT_WINDOW_DAYS);

    // A start date after the end date can only ever produce an empty window. That
    // happens when a client anchors startDate to today while the data ends
    // earlier, so fall back to the anchored default rather than return blanks.
    if (startDate > endDate) startDate = shiftIsoDate(endDate, -DEFAULT_WINDOW_DAYS);

    // Shared WHERE clause fragment — all queries below use these params
    const storeFilter   = storeId ? 'AND st.store_id = $4' : '';
    const baseParams    = storeId
      ? [tenantId, startDate, endDate, storeId]
      : [tenantId, startDate, endDate];

    // ── KPI snapshot ──────────────────────────────────────────────────────────
    const { rows: [kpi] } = await query(
      `SELECT
         COALESCE(SUM(st.total_revenue), 0)                              AS total_revenue,
         COALESCE(SUM(st.total_cost), 0)                                 AS total_cogs,
         COALESCE(SUM(st.total_revenue) - SUM(st.total_cost), 0)        AS gross_profit,
         COALESCE(COUNT(DISTINCT st.id), 0)                              AS total_transactions,
         COALESCE(SUM(st.quantity_sold), 0)                              AS total_units_sold,
         -- Additive camelCase alias of the same window/store as the totals above:
         -- the dashboard's units-sold KPI reads the unitsSold field. This route
         -- has no previous-period/growth comparison to mirror (the client derives
         -- growth from dailyTrend), so there is no previous-period units field.
         COALESCE(SUM(st.quantity_sold), 0)                              AS "unitsSold",
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
         SUM(st.total_revenue - st.total_cost) AS profit,
         COUNT(*)                            AS transaction_count
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
      // The date the window is measured to (= the store's latest sale date, or
      // today when it has no sales). The dashboard labels the analysis with it.
      asOfDate,
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
