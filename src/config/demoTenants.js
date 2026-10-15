/**
 * src/config/demoTenants.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Directory of the demo tenants the store switcher can sign into.
 *
 * Tenants are data, never code: nothing here names an industry, and no password
 * is stored. The switcher only parks the slug + email of the chosen store in
 * sessionStorage so the sign-in screen can prefill them — the user still types
 * the password themselves.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * @typedef {Object} DemoUser
 * @property {string} label Role label for the quick sign-in chip. Comes from
 *   tenant config so no industry term ever appears in code ('Cashier', 'Manager',
 *   'Owner' are generic staff roles, matching the API's role column).
 * @property {string} email Account that exists for that tenant.
 */

/**
 * @typedef {Object} DemoTenant
 * @property {string} label Human-readable store name shown in the UI.
 * @property {string} slug  Value posted to /api/auth/login as `tenantSlug`.
 * @property {string} email Owner email that exists for that tenant.
 * @property {DemoUser[]} users Demo accounts the quick sign-in chips offer.
 */

/** @type {DemoTenant[]} */
export const DEMO_TENANTS = [
  {
    label: 'Demo Kiryana Store',
    slug: 'demo-kiryana',
    email: 'owner@demo.com',
    users: [
      { label: 'Owner',   email: 'owner@demo.com' },
      { label: 'Manager', email: 'manager@demo.com' },
    ],
  },
  {
    label: 'London Bakers I-10',
    slug: 'london-bakers-i10',
    email: 'owner@londonbakers.demo',
    users: [
      { label: 'Cashier', email: 'cashier@londonbakers.demo' },
      { label: 'Manager', email: 'manager@londonbakers.demo' },
      { label: 'Owner',   email: 'owner@londonbakers.demo' },
    ],
  },
];

/**
 * The tenant the mocked preview states (Healthy Store / Struggling Store /
 * New Tenant) were written against. Those mock datasets only describe the
 * seeded demo store, so every other tenant always shows live data.
 */
export const PRIMARY_DEMO_SLUG = DEMO_TENANTS[0].slug;

/**
 * Looks up a demo tenant by slug.
 * @param {string|null|undefined} slug Tenant slug.
 * @returns {DemoTenant|undefined} The matching entry, if any.
 */
export const findDemoTenantBySlug = (slug) => DEMO_TENANTS.find((tenant) => tenant.slug === slug);

/**
 * Demo accounts of one tenant, for the quick sign-in chips. Unknown slugs simply
 * offer no chips. No password is stored here — the chips read it from
 * VITE_DEMO_PASSWORD (see .env.example).
 * @param {string|null|undefined} slug Tenant slug typed or picked on the form.
 * @returns {DemoUser[]} The tenant's demo users, or [] when the slug is unknown.
 */
export const findDemoUsersBySlug = (slug) => findDemoTenantBySlug(slug)?.users ?? [];

export default DEMO_TENANTS;
