/**
 * src/utils/resolveStoreId.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Single source of truth for "which store should this query be scoped to?".
 *
 * Store ids are generated per tenant at seed time, so they cannot live in
 * frontend config — every live view reads the signed-in account's `storeId`
 * claim (`useAuth().user.storeId`) and passes it through here.
 *
 * The one exception is the seeded demo tenant (`demo-kiryana`): its mock
 * preview datasets and older tokens were written around a fixed UUID, so a
 * missing claim falls back to that constant for that tenant only. Any other
 * tenant with no store id resolves to null, and the caller shows the
 * not-linked-to-a-store notice instead of querying another tenant's store.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Legacy store UUID of the seeded demo tenant. Matches the seed data in
 * backend/db/schema.sql and is only ever reached for `demo-kiryana`.
 */
export const DEMO_STORE_ID = '00000000-0000-0000-0000-000000000010';

/** Slug of the seeded demo tenant the mock datasets were written for. */
const DEMO_TENANT_SLUG = 'demo-kiryana';

/**
 * Resolves the store a live query should be scoped to.
 * @param {string|null|undefined} storeId Store UUID from the JWT / login response.
 * @param {string|null|undefined} tenantSlug Tenant slug of the signed-in account.
 * @returns {string|null} A store UUID, or null when the account has no store.
 */
export function resolveStoreId(storeId, tenantSlug) {
  if (storeId) return storeId;
  // Only the seeded demo tenant keeps the historic constant for its mocks.
  if (tenantSlug === DEMO_TENANT_SLUG) return DEMO_STORE_ID;
  return null;
}

export default resolveStoreId;
