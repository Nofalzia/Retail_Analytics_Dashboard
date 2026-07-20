/**
 * middleware/tenant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Enforces multi-tenant data isolation.
 *
 * This middleware runs after requireAuth and does two things:
 *   1. Sets req.tenantId from the verified JWT payload (NOT from a request
 *      header — a client cannot claim to be a different tenant this way).
 *   2. For system_admin users, allows an optional x-tenant-id header override
 *      so admins can view/manage any tenant's data via the DataIngestionHub.
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

    // System administrators can operate across tenants by supplying a header.
    // This is used by the DataIngestionHub to manage tenant data.
    if (role === 'system_admin' && req.headers['x-tenant-id']) {
      const overrideTenantId = req.headers['x-tenant-id'];

      // Verify the override tenant actually exists — don't trust the header blindly.
      const { rows } = await query(
        'SELECT id FROM tenants WHERE id = $1 AND is_active = TRUE',
        [overrideTenantId],
      );

      if (rows.length === 0) {
        return res.status(404).json({
          error: 'TENANT_NOT_FOUND',
          message: 'The specified tenant does not exist or is inactive.',
        });
      }

      req.tenantId = overrideTenantId;
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
