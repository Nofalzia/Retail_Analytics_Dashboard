/**
 * middleware/tenant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Enforces multi-tenant data isolation.
 *
 * The active tenant header is sent for every authenticated API request. Regular
 * users may only request the tenant in their verified JWT; system administrators
 * may select another active tenant after its existence is checked.
 *
 * Every route handler MUST use req.tenantId in all database queries.
 * There must be no route that queries business data without this filter.
 *
 * Architectural principle (from Phase 2 design):
 *   Tenant isolation is enforced in the middleware layer, not by trusting
 *   headers blindly. The tenantId comes from the signed JWT — which only
 *   the server can issue — not from anything the client sends in the body.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { query } from '../db/pool.js';

/**
 * resolveTenant
 * Must be used after requireAuth (which populates req.user).
 */
export async function resolveTenant(req, res, next) {
  try {
    const { role, tenantId: jwtTenantId } = req.user;
    const requestedTenantId = req.headers['x-tenant-id'];

    if (requestedTenantId && requestedTenantId !== jwtTenantId) {
      if (role !== 'system_admin') {
        return res.status(403).json({
          error: 'TENANT_MISMATCH',
          message: 'The requested tenant is not available to this account.',
        });
      }

      const { rows } = await query(
        'SELECT id FROM tenants WHERE id = $1 AND is_active = TRUE',
        [requestedTenantId],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: 'TENANT_NOT_FOUND',
          message: 'The specified tenant does not exist or is inactive.',
        });
      }

      req.tenantId = requestedTenantId;
      return next();
    }

    // All other roles: tenantId is always taken from the JWT, never the request.
    if (!jwtTenantId) {
      return res.status(403).json({
        error: 'NO_TENANT',
        message: 'This account is not associated with a tenant.',
      });
    }

    req.tenantId = jwtTenantId;
    return next();
  } catch (err) {
    console.error('[middleware/tenant] Error resolving tenant:', err.message);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Could not resolve tenant context.' });
  }
}
