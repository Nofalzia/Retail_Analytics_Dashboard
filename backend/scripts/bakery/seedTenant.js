/**
 * backend/scripts/bakery/seedTenant.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T10a — reset and seed the SECOND demonstration tenant from the files written by
 * scripts/bakery/prepareData.js (npm run bakery:prepare).
 *
 * Idempotent, and a true reset for THIS tenant only:
 *   1. find or create the tenant by slug, then re-read its slug and ABORT unless it
 *      is exactly the expected one — this happens BEFORE any DELETE;
 *   2. inside one transaction, delete ONLY that tenant's recommendations,
 *      anomaly_alerts, sale_transactions, inventory_logs and ingestion_jobs;
 *   3. upsert three users, one store, the categories and the products from
 *      products.json, then load the history CSV through one ingestion_jobs row;
 *   4. print the tenant id, users, product count, sale rows, date range and the
 *      credentials, and assert that every count for the other demonstration tenant
 *      is unchanged — exit 1 otherwise.
 *
 * The tenant, store, user and product NAMES are data: they come from the prepared
 * files or from this script's configuration block, never from the schema.
 *
 * NO INVENTORY ROWS ARE WRITTEN. The source export holds no stock counts, so this
 * script does not invent any; the tenant simply has no inventory history.
 *
 * Run from backend/ (relative --dir resolves against the repository root):
 *   npm run bakery:seed -- --dir data/processed/london-bakers
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import csvParser from 'csv-parser';
import pool, { getClient, query } from '../../src/db/pool.js';

// ── Configuration ────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/scripts/bakery → repository root, so --dir behaves the same whether the
// script is run from backend/ or from the repository root.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const DEFAULT_DIR       = 'data/processed/london-bakers';
const HISTORY_FILENAME  = 'london_bakers_history.csv';
const LIVE_FILENAME     = 'london_bakers_live_day.csv';
const PRODUCTS_FILENAME = 'products.json';
const HISTORY_HEADER    = ['date', 'sku', 'product_name', 'quantity_sold', 'unit_price', 'unit_cost'];

// Tenant identity — slug/name/currency/locale are configuration DATA, not schema.
const TENANT_SLUG     = 'london-bakers-i10';
const TENANT_NAME     = 'London Bakers I-10';
const TENANT_CURRENCY = 'PKR';
const TENANT_LOCALE   = 'en-PK';
const STORE_NAME      = 'I-10 Branch';

const OWNER_EMAIL   = 'owner@londonbakers.demo';
const MANAGER_EMAIL = 'manager@londonbakers.demo';
const CASHIER_EMAIL = 'cashier@londonbakers.demo';
const PASSWORD      = 'Demo@1234';
const BCRYPT_ROUNDS = 10;

const REORDER_THRESHOLD = 10;
const CHUNK_SIZE        = 1000; // rows per parameterised multi-row INSERT (8 params each)

// Deleted on every run, in this order: recommendations → anomaly_alerts →
// sale_transactions → inventory_logs → ingestion_jobs. Sale and inventory rows both
// reference ingestion_jobs, so the jobs must go last.
const RESET_TABLES = [
  'recommendations',
  'anomaly_alerts',
  'sale_transactions',
  'inventory_logs',
  'ingestion_jobs',
];

// The other demonstration tenant whose counts must not move.
const DEMO_TENANT_SLUG = 'demo-kiryana';

// Every table holding tenant-scoped rows that the report compares.
const TENANT_TABLES = [
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prints the command-line usage block. */
function usage() {
  console.log(`
Usage: npm run bakery:seed -- [options]

  --dir <path>   directory written by bakery:prepare  (default: ${DEFAULT_DIR})
  --help         print this message

Relative paths resolve against the repository root.`);
}

/**
 * Minimal `--flag value` / `--flag=value` argument parser.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Object<string, string|boolean>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Resolves an absolute or repository-relative path.
 * @param {string} value Path from the command line.
 * @returns {string} Absolute path.
 */
function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

/** @param {string} value Candidate date. @returns {boolean} True for a real YYYY-MM-DD date. */
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** @param {number} value Number to round. @returns {number} Value rounded to 2 dp. */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** @param {number} value Integer to format. @returns {string} Thousands-separated string. */
function formatInt(value) {
  return Number(value).toLocaleString('en-US');
}

/**
 * Reads and parses a JSON file.
 * @param {string} filePath File to read.
 * @returns {Promise<* >} Parsed contents.
 */
async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

/**
 * Streams the prepared history CSV and validates every row against the contract the
 * upload pipeline enforces (positive integer quantity, non-negative money, ISO date).
 * @param {string} filePath History CSV.
 * @param {Set<string>} knownSkus SKUs present in products.json.
 * @returns {Promise<Array<{saleDate: string, sku: string, quantity: number,
 *   unitPrice: number, unitCost: number}>>} Validated rows.
 * @throws {Error} If the header or any row is invalid.
 */
function readHistoryRows(filePath, knownSkus) {
  return new Promise((resolve, reject) => {
    const rows = [];
    let headers = null;
    let headerChecked = false;

    const fail = (message) => {
      stream.destroy();
      reject(new Error(message));
    };

    const stream = createReadStream(filePath).pipe(csvParser());

    stream.on('headers', (found) => {
      headers = found;
      headerChecked = true;
      const missing = HISTORY_HEADER.filter((column) => !found.includes(column));
      if (missing.length > 0) {
        fail(`${path.basename(filePath)}: missing column(s) ${missing.join(', ')} (found: ${found.join(', ')})`);
      }
    });

    stream.on('data', (row) => {
      if (!headerChecked || headers === null) return;

      try {
        const label = path.basename(filePath);
        const line  = rows.length + 2; // +1 header, +1 one-based
        const assert = (condition, message) => {
          if (!condition) throw new Error(message);
        };

        const saleDate = String(row.date ?? '').trim();
        assert(isIsoDate(saleDate), `${label} row ${line}: invalid date "${saleDate}"`);

        const sku = String(row.sku ?? '').trim();
        assert(knownSkus.has(sku), `${label} row ${line}: SKU "${sku}" is not in ${PRODUCTS_FILENAME}`);

        const quantity = Number(String(row.quantity_sold ?? '').trim());
        assert(
          Number.isInteger(quantity) && quantity >= 1,
          `${label} row ${line}: quantity_sold "${row.quantity_sold}" must be a positive integer`,
        );

        const unitPrice = Number(String(row.unit_price ?? '').trim());
        const unitCost  = Number(String(row.unit_cost ?? '').trim());
        assert(
          Number.isFinite(unitPrice) && unitPrice >= 0,
          `${label} row ${line}: invalid unit_price "${row.unit_price}"`,
        );
        assert(
          Number.isFinite(unitCost) && unitCost >= 0,
          `${label} row ${line}: invalid unit_cost "${row.unit_cost}"`,
        );

        rows.push({ saleDate, sku, quantity, unitPrice, unitCost });
      } catch (err) {
        fail(err.message);
      }
    });

    stream.on('end', () => resolve(rows));
    stream.on('error', reject);
  });
}

// ── Database helpers ─────────────────────────────────────────────────────────

/**
 * Counts one tenant's rows in every business table, in a single round-trip.
 * @param {(text: string, params?: Array<*>) => Promise<{rows: Array<Object>}>} exec
 *   Query runner — a pool query function or a checked-out client's query.
 * @param {string} slug Tenant slug to count.
 * @returns {Promise<Object<string, number>|null>} Table → row count, or null when
 *   no tenant has that slug.
 */
async function countTenantRows(exec, slug) {
  const selects = TENANT_TABLES
    .map((table) => `(SELECT count(*) FROM ${table} WHERE tenant_id = t.id)::int AS ${table}`)
    .join(',\n              ');
  const { rows } = await exec(
    `SELECT ${selects}
       FROM tenants t
      WHERE t.slug = $1`,
    [slug],
  );
  return rows[0] ?? null;
}

/**
 * Names the tables whose row counts differ between two snapshots.
 * @param {Object<string, number>|null} before Snapshot taken before seeding.
 * @param {Object<string, number>|null} after Snapshot taken after seeding.
 * @returns {string[]} Differing table names (empty when unchanged).
 */
function changedTables(before, after) {
  return TENANT_TABLES.filter((table) => (before?.[table] ?? 0) !== (after?.[table] ?? 0));
}

/**
 * Formats a snapshot as one line: "table=count, table=count, ...".
 * @param {Object<string, number>|null} counts Snapshot.
 * @returns {string} Human-readable snapshot.
 */
function formatCounts(counts) {
  if (!counts) return '(tenant not present)';
  return TENANT_TABLES.map((table) => `${table}=${formatInt(counts[table] ?? 0)}`).join(', ');
}

/**
 * Inserts the prepared history rows as parameterised multi-row INSERTs, at most
 * CHUNK_SIZE rows per statement, mirroring the columns src/seed.js writes.
 * @param {import('pg').Client} client Checked-out client inside the transaction.
 * @param {{tenantId: string, storeId: string, jobId: string, productIds: Map<string, string>}} handle
 *   Tenant/store/job handles and the SKU → product id map.
 * @param {Array<{saleDate: string, sku: string, quantity: number, unitPrice: number, unitCost: number}>} rows
 *   Validated history rows.
 * @returns {Promise<number>} Number of rows inserted.
 */
async function insertSaleRows(client, handle, rows) {
  let inserted = 0;

  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk  = rows.slice(i, i + CHUNK_SIZE);
    const values = chunk.map((_, idx) => {
      const b = idx * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    }).join(', ');

    const params = chunk.flatMap((row) => [
      handle.tenantId,
      handle.storeId,
      handle.productIds.get(row.sku),
      handle.jobId,
      row.quantity,
      row.unitPrice,
      row.unitCost,
      row.saleDate,
    ]);

    const { rowCount } = await client.query(
      `INSERT INTO sale_transactions
         (tenant_id, store_id, product_id, ingestion_job_id,
          quantity_sold, unit_price_at_sale, cost_price_at_sale, sale_date)
       VALUES ${values}`,
      params,
    );

    inserted += rowCount;
  }

  return inserted;
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Resets and seeds the London Bakers I-10 tenant. @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const dir          = resolvePath(typeof args.dir === 'string' ? args.dir : DEFAULT_DIR);
  const productsPath = path.join(dir, PRODUCTS_FILENAME);
  const historyPath  = path.join(dir, HISTORY_FILENAME);
  const livePath     = path.join(dir, LIVE_FILENAME);

  console.log('── London Bakers I-10 · tenant seed ───────────────────────');
  console.log(`  source : ${dir}`);

  // ── 0. Load the files written by prepareData.js ────────────────────────────
  const products = await readJsonFile(productsPath);
  if (!Array.isArray(products) || products.length === 0) {
    throw new Error(`${PRODUCTS_FILENAME}: expected a non-empty JSON array`);
  }
  for (const product of products) {
    if (!product?.sku || !product?.name || !Number.isFinite(product.referencePrice)) {
      throw new Error(`${PRODUCTS_FILENAME}: every entry needs sku, name and a numeric referencePrice`);
    }
  }
  const skus = new Set(products.map((p) => p.sku));

  const history  = await readHistoryRows(historyPath, skus);
  const liveRows = await readHistoryRows(livePath, skus);
  if (history.length === 0) throw new Error(`${HISTORY_FILENAME}: no data rows — run npm run bakery:prepare first`);

  const soldDates = history.map((r) => r.saleDate).sort();
  const firstDate = soldDates[0];
  const lastDate  = soldDates[soldDates.length - 1];

  // Sale-weighted cost ratio implied by the prepared files. prepareData.js derives
  // unit_cost as unit_price × one ratio, so dividing the totals back out recovers
  // it (up to the 2 dp rounding the CSV carries) — the catalogue then prices the
  // standard cost consistently with the historical rows.
  let historyRevenue = 0;
  let historyCost    = 0;
  for (const row of history) {
    historyRevenue += row.quantity * row.unitPrice;
    historyCost    += row.quantity * row.unitCost;
  }
  const costRatio = historyRevenue > 0 ? historyCost / historyRevenue : 0;

  console.log(`  history: ${formatInt(history.length)} rows, ${formatInt(skus.size)} SKUs, ${firstDate} → ${lastDate}`);
  console.log(`  live   : ${formatInt(liveRows.length)} rows (excluded from the seed)`);
  console.log(`  cost ratio recovered from the file: ${costRatio.toFixed(4)}`);

  // Snapshot the other demo tenant BEFORE touching anything, so the isolation check
  // compares a clean "before" against the state after the seed.
  const demoBefore = await countTenantRows(query, DEMO_TENANT_SLUG);

  const client = await getClient();
  let summary;

  try {
    await client.query('BEGIN');

    // ── 1. Tenant, then guard. No DELETE may run before this check passes ─────
    const { rows: [tenant] } = await client.query(
      `INSERT INTO tenants (name, slug, currency_code, locale)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE
       RETURNING id, slug, name`,
      [TENANT_NAME, TENANT_SLUG, TENANT_CURRENCY, TENANT_LOCALE],
    );

    if (tenant.slug !== TENANT_SLUG) {
      throw new Error(`refusing to seed: slug "${tenant.slug}" does not match "${TENANT_SLUG}"`);
    }
    const tenantId = tenant.id;
    console.log(`\n  tenant : ${tenant.name} (${tenant.slug}) — ${tenantId}`);

    // ── 2. Reset ONLY this tenant's transactional data ───────────────────────
    // Order matters: recommendations → anomaly_alerts → sale_transactions →
    // inventory_logs → ingestion_jobs. Users, stores, categories and products are
    // deliberately kept and upserted below, mirroring src/seed.js.
    for (const table of RESET_TABLES) {
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
      console.log(`  reset  ${table.padEnd(18)} ${formatInt(rowCount)} row(s) deleted`);
    }

    // ── 3. Store (users reference it) ─────────────────────────────────────────
    // No UNIQUE (tenant_id, name) on stores, so this is select-then-insert.
    // location stays NULL: the export carries no address and none is invented.
    const { rows: storeRows } = await client.query(
      'SELECT id FROM stores WHERE tenant_id = $1 AND name = $2 ORDER BY created_at LIMIT 1',
      [tenantId, STORE_NAME],
    );
    let storeId;
    if (storeRows.length > 0) {
      storeId = storeRows[0].id;
    } else {
      const { rows: [created] } = await client.query(
        'INSERT INTO stores (tenant_id, name, location) VALUES ($1, $2, NULL) RETURNING id',
        [tenantId, STORE_NAME],
      );
      storeId = created.id;
    }

    // ── 4. Users ─────────────────────────────────────────────────────────────
    // Same store, same password hashing, same upsert shape for all three: the
    // clerk can only upload (the dashboard READ routes reject the role).
    const passwordHash = await bcrypt.hash(PASSWORD, BCRYPT_ROUNDS);
    const userIds = new Map();
    for (const [email, role] of [
      [OWNER_EMAIL, 'owner'],
      [MANAGER_EMAIL, 'manager'],
      [CASHIER_EMAIL, 'data_entry_clerk'],
    ]) {
      const { rows: [user] } = await client.query(
        `INSERT INTO users (tenant_id, email, password_hash, role, store_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, email)
           DO UPDATE SET password_hash = EXCLUDED.password_hash,
                         role          = EXCLUDED.role,
                         store_id      = EXCLUDED.store_id,
                         is_active     = TRUE
         RETURNING id`,
        [tenantId, email, passwordHash, role, storeId],
      );
      userIds.set(email, user.id);
    }

    // ── 5. Categories taken from products.json ────────────────────────────────
    const categoryNames = [...new Set(products.map((p) => p.category).filter(Boolean))].sort();
    const categoryIds = new Map();
    for (const name of categoryNames) {
      const { rows: [category] } = await client.query(
        `INSERT INTO categories (tenant_id, name)
         VALUES ($1, $2)
         ON CONFLICT (tenant_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenantId, name],
      );
      categoryIds.set(name, category.id);
    }

    // ── 6. Products (standard price = referencePrice, standard cost = price × ratio) ──
    const productIds = new Map();
    for (const product of products) {
      const referenceCost = round2(product.referencePrice * costRatio);
      const { rows: [row] } = await client.query(
        `INSERT INTO products
           (tenant_id, category_id, name, sku,
            standard_unit_cost, standard_unit_price, reorder_threshold)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, sku)
           DO UPDATE SET
             category_id         = EXCLUDED.category_id,
             name                = EXCLUDED.name,
             standard_unit_cost  = EXCLUDED.standard_unit_cost,
             standard_unit_price = EXCLUDED.standard_unit_price,
             reorder_threshold   = EXCLUDED.reorder_threshold,
             is_active           = TRUE
         RETURNING id`,
        [
          tenantId,
          categoryIds.get(product.category) ?? null,
          product.name,
          product.sku,
          referenceCost,
          product.referencePrice,
          REORDER_THRESHOLD,
        ],
      );
      productIds.set(product.sku, row.id);
    }

    // ── 7. One ingestion job for the history file ─────────────────────────────
    // file_hash stays NULL (like the src/seed.js job) so this row is exempt from the
    // upload pipeline's per-store dedup index and the file can still be uploaded
    // manually later.
    const { rows: [job] } = await client.query(
      `INSERT INTO ingestion_jobs
         (tenant_id, store_id, uploaded_by, original_filename, file_type, status,
          total_rows, rows_processed, completed_at)
       VALUES ($1, $2, $3, $4, 'csv', 'completed', $5, $5, NOW())
       RETURNING id`,
      [tenantId, storeId, userIds.get(OWNER_EMAIL), HISTORY_FILENAME, history.length],
    );

    // ── 8. History rows ───────────────────────────────────────────────────────
    const inserted = await insertSaleRows(
      client,
      { tenantId, storeId, jobId: job.id, productIds },
      history,
    );

    await client.query('COMMIT');

    summary = {
      tenantId,
      storeId,
      inserted,
      categories: categoryNames.length,
      products: products.length,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // ── 9. Report what is actually in the database now ────────────────────────
  const { rows: [stats] } = await query(
    `SELECT count(*)::int                   AS rows,
            count(DISTINCT product_id)::int AS products,
            count(DISTINCT sale_date)::int  AS days,
            min(sale_date)::text            AS first_date,
            max(sale_date)::text            AS last_date,
            coalesce(sum(total_revenue), 0)::numeric(15, 2) AS revenue
       FROM sale_transactions
      WHERE tenant_id = $1`,
    [summary.tenantId],
  );
  const { rows: [userCount] } = await query(
    'SELECT count(*)::int AS users FROM users WHERE tenant_id = $1',
    [summary.tenantId],
  );

  console.log('\n── Tenant verification ───────────────────────────────────');
  console.log(`  tenant id  : ${summary.tenantId}`);
  console.log(`  slug       : ${TENANT_SLUG}`);
  console.log(`  store      : ${STORE_NAME}`);
  console.log(`  users      : ${formatInt(userCount.users)}`);
  console.log(`  categories : ${formatInt(summary.categories)}`);
  console.log(`  products   : ${formatInt(summary.products)} in the catalogue, ${formatInt(stats.products)} sold`);
  console.log(`  sale rows  : ${formatInt(stats.rows)} inserted (${formatInt(summary.inserted)} this run)`);
  console.log(`  date range : ${stats.first_date} → ${stats.last_date} (${formatInt(stats.days)} days)`);
  console.log(`  revenue    : ${stats.revenue} (Σ total_revenue, generated column)`);
  console.log(`  inventory  : none — the source export has no stock counts, so none are invented`);
  console.log('\n  Credentials:');
  console.log(`    ${OWNER_EMAIL.padEnd(30)} / ${PASSWORD}   (owner)`);
  console.log(`    ${MANAGER_EMAIL.padEnd(30)} / ${PASSWORD}   (manager)`);
  console.log(`    ${CASHIER_EMAIL.padEnd(30)} / ${PASSWORD}   (data_entry_clerk)`);

  // ── 10. Isolation check — the other demo tenant must be byte-for-byte unchanged ──
  const demoAfter = await countTenantRows(query, DEMO_TENANT_SLUG);
  const differ    = changedTables(demoBefore, demoAfter);

  console.log(`\n── Isolation check (${DEMO_TENANT_SLUG} must be untouched) ──`);
  console.log(`  before : ${formatCounts(demoBefore)}`);
  console.log(`  after  : ${formatCounts(demoAfter)}`);

  if (demoBefore === null) {
    console.log('  ⚠️  that tenant is not in this database, so there is nothing to compare');
  } else if (differ.length === 0) {
    console.log('  ✅ UNCHANGED — every count is identical');
  } else {
    console.log(`  ❌ CHANGED in: ${differ.join(', ')}`);
    process.exitCode = 1;
  }

  console.log(`\n✅ Seed complete. To demo the upload pipeline, log in as the owner and`);
  console.log(`   upload ${LIVE_FILENAME} (${formatInt(liveRows.length)} rows) through the normal UI flow.`);
}

main()
  .catch((err) => {
    console.error('\n❌ Seed failed:', err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  })
  .finally(() => pool.end());
