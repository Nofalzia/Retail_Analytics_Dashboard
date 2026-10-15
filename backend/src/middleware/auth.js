/**
 * middleware/auth.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Verifies the Bearer JWT on every protected route.
 * On success, attaches req.user = { id, tenantId, role, storeId } so that
 * downstream route handlers never have to re-query the database for identity.
 *
 * The tenant.js middleware runs AFTER this one and uses req.user.tenantId
 * to enforce data isolation.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import jwt from 'jsonwebtoken';

/**
 * requireAuth
 * Rejects any request without a valid, unexpired JWT in the Authorization header.
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: 'UNAUTHORIZED',
      message: 'Authorization header missing or malformed. Expected: Bearer <token>',
    });
  }

  const token = authHeader.slice(7); // strip "Bearer "

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Attach decoded identity to the request object.
    // All downstream middleware and route handlers can read from req.user.
    req.user = {
      id:       payload.sub,        // user UUID
      tenantId: payload.tenantId,   // tenant UUID — used by tenant.js
      role:     payload.role,       // 'owner' | 'manager' | 'data_entry_clerk' | 'system_admin'
      storeId:  payload.storeId || null, // UUID or null for cross-store roles
    };

    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'TOKEN_EXPIRED', message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'INVALID_TOKEN', message: 'Token is invalid.' });
  }
}

/**
 * requireRole(...roles, options?)
 * Factory that returns middleware restricting a route to specific roles.
 *
 * Usage:
 *   router.delete('/alerts/:id', requireAuth, requireRole('manager', 'owner'), handler)
 *
 * An optional trailing object overrides the denial message for a route that is
 * read-only ("you may not look at this" rather than "this action requires ..."):
 *   requireRole('owner', 'manager', { message: 'Your role cannot view this.' })
 * Existing callers pass roles only and keep the original message unchanged.
 *
 * @param {...(string|{message?: string})} signature Role names, plus an optional options object.
 * @returns {import('express').RequestHandler} Express middleware.
 */
export function requireRole(...args) {
  const lastIsOptions = args.length > 0
    && typeof args[args.length - 1] === 'object'
    && args[args.length - 1] !== null;
  const options       = lastIsOptions ? args.pop() : {};
  const allowedRoles  = args;
  const deniedMessage = options.message
    || `This action requires one of the following roles: ${allowedRoles.join(', ')}.`;

  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Not authenticated.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: deniedMessage });
    }
    return next();
  };
}

/**
 * requireDashboardRead
 * Guard for the dashboard READ routes (overview, stockout, alerts,
 * recommendations): owner, manager and system_admin may read; data_entry_clerk
 * may upload data but not read dashboards. Built from requireRole so there is
 * still exactly one role-check implementation.
 */
export const requireDashboardRead = requireRole(
  'owner',
  'manager',
  'system_admin',
  { message: 'Your role cannot view this.' },
);
