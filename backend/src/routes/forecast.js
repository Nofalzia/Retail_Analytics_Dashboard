/**
 * routes/forecast.js
 * ──────────────────────────────────────────────────────────────────────────────
 * GET /api/forecast
 *
 * Per-product daily demand for the next `horizonDays` days (default 7), computed
 * by services/forecastService.js on the store's own history.
 *
 * This is the demand view behind Stockout Watch: the same service the stockout
 * route consults when FORECAST_ENGINE=holt_winters. With the default engine it
 * returns the velocity baseline instead (method 'velocity'), so the endpoint
 * always describes what the dashboard is actually using rather than a second,
 * differently-configured opinion.
 *
 * Query params:
 *   storeId      — UUID (required)
 *   horizonDays  — days to project, 1–14 (default: 7)
 *   historyDays  — days fitted, 14–120 (default: 28)
 *   velocityDays — baseline window, 1–90 (default: 14, matches /api/stockout)
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { requireAuth, requireDashboardRead } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query } from '../db/pool.js';
import {
  DEFAULT_HISTORY_DAYS,
  DEFAULT_VELOCITY_DAYS,
  FORECAST_HORIZON_DAYS,
  forecastDailyDemand,
} from '../services/forecastService.js';

const router = Router();

/** @returns {number} `value` clamped into [min, max], or `fallback` when absent. */
function clampParam(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

// Read-only route: owner / manager / system_admin only.
router.get('/', requireAuth, resolveTenant, requireDashboardRead, async (req, res) => {
  const { tenantId } = req;
  const storeId = req.query.storeId;

  if (!storeId) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'storeId is required.' });
  }

  const horizonDays  = clampParam(req.query.horizonDays, FORECAST_HORIZON_DAYS, 1, 14);
  const historyDays  = clampParam(req.query.historyDays, DEFAULT_HISTORY_DAYS, 14, 120);
  const velocityDays = clampParam(req.query.velocityDays, DEFAULT_VELOCITY_DAYS, 1, 90);

  try {
    const forecast = await forecastDailyDemand(query, tenantId, storeId, {
      horizonDays, historyDays, velocityDays,
    });
    return res.json(forecast);
  } catch (err) {
    console.error('[forecast] Query error:', err.message);
    return res.status(500).json({
      error: 'QUERY_ERROR',
      message: 'Failed to forecast demand.',
    });
  }
});

export default router;
