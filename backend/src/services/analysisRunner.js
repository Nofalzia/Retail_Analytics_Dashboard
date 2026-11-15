/**
 * services/analysisRunner.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 4 orchestration: detect, then advise — in one call.
 *
 * Two callers need exactly the same work and must never drift apart:
 *   * routes/alerts.js      POST /api/alerts/run-detection  (the manual button)
 *   * routes/upload.js      parsePipeline                   (T12d: automatic)
 *
 * So the sequence lives here once:
 *   1. runAllDetection() runs the three rule-based detectors (z-score,
 *      stockout risk, low stock) and reports what it wrote.
 *   2. generateRecommendations() turns the alerts that still have no
 *      recommendation into plain-language advice, inside ONE transaction.
 *
 * Every window in both engines is anchored to the same as-of date (the store's
 * latest sale date, or today when the store has no sales), so the alerts and the
 * recommendations produced by a single run describe the same moment.
 *
 * Dedup is already enforced by the schema, not by this module:
 *   * anomaly_alerts   — uq_anomaly_per_product_per_day
 *                        (tenant, store, product, alert_type, alert_date)
 *   * recommendations  — uq_recommendation_per_alert (alert_id)
 * Both inserts are ON CONFLICT DO NOTHING, so running this twice on the same
 * data writes nothing the second time and returns 0/0.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { getClient } from '../db/pool.js';
import { runAllDetection } from './detectionEngine.js';
import { generateRecommendations } from './recommendationEngine.js';

/**
 * Run every detection engine for one store, then generate the recommendations
 * its fresh alerts imply.
 *
 * Throws when either engine throws — the caller decides what a failure means
 * (an HTTP 500 on the manual route, an `_analysis.error` note on an import).
 *
 * @param {string} tenantId Tenant UUID, always taken from the JWT by the caller.
 * @param {string} storeId  Store UUID to scope the run to.
 * @returns {Promise<{
 *   asOfDate: string,
 *   alertsCreated: number,
 *   recommendationsCreated: number,
 *   runSummary: Object,
 * }>} `alertsCreated` is the total across all three detectors (the per-engine
 *   breakdown stays in `runSummary.alertsCreated` for the manual route's
 *   existing response shape).
 */
export async function runAnalysis(tenantId, storeId) {
  const runSummary = await runAllDetection(tenantId, storeId);
  const alertsCreated = runSummary.alertsCreated.total;

  // The recommendation engine uses the client it is handed and never commits on
  // its own, so the caller owns the transaction (see recommendationEngine.js).
  const client = await getClient();
  let recommendationsCreated = 0;
  try {
    await client.query('BEGIN');
    recommendationsCreated = await generateRecommendations(
      client, tenantId, storeId, runSummary.asOfDate,
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    asOfDate: runSummary.asOfDate,
    alertsCreated,
    recommendationsCreated,
    runSummary,
  };
}

export default runAnalysis;
