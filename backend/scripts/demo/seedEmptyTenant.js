/**
 * backend/scripts/demo/seedEmptyTenant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T12g — create the BLANK onboarding demo tenant ("New Store (Demo)").
 *
 * Why a third tenant: the live demo is "onboard a new store in two minutes" —
 * sign in to an empty store, drag a sales file onto Data Ingestion, watch the
 * analysis appear. london-bakers-i10 already holds its history, so uploading the
 * same data there would double-count every row. This tenant exists to be empty.
 *
 * Idempotent, and blanking for THIS tenant only:
 *   1. find or create the tenant by slug, then RE-READ its slug and ABORT unless
 *      it is exactly the expected one — this happens BEFORE any DELETE;
 *   2. inside one transaction, delete ONLY that tenant's recommendations,
 *      anomaly_alerts, sale_transactions, inventory_logs, ingestion_jobs,
 *      products and categories — so a re-run also returns a store that was
 *      already demonstrated on to a blank slate;
 *   3. upsert one active store ("Main Branch") and two users (owner + manager),
 *      hashing Demo@1234 with bcryptjs exactly as src/seed.js does;
 *   4. print the tenant id, the store id, the table counts and the credentials.
 *
 * Nothing else is created: no categories, no products, no sale rows, no inventory.
 * Users and stores are upserted, never deleted, so no duplicate rows appear.
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
const TENANT_NAME     = 'New Store (Demo)';
const TENANT_CURRENCY = 'PKR';
const TENANT_LOCALE   = 'en-PK';
const STORE_NAME      = 'Main Branch';

const OWNER_EMAIL   = 'owner@onboarding.demo';
const MANAGER_EMAIL = 'manager@onboarding.demo';
const PASSWORD      = 'Demo@1234';
const BCRYPT_ROUNDS = 10;

// Deleted on every run, in this order: recommendations → anomaly_alerts →
// sale_transactions → inventory_logs → ingestion_jobs → products → categories.
// Sale and inventory rows both RESTRICT the product FK, so they must go first;
// ingestion_jobs is referenced by both of them, and products by categories.
const RESET_TABLES = [
  'recommendations',
  'anomaly_alerts',
  'sale_transactions',
  'inventory_logs',
  'ingestion_jobs',
  'products',
  'categories',
];

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

/**
 * Formats a snapshot as one line: "table=count, table=count, ...".
 * @param {Object<string, number>|null} counts Snapshot.
 * @returns {string} Human-readable snapshot.
 */
function formatCounts(counts) {
  if (!counts) return '(tenant not found)';
  return REPORT_TABLES.map((table) => `${table}=${formatInt(counts[table] ?? 0)}`).join(', ');
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Creates or re-blanks the demo-onboarding tenant. @returns {Promise<void>} */
async function main() {
  console.log('── New Store (Demo) · blank onboarding tenant ─────────────');
  console.log(`  slug : ${TENANT_SLUG}`);

  const client = await getClient();
  let tenantId;
  let storeId;

  try {
    await client.query('BEGIN');

    // ── 1. Tenant, then guard. No DELETE may run before this check passes ─────
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

    // Re-read the slug from the database itself (not from the RETURNING clause) so
    // a poisoned or mis-addressed row can never reach the DELETE statements below.
    const { rows: [tenant] } = await client.query(
      'SELECT id, slug, name FROM tenants WHERE id = $1',
      [upserted.id],
    );
    if (!tenant || tenant.slug !== TENANT_SLUG) {
      throw new Error(`refusing to seed: slug "${tenant?.slug ?? '(missing)'}" does not match "${TENANT_SLUG}"`);
    }
    tenantId = tenant.id;
    console.log(`  tenant : ${tenant.name} (${tenant.slug}) — ${tenantId}`);

    // ── 2. Blank ONLY this tenant's data ──────────────────────────────────────
    for (const table of RESET_TABLES) {
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      console.log(`  reset  ${table.padEnd(18)} ${formatInt(rowCount)} row(s) deleted`);
    }

    // ── 3. Store — users reference it, so it is upserted before them ──────────
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

    // ── 4. Users — owner + manager, same hashing and upsert shape as seed.js ──
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

  // ── 5. Report what is actually in the database now ────────────────────────
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
  console.log('  state      : BLANK — ready for a file upload demo');
  console.log('\n  Credentials:');
  console.log(`    ${OWNER_EMAIL.padEnd(28)} / ${PASSWORD}   (owner)`);
  console.log(`    ${MANAGER_EMAIL.padEnd(28)} / ${PASSWORD}   (manager)`);

  if (notEmpty.length > 0) {
    console.log(`\n  ❌ expected an empty tenant, but these tables have rows: ${notEmpty.join(', ')}`);
    console.log(`  counts: ${formatCounts(counts)}`);
    process.exitCode = 1;
    return;
  }

  console.log('\n✅ Blank tenant ready. Sign in and upload a sales file — nothing here');
  console.log('   can be double-counted, because there is nothing here yet.');
}

main()
  .catch((err) => {
    console.error('\n❌ Seed failed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
