/**
 * services/recommendationEngine.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 4 rule-based recommendation engine.
 *
 * Turns unactioned anomaly_alerts into plain-language, actionable
 * recommendations. No machine learning — every number below is a documented,
 * auditable rule so the reasoning can be defended line-by-line.
 *
 * Called from:
 *   * routes/recommendations.js  POST /api/recommendations/generate
 *   * routes/alerts.js           POST /api/alerts/run-detection (after detection)
 *
 * The caller owns the transaction: this module only uses the `client` it is
 * handed and never commits or rolls back on its own.
 * ──────────────────────────────────────────────────────────────────────────────
 */

// ── Tunable constants (all rule-based) ───────────────────────────────────────
// Days between placing a supplier order and the stock arriving. Mirrors the
// Phase 3 stockout assumption in detectionEngine.js (STOCKOUT_RISK_DAYS).
const SUPPLIER_LEAD_TIME_DAYS = 7;
// Extra buffer carried on top of lead-time demand so ordinary day-to-day
// variance does not cause a stockout before the next delivery lands.
const SAFETY_STOCK_DAYS = 3;
// Rolling window used to turn sales history into a units/day velocity. Chosen to
// match the Phase 3 detector (two full retail weeks) so the numbers agree.
const VELOCITY_WINDOW_DAYS = 14;

// ── Priority model ───────────────────────────────────────────────────────────
//   priority = clamp( SEVERITY_BASE[severity] + urgencyBonus , 1 , 10 )
//
//   SEVERITY_BASE : critical 6, warning 4, info 2
//   urgencyBonus (0..4), computed differently per recommendation flavour:
//     * reorder (stockout) : bonus = round(4 * clamp((LEAD - daysRemaining)/LEAD, 0, 1))
//                            → the sooner stock runs out, the higher the rank
//     * everything else    : bonus = round(4 * clamp((|z| - Z_REF_MIN)/(Z_REF_MAX - Z_REF_MIN), 0, 1))
//                            → the larger the deviation, the higher the rank
//                              (a NULL z-score, e.g. low_stock, contributes 0)
//
// Lower number = more urgent (1 = highest, 10 = lowest), matching the table's
// CHECK (priority BETWEEN 1 AND 10).
const SEVERITY_BASE = { critical: 6, warning: 4, info: 2 };
const MAX_URGENCY_BONUS = 4;
const Z_REF_MIN = 1.5; // z at/below this adds no extra urgency
const Z_REF_MAX = 2.5; // z at/above this is maximally urgent

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// Bonus from how close a stockout is (reorder recommendations).
function leadTimeUrgency(daysRemaining) {
  const ratio = clamp((SUPPLIER_LEAD_TIME_DAYS - daysRemaining) / SUPPLIER_LEAD_TIME_DAYS, 0, 1);
  return Math.round(MAX_URGENCY_BONUS * ratio);
}

// Bonus from how extreme a z-score is (sales_drop / demand_surge).
function zScoreUrgency(zScore) {
  if (zScore === null || Number.isNaN(zScore)) return 0;
  const ratio = clamp((Math.abs(zScore) - Z_REF_MIN) / (Z_REF_MAX - Z_REF_MIN), 0, 1);
  return Math.round(MAX_URGENCY_BONUS * ratio);
}

function priorityFor(severity, bonus) {
  const base = SEVERITY_BASE[severity] ?? SEVERITY_BASE.info;
  return clamp(base + bonus, 1, 10);
}

/**
 * Build the full recommendation row (or null to skip) for a single alert.
 * Pure function — no DB access — so the rules stay easy to read and test.
 */
function buildRecommendation(alert) {
  const name = alert.product_name;
  const onHand = Number(alert.on_hand) || 0;
  const velocity = Number(alert.velocity) || 0;
  const unitPrice = Number(alert.standard_unit_price) || 0;
  const threshold = Number(alert.reorder_threshold) || 0;
  const zScore = alert.z_score === null || alert.z_score === undefined
    ? null
    : Number(alert.z_score);

  const alertDate = alert.alert_date;

  // ── Stockout risk → reorder ────────────────────────────────────────────────
  if (alert.alert_type === 'stockout_risk') {
    const coverDays = SUPPLIER_LEAD_TIME_DAYS + SAFETY_STOCK_DAYS; // 10 days
    const daysRemaining = velocity > 0 ? onHand / velocity : 0;
    const suggestedQuantity = Math.max(0, Math.ceil(velocity * coverDays - onHand));
    const revenueAtRisk = velocity * unitPrice
      * Math.max(0, SUPPLIER_LEAD_TIME_DAYS - daysRemaining);

    return {
      recType: 'reorder',
      title: `Reorder ${name}`,
      body:
        `About ${Math.round(velocity)} units a day are selling and ${onHand} are left. ` +
        `Order about ${suggestedQuantity} units to stay covered for ${coverDays} days.`,
      suggestedQuantity,
      revenueAtRisk,
      dueInDays: 0,
      priority: priorityFor(alert.severity, leadTimeUrgency(daysRemaining)),
    };
  }

  // ── Low stock → reorder back up to twice the reorder point ─────────────────
  if (alert.alert_type === 'low_stock') {
    const suggestedQuantity = Math.max(0, threshold * 2 - onHand);
    return {
      recType: 'low_stock',
      title: `Restock ${name}`,
      body:
        `Only ${onHand} units are left, below the reorder point of ${threshold} units. ` +
        `Order about ${suggestedQuantity} units to get back to twice the reorder point.`,
      suggestedQuantity,
      revenueAtRisk: null,
      dueInDays: 0,
      priority: priorityFor(alert.severity, zScoreUrgency(zScore)),
    };
  }

  // ── Z-score alert → sales_drop (negative z) / demand_surge (positive z) ────
  if (zScore !== null && zScore < 0) {
    return {
      recType: 'sales_drop',
      title: `Check why ${name} sales dropped`,
      body:
        `Sales of ${name} were unusually low on ${alertDate}. ` +
        'Check that it is in stock and on the shelf, that the price has not changed ' +
        'and that its display has not moved.',
      suggestedQuantity: null,
      revenueAtRisk: null,
      dueInDays: 2,
      priority: priorityFor(alert.severity, zScoreUrgency(zScore)),
    };
  }

  if (zScore !== null && zScore > 0) {
    return {
      recType: 'demand_surge',
      title: `Make sure you can keep up with ${name}`,
      body:
        `Sales of ${name} were unusually high on ${alertDate}. ` +
        'Check that you have enough stock cover so the extra demand ' +
        'does not turn into lost sales.',
      suggestedQuantity: null,
      revenueAtRisk: null,
      dueInDays: 2,
      priority: priorityFor(alert.severity, zScoreUrgency(zScore)),
    };
  }

  // Unrecognised alert type with no usable z-score — nothing actionable.
  return null;
}

/**
 * Generate pending recommendations for one tenant + store.
 *
 * Selects anomaly_alerts that are neither acknowledged nor dismissed and that do
 * not already have a recommendation (LEFT JOIN ... IS NULL), then inserts exactly
 * one recommendation per alert. Re-running is safe and idempotent thanks to
 *   ON CONFLICT ON CONSTRAINT uq_recommendation_per_alert DO NOTHING,
 * so an alert that already produced a recommendation is never duplicated.
 *
 * @param {import('pg').PoolClient} client  Checked-out client; the caller owns BEGIN/COMMIT.
 * @param {string} tenantId                  Tenant UUID (always taken from the JWT).
 * @param {string} storeId                   Store UUID to scope the run to.
 * @returns {Promise<number>}                Number of recommendation rows actually inserted.
 */
export async function generateRecommendations(client, tenantId, storeId) {
  const { rows: alerts } = await client.query(
    `SELECT
       aa.id,
       aa.alert_type,
       aa.severity,
       aa.alert_date::text          AS alert_date,
       aa.z_score,
       aa.product_id,
       p.name                       AS product_name,
       p.standard_unit_price,
       p.reorder_threshold,
       COALESCE(li.quantity_on_hand, 0) AS on_hand,
       COALESCE(vel.velocity, 0)        AS velocity
     FROM anomaly_alerts aa
     JOIN products p
       ON p.id = aa.product_id
      AND p.tenant_id = aa.tenant_id
     LEFT JOIN latest_inventory_per_product li
       ON li.tenant_id  = aa.tenant_id
      AND li.store_id   = aa.store_id
      AND li.product_id = aa.product_id
     LEFT JOIN LATERAL (
       SELECT SUM(v.units_sold_on_day) / $3::numeric AS velocity
       FROM product_daily_velocity v
       WHERE v.tenant_id  = aa.tenant_id
         AND v.store_id   = aa.store_id
         AND v.product_id = aa.product_id
         AND v.sale_date >= CURRENT_DATE - MAKE_INTERVAL(days => $3::int)
     ) vel ON TRUE
     LEFT JOIN recommendations r ON r.alert_id = aa.id
     WHERE aa.tenant_id = $1
       AND aa.store_id  = $2
       AND aa.acknowledged_at IS NULL
       AND aa.dismissed_at    IS NULL
       AND r.id IS NULL
     ORDER BY aa.alert_date DESC, aa.created_at DESC`,
    [tenantId, storeId, VELOCITY_WINDOW_DAYS],
  );

  let inserted = 0;

  for (const alert of alerts) {
    const rec = buildRecommendation(alert);
    if (!rec) continue;

    const { rowCount } = await client.query(
      `INSERT INTO recommendations
         (tenant_id, store_id, alert_id, product_id, rec_type, priority,
          title, body, suggested_quantity, revenue_at_risk, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, CURRENT_DATE + $11::int)
       ON CONFLICT ON CONSTRAINT uq_recommendation_per_alert DO NOTHING`,
      [
        tenantId,
        storeId,
        alert.id,
        alert.product_id,
        rec.recType,
        rec.priority,
        rec.title,
        rec.body,
        rec.suggestedQuantity,
        rec.revenueAtRisk,
        rec.dueInDays,
      ],
    );

    inserted += rowCount;
  }

  return inserted;
}
