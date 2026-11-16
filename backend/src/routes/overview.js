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
 *
 * GET /api/overview/baseline
 * The same 30-day window, reduced to the two numbers the scenario simulator
 * needs to start from (T12f): revenue in and cost of goods as a percentage of
 * it. Same role rules and same as-of anchoring as the overview read above.
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

// ── GET /api/overview/baseline?storeId= ───────────────────────────────────────
// T12f: the scenario simulator's starting numbers, measured from the tenant's
// own sales instead of fixed sample figures.
//
// The simulator opens on this baseline, so it answers "what happens if supply
// costs rise 10%" against the shop the user actually uploaded — the same last
// 30 days the overview dashboard shows, anchored to the store's as-of date.
const BASELINE_WINDOW_DAYS = 30;
// Fewer days with sales than this and a "monthly" average is one or two good
// days wearing a disguise. The route reports null and the panel says so calmly
// rather than projecting from noise.
const BASELINE_MIN_DAYS = 7;

router.get('/baseline', requireAuth, resolveTenant, requireDashboardRead, async (req, res) => {
  const { tenantId } = req;
  const storeId      = req.query.storeId || null;

  try {
    const asOfDate = await getStoreAsOfDate(query, tenantId, storeId);

    // 30 calendar days *including* the as-of date: the window opens 29 days back,
    // so "your last 30 days" is literally 30 dates.
    const windowStart = shiftIsoDate(asOfDate, -(BASELINE_WINDOW_DAYS - 1));

    const storeFilter = storeId ? 'AND st.store_id = $4' : '';
    const params      = storeId
      ? [tenantId, windowStart, asOfDate, storeId]
      : [tenantId, windowStart, asOfDate];

    // COGS is measured from the cost recorded on each sold line
    // (quantity_sold * cost_price_at_sale) — the expression the generated
    // total_cost column holds — never from today's standard_unit_cost, so a
    // supplier price change after the sale cannot rewrite history.
    const { rows: [totals] } = await query(
      `SELECT
         COALESCE(SUM(st.total_revenue), 0)                         AS total_revenue,
         COALESCE(SUM(st.quantity_sold * st.cost_price_at_sale), 0) AS total_cogs,
         COUNT(DISTINCT st.sale_date)                               AS days_with_sales
       FROM sale_transactions st
       WHERE st.tenant_id = $1
         AND st.sale_date BETWEEN $2 AND $3
         ${storeFilter}`,
      params,
    );

    const daysWithSales = Number(totals?.days_with_sales) || 0;
    if (daysWithSales < BASELINE_MIN_DAYS) {
      // Not an error — a new tenant simply has no month to model yet.
      return res.json({ baseline: null });
    }

    const monthlyRevenue = Number(totals.total_revenue) || 0;
    const totalCogs      = Number(totals.total_cogs) || 0;
    const cogsPercent    = monthlyRevenue > 0
      ? Math.round((totalCogs / monthlyRevenue) * 1000) / 10
      : 0;

    // Was any of that cost guessed? When an import has no cost column the parser
    // estimates unit cost from price and records the assumption on the job under
    // the reserved column_map._assumptions key (see routes/upload.js). A margin
    // modelled from those costs is an estimate, and the panel labels it.
    const { rows: [assumptionRow] } = await query(
      `SELECT EXISTS (
         SELECT 1
           FROM ingestion_jobs ij
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE WHEN jsonb_typeof(ij.column_map -> '_assumptions') = 'array'
                  THEN ij.column_map -> '_assumptions'
                  ELSE '[]'::jsonb
             END
           ) AS a(entry)
          WHERE ij.tenant_id = $1
            AND ij.status = 'completed'
            ${storeId ? 'AND ij.store_id = $2' : ''}
            AND a.entry::text ILIKE '%cost%'
       ) AS cost_is_estimated`,
      storeId ? [tenantId, storeId] : [tenantId],
    );

    return res.json({
      baseline: {
        monthlyRevenue,
        cogsPercent,
        windowDays: BASELINE_WINDOW_DAYS,
        asOfDate,
        costIsEstimated: Boolean(assumptionRow?.cost_is_estimated),
      },
    });
  } catch (err) {
    console.error('[overview] Baseline query error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR', message: 'Failed to fetch the scenario baseline.' });
  }
});

export default router;
