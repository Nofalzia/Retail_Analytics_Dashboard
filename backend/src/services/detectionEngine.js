/**
 * services/detectionEngine.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 3 Core Intelligence Layer
 *
 * ── DETECTION METHODOLOGY (v2, viva defence documentation) ────────────────────
 *
 * runZScoreDetection uses a TRUE PER-DAY ROLLING Z-SCORE implemented in
 * services/rollingZScore.js. For every evaluated day the baseline is the
 * PREVIOUS windowDays (14) calendar days only — the day under test is never part
 * of its own baseline, so an anomaly cannot mask itself (the flaw of v1).
 * Calendar days with no sale are zero-filled because the product_daily_velocity
 * view only contains days that had sales; a "drop to zero" is therefore visible.
 * σ is floored at the counting-noise level sqrt(max(mean, 1)) so a flat baseline
 * cannot produce arbitrarily large z-scores.
 *
 * Each run evaluates the most recent EVAL_DAYS (14) calendar days present in the
 * data, for every active product that sold inside the lookback window.
 *
 * ── AS-OF DATE ────────────────────────────────────────────────────────────────
 * Every window (and every alert_date written) is anchored to the store's latest
 * sale date, not to CURRENT_DATE. A retailer who uploads an export that ends
 * weeks ago must still get a real analysis, measured from where the data ends.
 * getStoreAsOfDate() (utils/asOfDate.js) supplies that date; it falls back to
 * today only when the store has no sales at all.
 *
 * Alert severity (from |z|, relative to the configured zAlert = 2.5):
 *   info      |z| <  zAlert + 0.5
 *   warning   |z| >= zAlert + 0.5
 *   critical  |z| >= zAlert + 1.5
 *
 * Stockout risk threshold = 7 days (assumed supplier lead time).
 * Low stock severity scales by ratio: <=25% of threshold → critical,
 * <=50% → warning, else → info.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getClient, query } from '../db/pool.js';
import { DEFAULT_PARAMS, scoreSeries, severityFor } from './rollingZScore.js';
import { getStoreAsOfDate } from '../utils/asOfDate.js';

const EVAL_DAYS            = 14; // most-recent calendar days evaluated each run
const ROLLING_WINDOW_DAYS  = 14; // velocity window used by stockout risk
const STOCKOUT_RISK_DAYS   = 7;

/** @returns {string} The ISO date (YYYY-MM-DD) shifted by `deltaDays`. */
function addDays(iso, deltaDays) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve the store's as-of date on an already checked-out client.
 * Every window below ends here rather than at today, so an export that stops
 * months ago still produces alerts (see utils/asOfDate.js).
 *
 * @param {import('pg').PoolClient} client
 * @param {string} tenantId
 * @param {string} storeId
 * @returns {Promise<string>} 'YYYY-MM-DD'
 */
function resolveAsOfDate(client, tenantId, storeId) {
  return getStoreAsOfDate((text, params) => client.query(text, params), tenantId, storeId);
}


// ─────────────────────────────────────────────────────────────────────────────
// 1. runZScoreDetection — sales_spike and sales_drop alerts
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} tenantId
 * @param {string} storeId
 * @param {string|null} [asOfDate] Pre-resolved 'YYYY-MM-DD' anchor for the
 *   lookback window; derived from the store's latest sale_date when omitted.
 */
export async function runZScoreDetection(tenantId, storeId, asOfDate = null) {
  const client = await getClient();
  const summary = { created: 0, skipped_insufficient_data: 0, products_scanned: 0 };
  const params = DEFAULT_PARAMS;
  // Fetch enough history to baseline the last EVAL_DAYS days (windowDays before each).
  const lookbackDays = EVAL_DAYS + params.windowDays;

  try {
    await client.query('BEGIN');

    // Anchor the lookback to where the data ends, not to today.
    const runDate = asOfDate ?? await resolveAsOfDate(client, tenantId, storeId);

    const { rows: velocityRows } = await client.query(
      `SELECT
         product_id,
         product_name,
         sku,
         sale_date::text AS sale_date,
         units_sold_on_day
       FROM product_daily_velocity
       WHERE tenant_id = $1
         AND store_id  = $2
         AND sale_date >= $4::date - MAKE_INTERVAL(days => $3::int)
       ORDER BY product_id, sale_date ASC`,
      [tenantId, storeId, lookbackDays, runDate],
    );

    const productIds = [...new Set(velocityRows.map((row) => row.product_id))];
    const { rows: firstSaleRows } = productIds.length > 0
      ? await client.query(
          `SELECT product_id, MIN(sale_date)::text AS first_sale_date
             FROM sale_transactions
            WHERE tenant_id = $1
              AND store_id  = $2
              AND product_id = ANY($3::uuid[])
            GROUP BY product_id`,
          [tenantId, storeId, productIds],
        )
      : { rows: [] };
    const firstSaleByProduct = new Map(
      firstSaleRows.map((row) => [row.product_id, row.first_sale_date]),
    );

    // Evaluate the most recent EVAL_DAYS calendar days that exist in the data.
    // A store with no sales inside the lookback window has no maxDate, so there is
    // nothing to evaluate: keep the v1 behaviour (zero alerts) instead of building
    // an invalid date range and failing the whole run.
    let maxDate = null;
    for (const row of velocityRows) {
      if (maxDate === null || row.sale_date > maxDate) maxDate = row.sale_date;
    }
    const evalDates = [];
    if (maxDate !== null) {
      for (let offset = EVAL_DAYS - 1; offset >= 0; offset--) evalDates.push(addDays(maxDate, -offset));
    }

    const byProduct = new Map();
    for (const row of velocityRows) {
      if (!byProduct.has(row.product_id)) {
        byProduct.set(row.product_id, {
          product_id:   row.product_id,
          product_name: row.product_name,
          sku:          row.sku,
          unitsByDate:  new Map(),
        });
      }
      byProduct.get(row.product_id).unitsByDate.set(row.sale_date, Number(row.units_sold_on_day));
    }

    summary.products_scanned = byProduct.size;

    for (const product of byProduct.values()) {
      const firstSaleDate = firstSaleByProduct.get(product.product_id);
      const scored = firstSaleDate && maxDate
        ? scoreSeries(product.unitsByDate, firstSaleDate, evalDates, params)
        : [];
      if (scored.length === 0) {
        summary.skipped_insufficient_data++;
        continue;
      }

      for (const day of scored) {
        if (!day.flagged) continue;

        const isSalesSpike = day.direction === 'up';
        const alertType    = isSalesSpike ? 'sales_spike' : 'sales_drop';
        const severity     = severityFor(day.z, params);
        const absZ         = Math.abs(day.z);

        const title = isSalesSpike
          ? `Unusual Sales Spike — ${product.product_name}`
          : `Unusual Sales Drop — ${product.product_name}`;

        const description = isSalesSpike
          ? `${product.product_name} (SKU: ${product.sku}) sold ${day.observedUnits} units on ${day.date}, ` +
            `${absZ.toFixed(2)}σ above the ${params.windowDays}-day rolling average of ${day.mean.toFixed(1)} units/day. ` +
            `May indicate a promotional uplift, bulk purchase, or data entry error.`
          : `${product.product_name} (SKU: ${product.sku}) sold only ${day.observedUnits} units on ${day.date}, ` +
            `${absZ.toFixed(2)}σ below the ${params.windowDays}-day rolling average of ${day.mean.toFixed(1)} units/day. ` +
            `May indicate a stockout, supplier delay, or reduced demand — review inventory.`;

        const { rowCount } = await client.query(
          `INSERT INTO anomaly_alerts
             (tenant_id, store_id, product_id, alert_type, severity,
              title, description, metric_value, threshold_value, z_score, alert_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
          [tenantId, storeId, product.product_id, alertType, severity,
           title, description, day.observedUnits, day.mean.toFixed(4), absZ.toFixed(4), day.date],
        );
        summary.created += rowCount;
      }
    }

    await client.query('COMMIT');
    return summary;

  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`[detectionEngine] z-score detection failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. runStockoutRiskDetection — stockout_risk alerts (days_remaining < 7)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} tenantId
 * @param {string} storeId
 * @param {string|null} [asOfDate] Pre-resolved 'YYYY-MM-DD' anchor for the
 *   velocity window and the alert_date; derived when omitted.
 */
export async function runStockoutRiskDetection(tenantId, storeId, asOfDate = null) {
  const client = await getClient();
  const summary = { created: 0, skipped_no_velocity: 0, skipped_no_snapshot: 0, products_scanned: 0 };

  try {
    await client.query('BEGIN');

    // Velocity is measured backwards from the store's latest sale date: a store
    // whose data ends months ago still has a meaningful sell-through rate.
    const runDate = asOfDate ?? await resolveAsOfDate(client, tenantId, storeId);

    const { rows } = await client.query(
      `WITH velocity AS (
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
         p.name                                              AS product_name,
         p.sku,
         p.reorder_threshold,
         -- No snapshot row means the stock level is unknown, not zero; the loop
         -- below skips those products so absent data never raises an alert.
         (li.product_id IS NOT NULL)                         AS has_inventory_snapshot,
         COALESCE(li.quantity_on_hand, 0)                    AS quantity_on_hand,
         COALESCE(v.avg_daily_units, 0)                      AS avg_daily_velocity,
         CASE
           WHEN COALESCE(v.avg_daily_units, 0) = 0 THEN NULL
           ELSE ROUND(COALESCE(li.quantity_on_hand, 0)::numeric / v.avg_daily_units)
         END                                                 AS days_remaining
       FROM products p
       LEFT JOIN latest_inventory_per_product li
         ON li.product_id = p.id AND li.store_id = $2 AND li.tenant_id = $1
       LEFT JOIN velocity v ON v.product_id = p.id
       WHERE p.tenant_id = $1 AND p.is_active = TRUE`,
      [tenantId, storeId, ROLLING_WINDOW_DAYS, runDate],
    );

    summary.products_scanned = rows.length;

    for (const row of rows) {
      const daysRemaining  = row.days_remaining !== null ? Number(row.days_remaining) : null;
      const avgVelocity    = Number(row.avg_daily_velocity);
      const quantityOnHand = Number(row.quantity_on_hand);

      // Skipped BEFORE the velocity check so the counters stay honest: a product
      // that has never been counted cannot be running out of stock. Products that
      // do have a snapshot behave exactly as before.
      if (!row.has_inventory_snapshot) {
        summary.skipped_no_snapshot++;
        continue;
      }
      if (avgVelocity === 0 || daysRemaining === null) {
        summary.skipped_no_velocity++;
        continue;
      }
      if (daysRemaining >= STOCKOUT_RISK_DAYS) continue;

      const severity = daysRemaining <= 2 ? 'critical'
                     : daysRemaining <= 4 ? 'warning'
                     : 'info';

      const title = `Stockout Risk — ${row.product_name}`;
      const description =
        `${row.product_name} (SKU: ${row.sku}) has ${quantityOnHand} units remaining, ` +
        `selling at ${avgVelocity.toFixed(1)} units/day. Stock runs out in ~${daysRemaining} day${daysRemaining === 1 ? '' : 's'}. ` +
        (quantityOnHand <= row.reorder_threshold ? 'Currently below reorder point. ' : 'Still above reorder point. ') +
        `Place a supplier order immediately.`;

      const { rowCount } = await client.query(
        `INSERT INTO anomaly_alerts
           (tenant_id, store_id, product_id, alert_type, severity,
            title, description, metric_value, threshold_value, z_score, alert_date)
         VALUES ($1,$2,$3,'stockout_risk',$4,$5,$6,$7,$8,NULL,$9::date)
         ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
        [tenantId, storeId, row.product_id, severity, title, description,
         daysRemaining, STOCKOUT_RISK_DAYS, runDate],
      );
      summary.created += rowCount;
    }

    await client.query('COMMIT');
    return summary;

  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`[detectionEngine] stockout risk detection failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. runLowStockDetection — low_stock alerts (qty < reorder_threshold)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {string} tenantId
 * @param {string} storeId
 * @param {string|null} [asOfDate] Pre-resolved 'YYYY-MM-DD' written as the
 *   alert_date; derived from the store's latest sale_date when omitted.
 */
export async function runLowStockDetection(tenantId, storeId, asOfDate = null) {
  const client = await getClient();
  const summary = { created: 0, skipped_no_threshold: 0, skipped_no_snapshot: 0, products_scanned: 0 };

  try {
    await client.query('BEGIN');

    // Low stock is a snapshot of the latest count, so there is no window to
    // anchor — but the alert is dated where the data ends, so it groups with the
    // alerts of that same analysis run instead of drifting with today's clock.
    const runDate = asOfDate ?? await resolveAsOfDate(client, tenantId, storeId);

    const { rows } = await client.query(
      `SELECT
         p.id                             AS product_id,
         p.name                           AS product_name,
         p.sku,
         p.reorder_threshold,
         -- Unknown stock (no snapshot) is not "zero stock"; the loop below skips
         -- those products instead of alerting on data that does not exist.
         (li.product_id IS NOT NULL)      AS has_inventory_snapshot,
         COALESCE(li.quantity_on_hand, 0) AS quantity_on_hand
       FROM products p
       LEFT JOIN latest_inventory_per_product li
         ON li.product_id = p.id AND li.store_id = $2 AND li.tenant_id = $1
       WHERE p.tenant_id = $1
         AND p.is_active = TRUE
         AND p.reorder_threshold > 0`,
      [tenantId, storeId],
    );

    summary.products_scanned = rows.length;

    for (const row of rows) {
      const quantityOnHand = Number(row.quantity_on_hand);
      const threshold      = Number(row.reorder_threshold);

      // A product that has never been counted cannot be below its reorder point.
      if (!row.has_inventory_snapshot) {
        summary.skipped_no_snapshot++;
        continue;
      }
      if (quantityOnHand >= threshold) continue;

      const ratioRemaining = threshold > 0 ? quantityOnHand / threshold : 0;
      const severity = ratioRemaining <= 0.25 ? 'critical'
                     : ratioRemaining <= 0.50 ? 'warning'
                     : 'info';

      const title = `Low Stock — ${row.product_name}`;
      const description =
        `${row.product_name} (SKU: ${row.sku}) has ${quantityOnHand} units remaining, ` +
        `below the reorder threshold of ${threshold} units ` +
        `(${Math.round(ratioRemaining * 100)}% of reorder point). Reorder promptly.`;

      const { rowCount } = await client.query(
        `INSERT INTO anomaly_alerts
           (tenant_id, store_id, product_id, alert_type, severity,
            title, description, metric_value, threshold_value, z_score, alert_date)
         VALUES ($1,$2,$3,'low_stock',$4,$5,$6,$7,$8,NULL,$9::date)
         ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
        [tenantId, storeId, row.product_id, severity, title, description,
         quantityOnHand, threshold, runDate],
      );
      summary.created += rowCount;
    }

    await client.query('COMMIT');
    return summary;

  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`[detectionEngine] low stock detection failed: ${err.message}`);
  } finally {
    client.release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// runAllDetection — orchestrator called by POST /api/alerts/run-detection
// ─────────────────────────────────────────────────────────────────────────────
export async function runAllDetection(tenantId, storeId) {
  const startedAt = Date.now();

  // Resolve the anchor once and hand it to all three engines, so every window
  // and every alert_date in this run agree on where "now" is. Returned in the
  // response so the client can label the analysis ("Data as of …").
  const asOfDate = await getStoreAsOfDate(query, tenantId, storeId);

  const [zScoreSummary, stockoutSummary, lowStockSummary] = await Promise.all([
    runZScoreDetection(tenantId, storeId, asOfDate),
    runStockoutRiskDetection(tenantId, storeId, asOfDate),
    runLowStockDetection(tenantId, storeId, asOfDate),
  ]);

  return {
    asOfDate,
    durationMs: Date.now() - startedAt,
    alertsCreated: {
      zScore:       zScoreSummary.created,
      stockoutRisk: stockoutSummary.created,
      lowStock:     lowStockSummary.created,
      total:        zScoreSummary.created + stockoutSummary.created + lowStockSummary.created,
    },
    skipped: {
      insufficientData: zScoreSummary.skipped_insufficient_data,
      noVelocityData:   stockoutSummary.skipped_no_velocity,
      // Additive: products with no inventory snapshot have unknown stock levels
      // and are never alerted on, so they are counted here instead.
      noInventorySnapshot: stockoutSummary.skipped_no_snapshot + lowStockSummary.skipped_no_snapshot,
    },
    productsScanned: {
      zScore:   zScoreSummary.products_scanned,
      stockout: stockoutSummary.products_scanned,
      lowStock: lowStockSummary.products_scanned,
    },
  };
}