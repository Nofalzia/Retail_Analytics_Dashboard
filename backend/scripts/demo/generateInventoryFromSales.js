/**
 * backend/scripts/demo/generateInventoryFromSales.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T12e — derive a demo stock-count snapshot from a tenant's OWN sales history.
 *
 * Why this exists: "Days of Inventory Left" and Stockout Watch need a recorded
 * shelf count (inventory_logs). A tenant seeded only from a sales export has none,
 * so those views correctly say "nothing has been counted yet". Writing demo counts
 * by hand is slow and arbitrary; deriving them from the sales that were actually
 * imported keeps the numbers internally consistent.
 *
 * What the script does, in order:
 *   1. resolve the tenant by slug and one of its stores (--store, else the oldest);
 *   2. anchor the window to the store's as-of date (src/utils/asOfDate.js) — the
 *      same anchor every analysis uses, so a history that ends months ago works;
 *   3. compute each active product's average daily units over the last
 *      VELOCITY_DAYS days of that window — exactly the velocity Stockout Watch
 *      computes, so the snapshot and the dashboard agree;
 *   4. draw a "days of cover" value per product from a SEEDED generator (0..25) and
 *      write quantity_on_hand = round(velocity × days-of-cover), which is the
 *      inverse of the dashboard's days_remaining = quantity_on_hand / velocity;
 *   5. write one CSV with a '#' provenance header, then print the counts and how
 *      the import will be read.
 *
 * THE COUNTS ARE SYNTHETIC. Days-of-cover is drawn uniformly from [0, 25] rather
 * than measured, precisely so the demo produces a mix of stockout / critical /
 * warning / healthy products instead of one flat tier. A product with no sales in
 * the window reports 'no_data' whatever it holds, so it gets a plausible shelf
 * quantity instead of a meaningless zero.
 *
 * A stock count never creates products: every SKU written here already exists for
 * the tenant, which is exactly what the upload route requires
 * (src/utils/validators.js → validateInventoryRow plus the SKU-resolution pass).
 *
 * Run from backend/ (relative paths resolve against the repository root):
 *   npm run demo:inventory -- --slug london-bakers-i10
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pool, { query } from '../../src/db/pool.js';
import { getStoreAsOfDate } from '../../src/utils/asOfDate.js';
import { createPrng } from '../validation/prng.js';

// ── Configuration ────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/scripts/demo → repository root, so --out behaves the same whether the
// script is run from backend/ or from the repository root.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const DEFAULT_SLUG    = 'london-bakers-i10';
const OUTPUT_BASE     = 'data/processed';
const OUTPUT_FILENAME = 'inventory_snapshot.csv';
const DEFAULT_SEED    = 20261115;

// The canonical stock-count header (src/utils/validators.js → INVENTORY_COLUMNS).
const OUTPUT_HEADER = ['sku', 'quantity_on_hand', 'count_date', 'product_name'];

// Must match the Stockout Watch default window, so days_remaining in the dashboard
// is the days-of-cover this script drew. The route takes velocityDays from the
// query string; 14 is its default.
const VELOCITY_DAYS = 14;

// Days of cover per product. 0 means the product was counted out of stock today;
// the dashboard's tier boundaries are 7 and 14 days, so this range is wide enough
// to produce all four tiers in one file.
const MIN_DAYS_COVER = 0;
const MAX_DAYS_COVER = 25;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prints the command-line usage block. */
function usage() {
  console.log(`
Usage: npm run demo:inventory -- [options]

  --slug <slug>   tenant to derive the snapshot from  (default: ${DEFAULT_SLUG})
  --store <ref>   store name or id                    (default: the oldest store)
  --seed <int>    PRNG seed — same seed, same counts   (default: ${DEFAULT_SEED})
  --out <path>    output directory (default: ${OUTPUT_BASE}/<slug>)
  --help          print this message

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
 * Quotes one CSV cell. Product names may contain commas or quotes, and the upload
 * parser reads real CSV, so they have to be escaped here.
 * @param {string|number|null|undefined} value Cell value.
 * @returns {string} A cell that survives csv-parser unchanged.
 */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Finds the store a snapshot should be written for.
 * @param {string} tenantId Tenant UUID.
 * @param {string|null} storeRef Store name or id supplied on the command line.
 * @returns {Promise<{ id: string, name: string }>} The resolved store.
 * @throws {Error} When the tenant has no store, or storeRef matches none.
 */
async function resolveStore(tenantId, storeRef) {
  if (storeRef) {
    const { rows } = await query(
      `SELECT id, name
         FROM stores
        WHERE tenant_id = $1
          AND (id::text = $2 OR lower(name) = lower($2))
        ORDER BY created_at
        LIMIT 1`,
      [tenantId, storeRef],
    );
    if (rows.length === 0) throw new Error(`Store "${storeRef}" not found for this tenant.`);
    return rows[0];
  }

  const { rows } = await query(
    `SELECT id, name
       FROM stores
      WHERE tenant_id = $1
      ORDER BY created_at, name
      LIMIT 1`,
    [tenantId],
  );
  if (rows.length === 0) throw new Error('This tenant has no store yet — run the seed script first.');
  return rows[0];
}

/**
 * Classifies a product the way the Stockout Watch SQL does, so the printed report
 * matches what the dashboard shows after the import.
 * @param {number} velocity Average daily units (0 when the window has no sales).
 * @param {number} quantityOnHand Units counted on the shelf.
 * @returns {'stockout'|'critical'|'warning'|'healthy'|'no_data'} Urgency tier.
 */
function classifyTier(velocity, quantityOnHand) {
  if (velocity <= 0) return 'no_data';
  if (quantityOnHand === 0) return 'stockout';
  const daysRemaining = quantityOnHand / velocity;
  if (daysRemaining < 7) return 'critical';
  if (daysRemaining < 14) return 'warning';
  return 'healthy';
}


/**
 * Runs the snapshot generation.
 * @returns {Promise<number>} Process exit code (0 = success).
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const slug = typeof args.slug === 'string' ? args.slug : DEFAULT_SLUG;
  if (args.seed !== undefined && typeof args.seed !== 'string') {
    console.error('✗ --seed needs a value, e.g. --seed 20261115');
    return 2;
  }
  const seed = args.seed === undefined ? DEFAULT_SEED : Number.parseInt(args.seed, 10);
  if (!Number.isSafeInteger(seed)) {
    console.error(`✗ --seed "${args.seed}" is not an integer.`);
    return 2;
  }

  // 1. Tenant. The slug is the only identity this script accepts, exactly like the
  //    seed scripts, and every query below is scoped by the id it resolves to.
  const { rows: tenantRows } = await query(
    'SELECT id, name, slug FROM tenants WHERE slug = $1',
    [slug],
  );
  if (tenantRows.length === 0) {
    console.error(`✗ Tenant "${slug}" not found. Seed it first (npm run bakery:seed).`);
    return 1;
  }
  const tenant = tenantRows[0];

  // 2. Store + the as-of date every analysis is anchored to.
  const store = await resolveStore(tenant.id, typeof args.store === 'string' ? args.store : null);
  const asOfDate = await getStoreAsOfDate(query, tenant.id, store.id);
  const windowParams = [tenant.id, store.id, asOfDate, VELOCITY_DAYS];

  // 3a. An empty window would give every product velocity 0 and a useless snapshot,
  //     so fail loudly instead of writing a page of 'no_data' rows.
  const { rows: windowRows } = await query(
    `SELECT COALESCE(SUM(st.quantity_sold), 0)::bigint AS units
       FROM sale_transactions st
      WHERE st.tenant_id = $1
        AND st.store_id  = $2
        AND st.sale_date >= $3::date - MAKE_INTERVAL(days => $4::int)
        AND st.sale_date <= $3::date`,
    windowParams,
  );
  if (Number(windowRows[0].units) === 0) {
    console.error(
      `✗ No sales for "${tenant.slug}" in the ${VELOCITY_DAYS} days ending ${asOfDate}.\n`
      + '  Import or seed sales history first — a count derived from nothing is meaningless.',
    );
    return 1;
  }

  // 3b. Velocity per active product over the window the dashboard uses. LEFT JOIN
  //     from products so a product that simply did not sell still appears in the
  //     count (its tier will be 'no_data', not 'stockout').
  const { rows: productRows } = await query(
    `SELECT p.sku,
            p.name,
            COALESCE(SUM(st.quantity_sold), 0)::bigint AS units_sold
       FROM products p
       LEFT JOIN sale_transactions st
              ON st.product_id = p.id
             AND st.tenant_id  = p.tenant_id
             AND st.store_id   = $2
             AND st.sale_date >= $3::date - MAKE_INTERVAL(days => $4::int)
             AND st.sale_date <= $3::date
      WHERE p.tenant_id = $1
        AND p.is_active = TRUE
      GROUP BY p.id, p.sku, p.name
      ORDER BY p.sku`,
    windowParams,
  );
  if (productRows.length === 0) {
    console.error(`✗ Tenant "${tenant.slug}" has no active products.`);
    return 1;
  }

  // 4. Draw the counts from one seeded stream, so the same seed writes the same file.
  const prng = createPrng(seed);
  const tiers = { stockout: 0, critical: 0, warning: 0, healthy: 0, no_data: 0 };
  const lines = [];
  for (const product of productRows) {
    const unitsSold = Number(product.units_sold) || 0;
    const velocity = unitsSold / VELOCITY_DAYS;

    let quantityOnHand;
    if (velocity > 0) {
      const daysCover = prng.randInt(MIN_DAYS_COVER, MAX_DAYS_COVER);
      quantityOnHand = Math.max(0, Math.round(velocity * daysCover));
    } else {
      // No sales in the window: the dashboard reports 'no_data' whatever the shelf
      // holds, so a plausible shelf quantity says more than a misleading zero.
      quantityOnHand = prng.randInt(0, 40);
    }

    tiers[classifyTier(velocity, quantityOnHand)] += 1;
    lines.push([product.sku, quantityOnHand, asOfDate, product.name].map(csvCell).join(','));
  }

  // 5. Write the file. The '#' lines are provenance; the upload parser runs with
  //    skipComments: '#' for exactly this reason.
  const outDir = path.resolve(
    REPO_ROOT,
    typeof args.out === 'string' ? args.out : path.join(OUTPUT_BASE, slug),
  );
  await mkdir(outDir, { recursive: true });
  const filePath = path.join(outDir, OUTPUT_FILENAME);

  const commentLines = [
    '# Inventory snapshot generated by backend/scripts/demo/generateInventoryFromSales.js',
    `# tenant=${tenant.slug} store=${store.name.replace(/\s+/g, ' ')} as-of=${asOfDate} `
      + `velocity-window=${VELOCITY_DAYS}d seed=${seed}`,
    '# quantity_on_hand = round(avg daily units over the window x days-of-cover), '
      + `days-of-cover drawn from [${MIN_DAYS_COVER}, ${MAX_DAYS_COVER}]`,
    '# These counts are SYNTHETIC demo values and every SKU below already exists for this tenant.',
  ];

  await writeFile(
    filePath,
    `${[...commentLines, OUTPUT_HEADER.join(','), ...lines].join('\n')}\n`,
    'utf8',
  );

  // 6. Report — the tier counts use the same thresholds as the Stockout Watch SQL.
  const relativePath = path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
  console.log(`
Stock-count snapshot written
  tenant     ${tenant.name} (${tenant.slug})
  store      ${store.name}
  as-of      ${asOfDate}   (velocity window: ${VELOCITY_DAYS} days back from the as-of date)
  seed       ${seed}
  products   ${lines.length}
  tiers      ${Object.entries(tiers).map(([tier, count]) => `${tier} ${count}`).join(' | ')}
  file       ${relativePath}

Upload it in Data Ingestion — it is detected as a stock count, not a sales file —
then open Stockout Watch to see days of inventory left.`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
