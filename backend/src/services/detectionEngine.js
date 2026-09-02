/**
 * services/detectionEngine.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 3 Core Intelligence Layer
 *
 * ── THRESHOLD METHODOLOGY (viva defence documentation) ───────────────────────
 *
 * Z-score thresholds follow Statistical Process Control (SPC) / Shewhart model:
 *
 *   Severity  │ Z-score  │ Percentile │ Rationale
 *   ──────────┼──────────┼────────────┼──────────────────────────────────────
 *   info      │ |z| >1.5 │ ~87th      │ Notable deviation, worth monitoring
 *   warning   │ |z| >2.0 │ ~95th      │ Shewhart 2-sigma control limit
 *   critical  │ |z| >2.5 │ ~99th      │ Statistically extreme, act immediately
 *
 * Rolling window = 14 days (two full retail weeks).
 * Rationale: 7-day window over-weights weekend variance; 30-day reacts too
 * slowly to seasonal shifts. 14 days balances sensitivity and stability.
 *
 * Minimum data points = 3 days before running stats (avoids meaningless stddev).
 *
 * Missing days treated as zero sales (conservative, documented assumption —
 * interpolation would suppress real anomalies).
 *
 * Stockout risk threshold = 7 days (assumed supplier lead time).
 *
 * Low stock severity scales by ratio: <=25% of threshold → critical,
 * <=50% → warning, else → info.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getClient } from '../db/pool.js';

const Z_INFO            = 1.5;
const Z_WARNING         = 2.0;
const Z_CRITICAL        = 2.5;
const ROLLING_WINDOW_DAYS = 14;
const MIN_DATA_POINTS   = 3;
const STOCKOUT_RISK_DAYS = 7;

function zToSeverity(absZ) {
  if (absZ > Z_CRITICAL) return 'critical';
  if (absZ > Z_WARNING)  return 'warning';
  return 'info';
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Population stddev (divide by N) — we describe this window, not a sample
function stddev(values, mu) {
  if (values.length < 2) return 0;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mu, 2), 0) / values.length;
  return Math.sqrt(variance);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. runZScoreDetection — sales_spike and sales_drop alerts
// ─────────────────────────────────────────────────────────────────────────────
export async function runZScoreDetection(tenantId, storeId) {
  const client = await getClient();
  const summary = { created: 0, skipped_insufficient_data: 0, products_scanned: 0 };

  try {
    await client.query('BEGIN');

    const { rows: velocityRows } = await client.query(
      `SELECT
         product_id,
         product_name,
         sku,
         sale_date,
         units_sold_on_day
       FROM product_daily_velocity
       WHERE tenant_id = $1
         AND store_id  = $2
         AND sale_date >= CURRENT_DATE - MAKE_INTERVAL(days => $3::int)
       ORDER BY product_id, sale_date ASC`,
      [tenantId, storeId, ROLLING_WINDOW_DAYS],
    );

    const byProduct = new Map();
    for (const row of velocityRows) {
      if (!byProduct.has(row.product_id)) {
        byProduct.set(row.product_id, {
          product_id:   row.product_id,
          product_name: row.product_name,
          sku:          row.sku,
          days:         [],
        });
      }
      byProduct.get(row.product_id).days.push({
        sale_date: row.sale_date,
        units:     Number(row.units_sold_on_day),
      });
    }

    summary.products_scanned = byProduct.size;

    for (const product of byProduct.values()) {
      if (product.days.length < MIN_DATA_POINTS) {
        summary.skipped_insufficient_data++;
        continue;
      }

      const unitValues = product.days.map(d => d.units);
      const mu         = mean(unitValues);
      const sigma      = stddev(unitValues, mu);
      if (sigma === 0) continue;

      for (const day of product.days) {
        const z    = (day.units - mu) / sigma;
        const absZ = Math.abs(z);
        if (absZ <= Z_INFO) continue;

        const isSalesSpike = z > 0;
        const alertType    = isSalesSpike ? 'sales_spike' : 'sales_drop';
        const severity     = zToSeverity(absZ);
        const dateStr      = day.sale_date.toISOString().split('T')[0];

        const title = isSalesSpike
          ? `Unusual Sales Spike — ${product.product_name}`
          : `Unusual Sales Drop — ${product.product_name}`;

        const description = isSalesSpike
          ? `${product.product_name} (SKU: ${product.sku}) sold ${day.units} units on ${dateStr}, ` +
            `${absZ.toFixed(2)}σ above the ${ROLLING_WINDOW_DAYS}-day rolling average of ${mu.toFixed(1)} units/day. ` +
            `May indicate a promotional uplift, bulk purchase, or data entry error.`
          : `${product.product_name} (SKU: ${product.sku}) sold only ${day.units} units on ${dateStr}, ` +
            `${absZ.toFixed(2)}σ below the ${ROLLING_WINDOW_DAYS}-day rolling average of ${mu.toFixed(1)} units/day. ` +
            `May indicate a stockout, supplier delay, or reduced demand — review inventory.`;

        const { rowCount } = await client.query(
          `INSERT INTO anomaly_alerts
             (tenant_id, store_id, product_id, alert_type, severity,
              title, description, metric_value, threshold_value, z_score, alert_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
          [tenantId, storeId, product.product_id, alertType, severity,
           title, description, day.units, mu.toFixed(4), absZ.toFixed(4), day.sale_date],
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
export async function runStockoutRiskDetection(tenantId, storeId) {
  const client = await getClient();
  const summary = { created: 0, skipped_no_velocity: 0, products_scanned: 0 };

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `WITH velocity AS (
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
         p.name                                              AS product_name,
         p.sku,
         p.reorder_threshold,
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
      [tenantId, storeId, ROLLING_WINDOW_DAYS],
    );

    summary.products_scanned = rows.length;

    for (const row of rows) {
      const daysRemaining  = row.days_remaining !== null ? Number(row.days_remaining) : null;
      const avgVelocity    = Number(row.avg_daily_velocity);
      const quantityOnHand = Number(row.quantity_on_hand);

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
         VALUES ($1,$2,$3,'stockout_risk',$4,$5,$6,$7,$8,NULL,CURRENT_DATE)
         ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
        [tenantId, storeId, row.product_id, severity, title, description,
         daysRemaining, STOCKOUT_RISK_DAYS],
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
export async function runLowStockDetection(tenantId, storeId) {
  const client = await getClient();
  const summary = { created: 0, skipped_no_threshold: 0, products_scanned: 0 };

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT
         p.id                             AS product_id,
         p.name                           AS product_name,
         p.sku,
         p.reorder_threshold,
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
         VALUES ($1,$2,$3,'low_stock',$4,$5,$6,$7,$8,NULL,CURRENT_DATE)
         ON CONFLICT ON CONSTRAINT uq_anomaly_per_product_per_day DO NOTHING`,
        [tenantId, storeId, row.product_id, severity, title, description,
         quantityOnHand, threshold],
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

  const [zScoreSummary, stockoutSummary, lowStockSummary] = await Promise.all([
    runZScoreDetection(tenantId, storeId),
    runStockoutRiskDetection(tenantId, storeId),
    runLowStockDetection(tenantId, storeId),
  ]);

  return {
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
    },
    productsScanned: {
      zScore:   zScoreSummary.products_scanned,
      stockout: stockoutSummary.products_scanned,
      lowStock: lowStockSummary.products_scanned,
    },
  };
}