/**
 * routes/recommendations.js
 * ──────────────────────────────────────────────────────────────────────────────
 * GET    /api/recommendations            — pending recommendations for a store
 * PATCH  /api/recommendations/:id/complete — mark a recommendation done
 * POST   /api/recommendations/generate   — run the rule engine on demand
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { query, getClient } from '../db/pool.js';
import { generateRecommendations } from '../services/recommendationEngine.js';

const router = Router();

// ── GET /api/recommendations?storeId= ─────────────────────────────────────────
router.get('/', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId } = req;
  const storeId = req.query.storeId || null;

  if (!storeId) {
    return res.status(400).json({ error: 'MISSING_PARAM', message: 'storeId is required.' });
  }

  try {
    const { rows } = await query(
      `SELECT
         r.id,
         r.product_id,
         p.name           AS product_name,
         r.rec_type,
         r.title,
         r.body,
         r.priority,
         r.due_date,
         r.suggested_quantity,
         r.revenue_at_risk,
         r.alert_id,
         r.created_at
       FROM recommendations r
       LEFT JOIN products p ON p.id = r.product_id
       WHERE r.tenant_id = $1
         AND r.store_id  = $2
         AND r.completed_at IS NULL
       ORDER BY r.priority DESC, r.due_date ASC NULLS LAST
       LIMIT 100`,
      [tenantId, storeId],
    );

    return res.json({ recommendations: rows, total: rows.length });
  } catch (err) {
    console.error('[recommendations] GET error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR' });
  }
});

// ── PATCH /api/recommendations/:id/complete ───────────────────────────────────
router.patch(
  '/:id/complete',
  requireAuth,
  resolveTenant,
  requireRole('manager', 'owner'),
  async (req, res) => {
    const { tenantId } = req;
    const { id } = req.params;

    try {
      const { rows } = await query(
        `UPDATE recommendations
         SET completed_at = NOW(), completed_by = $3
         WHERE id = $1 AND tenant_id = $2 AND completed_at IS NULL
         RETURNING id, completed_at`,
        [id, tenantId, req.user.id],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: 'NOT_FOUND',
          message: 'Recommendation not found or already completed.',
        });
      }
      return res.json({ success: true, recommendation: rows[0] });
    } catch (err) {
      console.error('[recommendations] PATCH complete error:', err.message);
      return res.status(500).json({ error: 'UPDATE_ERROR' });
    }
  },
);

// ── POST /api/recommendations/generate?storeId= ───────────────────────────────
router.post(
  '/generate',
  requireAuth,
  resolveTenant,
  requireRole('manager', 'owner'),
  async (req, res) => {
    const { tenantId } = req;
    const storeId = req.query.storeId || req.body?.storeId;

    if (!storeId) {
      return res.status(400).json({
        error: 'MISSING_PARAM',
        message: 'storeId is required as a query parameter or in the request body.',
      });
    }

    const client = await getClient();
    try {
      await client.query('BEGIN');
      const inserted = await generateRecommendations(client, tenantId, storeId);
      await client.query('COMMIT');
      return res.json({ inserted });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[recommendations] generate error:', err.message);
      return res.status(500).json({
        error: 'GENERATION_ERROR',
        message: 'Recommendation engine encountered an error. Check server logs.',
      });
    } finally {
      client.release();
    }
  },
);

export default router;
