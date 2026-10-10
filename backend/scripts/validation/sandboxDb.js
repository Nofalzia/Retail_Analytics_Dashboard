/**
 * backend/scripts/validation/sandboxDb.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Isolated database sandbox for the detection-validation harness (T7a).
 *
 * The sandbox is a dedicated tenant (slug 'validation-sandbox') holding one
 * store, one category and the 20 synthetic products. Sale rows and alerts for
 * that tenant are deleted and re-created on every seed, so the harness can call
 * the REAL engine without disturbing any other tenant's data.
 *
 * SAFETY CONTRACT
 *   * `assertSandboxTenant()` re-reads the tenant's slug from the database and
 *     throws before any delete if it is not exactly 'validation-sandbox'.
 *   * Every DELETE in this module is scoped with `WHERE tenant_id = $1`.
 *   * No other tenant is ever read, written or deleted.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import pool, { query } from '../../src/db/pool.js';

export const SANDBOX_TENANT_SLUG = 'validation-sandbox';
export const SANDBOX_TENANT_NAME = 'Validation Sandbox (synthetic)';
export const SANDBOX_STORE_NAME = 'Validation Sandbox Store';
export const SANDBOX_CATEGORY_NAME = 'Validation Category';
export const SANDBOX_USER_EMAIL = 'sandbox@validation.invalid';
export const SANDBOX_JOB_FILENAME = 'validation_synthetic_sales.csv';
export const SANDBOX_CHUNK_SIZE = 500;

// ingestion_jobs.uploaded_by is NOT NULL, so the sandbox needs a user row. Its
// password_hash is a deliberately unusable placeholder (never a real bcrypt
// hash) — this account cannot be logged into.
const SANDBOX_PASSWORD_PLACEHOLDER = 'x-validation-sandbox-no-login';

/**
 * Asserts that a tenant id really is the validation sandbox.
 * @param {string} tenantId Tenant UUID to verify.
 * @returns {Promise<true>} True when the slug matches.
 * @throws {Error} If the tenant is missing or has a different slug.
 */
export async function assertSandboxTenant(tenantId) {
  const { rows } = await query('SELECT slug FROM tenants WHERE id = $1', [tenantId]);
  if (rows.length === 0) throw new Error(`sandbox tenant ${tenantId} not found`);
  if (rows[0].slug !== SANDBOX_TENANT_SLUG) {
    throw new Error(
      `SAFETY ABORT: tenant ${tenantId} has slug "${rows[0].slug}", expected "${SANDBOX_TENANT_SLUG}"`,
    );
  }
  return true;
}

/**
 * Creates (idempotently) the sandbox tenant, store, category, products and the
 * ingestion job that sale rows must reference.
 * @param {{products: Array<{sku: string, name: string}>}} dataset Dataset from generateDataset.
 * @returns {Promise<{tenantId: string, tenantSlug: string, storeId: string, categoryId: string,
 *   productIds: Map<string, string>, userId: string, ingestionJobId: string}>} Sandbox handles.
 */
export async function ensureSandbox(dataset) {
  const { rows: [tenant] } = await query(
    `INSERT INTO tenants (name, slug, currency_code, locale)
     VALUES ($1, $2, 'PKR', 'en-PK')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [SANDBOX_TENANT_NAME, SANDBOX_TENANT_SLUG],
  );
  const tenantId = tenant.id;
  await assertSandboxTenant(tenantId);

  const storeId = await upsertStore(tenantId);
  const categoryId = await upsertCategory(tenantId);
  const productIds = await upsertProducts(tenantId, categoryId, dataset.products);
  const userId = await upsertUser(tenantId, storeId);
  const ingestionJobId = await ensureIngestionJob(tenantId, storeId, userId);

  return {
    tenantId,
    tenantSlug: SANDBOX_TENANT_SLUG,
    storeId,
    categoryId,
    productIds,
    userId,
    ingestionJobId,
  };
}

/** @returns {Promise<string>} Store UUID (created once, reused afterwards). */
async function upsertStore(tenantId) {
  const existing = await query(
    'SELECT id FROM stores WHERE tenant_id = $1 AND name = $2 LIMIT 1',
    [tenantId, SANDBOX_STORE_NAME],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const { rows: [store] } = await query(
    'INSERT INTO stores (tenant_id, name, location) VALUES ($1, $2, $3) RETURNING id',
    [tenantId, SANDBOX_STORE_NAME, 'Synthetic data — not a real location'],
  );
  return store.id;
}

/** @returns {Promise<string>} Category UUID. */
async function upsertCategory(tenantId) {
  const { rows: [category] } = await query(
    `INSERT INTO categories (tenant_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [tenantId, SANDBOX_CATEGORY_NAME],
  );
  return category.id;
}

/** @returns {Promise<Map<string, string>>} sku → product id. */
async function upsertProducts(tenantId, categoryId, products) {
  const productIds = new Map();
  for (const product of products) {
    const { rows: [row] } = await query(
      `INSERT INTO products
         (tenant_id, category_id, name, sku, standard_unit_cost, standard_unit_price, reorder_threshold)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, sku)
         DO UPDATE SET name = EXCLUDED.name, category_id = EXCLUDED.category_id
       RETURNING id`,
      [tenantId, categoryId, product.name, product.sku, 60, 100, 10],
    );
    productIds.set(product.sku, row.id);
  }
  return productIds;
}

/** @returns {Promise<string>} User UUID satisfying ingestion_jobs.uploaded_by. */
async function upsertUser(tenantId, storeId) {
  const { rows: [user] } = await query(
    `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
     VALUES ($1, $2, $3, 'data_entry_clerk', $4)
     ON CONFLICT (tenant_id, email) DO UPDATE SET store_id = EXCLUDED.store_id
     RETURNING id`,
    [tenantId, SANDBOX_USER_EMAIL, SANDBOX_PASSWORD_PLACEHOLDER, storeId],
  );
  return user.id;
}

/** @returns {Promise<string>} Ingestion job UUID (reused across runs). */
async function ensureIngestionJob(tenantId, storeId, userId) {
  const existing = await query(
    `SELECT id FROM ingestion_jobs
      WHERE tenant_id = $1 AND store_id = $2 AND original_filename = $3
      ORDER BY started_at ASC LIMIT 1`,
    [tenantId, storeId, SANDBOX_JOB_FILENAME],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const { rows: [job] } = await query(
    `INSERT INTO ingestion_jobs
       (tenant_id, store_id, uploaded_by, original_filename, file_type, status,
        total_rows, rows_processed, completed_at)
     VALUES ($1, $2, $3, $4, 'csv', 'completed', 0, 0, NOW())
     RETURNING id`,
    [tenantId, storeId, userId, SANDBOX_JOB_FILENAME],
  );
  return job.id;
}

/**
 * Deletes ONLY this tenant's sale_transactions and anomaly_alerts.
 * @param {{tenantId: string}} sandbox Sandbox handles.
 * @returns {Promise<{salesDeleted: number, alertsDeleted: number}>} Rows removed.
 * @throws {Error} If the tenant id does not belong to the validation sandbox.
 */
export async function resetSandboxData(sandbox) {
  await assertSandboxTenant(sandbox.tenantId);

  const alerts = await query('DELETE FROM anomaly_alerts WHERE tenant_id = $1', [sandbox.tenantId]);
  const sales = await query('DELETE FROM sale_transactions WHERE tenant_id = $1', [sandbox.tenantId]);

  return { salesDeleted: sales.rowCount, alertsDeleted: alerts.rowCount };
}

/**
 * Inserts synthetic sale rows for the sandbox tenant in chunks of 500.
 * @param {{tenantId: string, storeId: string, ingestionJobId: string}} sandbox Sandbox handles.
 * @param {Array<{productId: string, saleDate: string, units: number, unitPrice: number,
 *   costPrice: number}>} rows Rows to insert (units must be >= 1).
 * @param {number} [chunkSize] Rows per INSERT statement (max 500).
 * @returns {Promise<{inserted: number, chunks: number}>} Insert summary.
 * @throws {Error} If the tenant is not the sandbox, a unit count is < 1, or the chunk is too big.
 */
export async function insertSales(sandbox, rows, chunkSize = SANDBOX_CHUNK_SIZE) {
  await assertSandboxTenant(sandbox.tenantId);
  if (chunkSize > SANDBOX_CHUNK_SIZE) {
    throw new Error(`insertSales: chunkSize ${chunkSize} exceeds the 500-row limit`);
  }

  let inserted = 0;
  let chunks = 0;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];

    chunk.forEach((row, idx) => {
      if (!Number.isInteger(row.units) || row.units < 1) {
        throw new Error(`insertSales: units must be an integer >= 1 (got ${row.units})`);
      }
      const b = idx * 8;
      values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`);
      params.push(
        sandbox.tenantId,
        sandbox.storeId,
        row.productId,
        sandbox.ingestionJobId,
        row.units,
        row.unitPrice,
        row.costPrice,
        row.saleDate,
      );
    });

    const { rowCount } = await query(
      `INSERT INTO sale_transactions
         (tenant_id, store_id, product_id, ingestion_job_id,
          quantity_sold, unit_price_at_sale, cost_price_at_sale, sale_date)
       VALUES ${values.join(', ')}`,
      params,
    );

    inserted += rowCount;
    chunks++;
  }

  return { inserted, chunks };
}

/**
 * Reads the sales_spike / sales_drop alerts the engine produced for the sandbox.
 * @param {{tenantId: string, storeId: string}} sandbox Sandbox handles.
 * @returns {Promise<Array<{sku: string, alert_type: string, severity: string,
 *   z_score: number, alert_date: string}>>} Alerts ordered by date then SKU.
 */
export async function readSandboxAlerts(sandbox) {
  const { rows } = await query(
    `SELECT p.sku,
            aa.alert_type,
            aa.severity,
            aa.z_score::float8 AS z_score,
            aa.alert_date::text AS alert_date
       FROM anomaly_alerts aa
       JOIN products p ON p.id = aa.product_id
      WHERE aa.tenant_id = $1
        AND aa.store_id  = $2
        AND aa.alert_type IN ('sales_spike', 'sales_drop')
      ORDER BY aa.alert_date ASC, p.sku ASC`,
    [sandbox.tenantId, sandbox.storeId],
  );
  return rows;
}

/**
 * Counts sale rows belonging to every tenant EXCEPT the sandbox — the isolation
 * check the harness prints before and after a run.
 * @returns {Promise<number>} Row count for foreign tenants.
 */
export async function countForeignSaleRows() {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM sale_transactions st
       JOIN tenants t ON t.id = st.tenant_id
      WHERE t.slug <> $1`,
    [SANDBOX_TENANT_SLUG],
  );
  return rows[0].n;
}

/**
 * Reads the database server's CURRENT_DATE — the clock the engine uses when it
 * filters the last ROLLING_WINDOW_DAYS days of data.
 * @returns {Promise<string>} ISO date (YYYY-MM-DD) of the server's today.
 */
export async function currentDbDate() {
  const { rows } = await query('SELECT CURRENT_DATE::text AS today');
  return rows[0].today;
}

/** Closes the shared pool so the script can exit cleanly. */
export async function closeSandboxPool() {
  await pool.end();
}
