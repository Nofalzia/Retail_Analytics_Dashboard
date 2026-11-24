/**
 * backend/scripts/demo/seedEmptyTenant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Ensure the onboarding demo tenant and its users exist.
 *
 * Why a third tenant: the live demo is "onboard a new store in two minutes" —
 * sign in to an empty store, drag a sales file onto Data Ingestion, watch the
 * analysis appear. london-bakers-i10 already holds its history, so uploading the
 * same data there would double-count every row. This tenant exists to be empty.
 *
 * Idempotent and non-destructive:
 *   1. find or create the tenant by slug, then RE-READ its slug and ABORT unless
 *      it is exactly the expected one;
 *   2. upsert one active store ("Main Branch") and two users (owner + manager),
 *      hashing Demo@1234 with bcryptjs exactly as src/seed.js does;
 *   3. print the tenant id, the store id, the table counts and the credentials.
 *
 * It never deletes business data; use resetTenantData.js for an intentional reset.
 *
 * Run from backend/:
 *   npm run demo:onboarding:seed
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import pool, { getClient, query } from '../../src/db/pool.js';

// ── Configuration ────────────────────────────────────────────────────────────

// Tenant identity — slug/name/currency/locale are configuration DATA, not schema.
const TENANT_SLUG     = 'demo-onboarding';
const TENANT_NAME     = 'New Tenant (No Data)';
const TENANT_CURRENCY = 'PKR';
const TENANT_LOCALE   = 'en-PK';
const STORE_NAME      = 'Main Branch';

const OWNER_EMAIL   = 'owner@onboarding.demo';
const MANAGER_EMAIL = 'manager@onboarding.demo';
const PASSWORD      = 'Demo@1234';
const BCRYPT_ROUNDS = 10;

// Every table holding tenant-scoped rows that the report prints. Users and stores
// are the only two that are expected to be non-zero after the seed.
const REPORT_TABLES = [
  'users',
  'stores',
  'categories',
  'products',
  'ingestion_jobs',
  'sale_transactions',
  'inventory_logs',
  'anomaly_alerts',
  'recommendations',
];

const DATA_TABLES = REPORT_TABLES.filter((table) => table !== 'users' && table !== 'stores');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** @param {number} value Integer to format. @returns {string} Thousands-separated string. */
function formatInt(value) {
  return Number(value).toLocaleString('en-US');
}

/**
 * Counts one tenant's rows in every business table, in a single round-trip.
 * @param {(text: string, params?: Array<*>) => Promise<{rows: Array<Object>}>} exec
 *   Query runner — a pool query function or a checked-out client's query.
 * @param {string} tenantId Tenant UUID to count.
 * @returns {Promise<Object<string, number>>} Table → row count.
 */
async function countTenantRows(exec, tenantId) {
  const selects = REPORT_TABLES
    .map((table) => `(SELECT count(*) FROM ${table} WHERE tenant_id = $1)::int AS ${table}`)
    .join(',\n              ');
  const { rows } = await exec(`SELECT ${selects}`, [tenantId]);
  return rows[0];
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Ensures the demo-onboarding tenant is provisioned. @returns {Promise<void>} */
async function main() {
  console.log('── New Tenant (No Data) · onboarding account ──────────────');
  console.log(`  slug : ${TENANT_SLUG}`);

  const client = await getClient();
  let tenantId;
  let storeId;

  try {
    await client.query('BEGIN');

    // ── 1. Tenant, then guard ────────────────────────────────────────────────
    const { rows: [upserted] } = await client.query(
      `INSERT INTO tenants (name, slug, currency_code, locale)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET
         name          = EXCLUDED.name,
         currency_code = EXCLUDED.currency_code,
         locale        = EXCLUDED.locale,
         is_active     = TRUE
       RETURNING id`,
      [TENANT_NAME, TENANT_SLUG, TENANT_CURRENCY, TENANT_LOCALE],
    );

    // Re-read and validate the database identity before writing seed accounts.
    const { rows: [tenant] } = await client.query(
      'SELECT id, slug, name FROM tenants WHERE id = $1',
      [upserted.id],
    );
    if (!tenant || tenant.slug !== TENANT_SLUG) {
      throw new Error(`refusing to seed: slug "${tenant?.slug ?? '(missing)'}" does not match "${TENANT_SLUG}"`);
    }
    tenantId = tenant.id;
    console.log(`  tenant : ${tenant.name} (${tenant.slug}) — ${tenantId}`);

    // ── 2. Store — users reference it, so it is upserted before them ──────────
    // No UNIQUE (tenant_id, name) on stores, so this is select-then-insert.
    // location stays NULL: nothing is invented.
    const { rows: storeRows } = await client.query(
      'SELECT id FROM stores WHERE tenant_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
      [tenantId, STORE_NAME],
    );
    if (storeRows.length > 0) {
      storeId = storeRows[0].id;
      await client.query('UPDATE stores SET is_active = TRUE WHERE id = $1', [storeId]);
    } else {
      const { rows: [store] } = await client.query(
        'INSERT INTO stores (tenant_id, name, location) VALUES ($1, $2, NULL) RETURNING id',
        [tenantId, STORE_NAME],
      );
      storeId = store.id;
    }

    // ── 3. Users — owner + manager, same hashing and upsert shape as seed.js ──
    const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [MANAGER_EMAIL, 'manager'],
    ]) {
      await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, email)
           DO UPDATE SET password_hash = EXCLUDED.password_hash,
                         role          = EXCLUDED.role,
                         store_id      = EXCLUDED.store_id,
                         is_active     = TRUE`,
        [tenantId, email, passwordHash, role, storeId],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // ── 4. Report what is actually in the database now ────────────────────────
  const counts = await countTenantRows(query, tenantId);
  const notEmpty = DATA_TABLES.filter((table) => Number(counts[table] ?? 0) !== 0);

  console.log('\n── Tenant verification ───────────────────────────────────');
  console.log(`  tenant id  : ${tenantId}`);
  console.log(`  slug       : ${TENANT_SLUG}`);
  console.log(`  store      : ${STORE_NAME}`);
  console.log(`  store id   : ${storeId}`);
  console.log(`  users      : ${formatInt(counts.users)}`);
  console.log(`  stores     : ${formatInt(counts.stores)}`);
  console.log(`  categories : ${formatInt(counts.categories)}`);
  console.log(`  products   : ${formatInt(counts.products)}`);
  console.log(`  sale rows  : ${formatInt(counts.sale_transactions)}`);
  console.log(`  inventory  : ${formatInt(counts.inventory_logs)}`);
  console.log(`  jobs       : ${formatInt(counts.ingestion_jobs)}`);
  console.log(`  state      : ${notEmpty.length === 0 ? 'BLANK — ready for a file upload demo' : 'HAS DATA — preserved'}`);
  console.log('\n  Credentials:');
  console.log(`    ${OWNER_EMAIL.padEnd(28)} / ${PASSWORD}   (owner)`);
  console.log(`    ${MANAGER_EMAIL.padEnd(28)} / ${PASSWORD}   (manager)`);

  if (notEmpty.length > 0) {
    console.log(`\n✅ Tenant users ready. Existing business data was preserved: ${notEmpty.join(', ')}.`);
  } else {
    console.log('\n✅ Empty tenant ready. Sign in and upload a data file.');
  }
}

main()
  .catch((err) => {
    console.error('\n❌ Seed failed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
