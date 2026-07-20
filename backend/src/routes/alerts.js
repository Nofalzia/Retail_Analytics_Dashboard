/**
 * routes/alerts.js
 * ──────────────────────────────────────────────────────────────────────────────
 * GET    /api/alerts          — list active (unactioned) alerts
 * PATCH  /api/alerts/:id/ack  — acknowledge an alert (manager/owner only)
 * PATCH  /api/alerts/:id/dismiss — dismiss an alert (manager/owner only)
 *
 * Phase 3 will add a POST /api/alerts/run-detection endpoint that triggers
 * the z-score anomaly detection engine and writes new rows to anomaly_alerts.
 * The GET endpoint below will immediately surface them without any other changes.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }       from 'express';
import { requireAuth }  from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { requireRole }  from '../middleware/auth.js';
import { query }        from '../db/pool.js';

const router = Router();

// ── GET /api/alerts ───────────────────────────────────────────────────────────
router.get('/', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId }  = req;
  const storeId       = req.query.storeId || null;
  const limit         = Math.min(parseInt(req.query.limit) || 20, 100);

  try {
    const storeFilter = storeId ? 'AND aa.store_id = $2' : '';
    const params      = storeId ? [tenantId, storeId] : [tenantId];

    const { rows } = await query(
      `SELECT *
       FROM active_anomaly_alerts aa
       WHERE aa.tenant_id = $1
         ${storeFilter}
       LIMIT ${limit}`,
      params,
    );

    // Group by severity for the summary badge counts the UI shows
    const summary = rows.reduce(
      (acc, row) => { acc[row.severity] = (acc[row.severity] || 0) + 1; return acc; },
      { critical: 0, warning: 0, info: 0 },
    );

    return res.json({ alerts: rows, summary, total: rows.length });
  } catch (err) {
    console.error('[alerts] GET error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR' });
  }
});

// ── PATCH /api/alerts/:id/ack ────────────────────────────────────────────────
router.patch(
  '/:id/ack',
  requireAuth,
  resolveTenant,
  requireRole('manager', 'owner'),
  async (req, res) => {
    const { tenantId } = req;
    const { id }       = req.params;

    try {
      const { rows } = await query(
        `UPDATE anomaly_alerts
         SET acknowledged_at = NOW(), acknowledged_by = $3
         WHERE id = $1 AND tenant_id = $2
           AND acknowledged_at IS NULL
         RETURNING id, acknowledged_at`,
        [id, tenantId, req.user.id],
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Alert not found or already acknowledged.' });
      }
      return res.json({ success: true, alert: rows[0] });
    } catch (err) {
      console.error('[alerts] PATCH ack error:', err.message);
      return res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

// ── PATCH /api/alerts/:id/dismiss ────────────────────────────────────────────
router.patch(
  '/:id/dismiss',
  requireAuth,
  resolveTenant,
  requireRole('manager', 'owner'),
  async (req, res) => {
    const { tenantId } = req;
    const { id }       = req.params;

    try {
      const { rows } = await query(
        `UPDATE anomaly_alerts
         SET dismissed_at = NOW(), dismissed_by = $3
         WHERE id = $1 AND tenant_id = $2
           AND dismissed_at IS NULL
         RETURNING id, dismissed_at`,
        [id, tenantId, req.user.id],
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Alert not found or already dismissed.' });
      }
      return res.json({ success: true, alert: rows[0] });
    } catch (err) {
      console.error('[alerts] PATCH dismiss error:', err.message);
      return res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

export default router;
