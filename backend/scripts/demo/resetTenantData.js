/**
 * backend/scripts/demo/resetTenantData.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T12g — empty ONE demo tenant's imported data, and nothing else.
 *
 * The onboarding demo ends with a store full of uploaded rows. This script puts
 * it back to blank so the next walkthrough starts from "drag a file in" again.
 *
 * Safety, in order:
 *   1. --slug is REQUIRED and checked against a hard allow-list (ALLOWED_SLUGS).
 *      Any other slug is refused before a single query runs;
 *   2. the database HOST is printed (never the password) so it is obvious which
 *      server is about to be changed;
 *   3. the tenant is resolved by slug and its slug RE-READ by id — a mismatch
 *      aborts before any DELETE (the same guard bakery:seed uses);
 *   4. the row counts of EVERY tenant are snapshotted, then only the listed
 *      tables are deleted for that one tenant, inside one transaction;
 *   5. the snapshots are compared before the COMMIT: if any OTHER tenant's
 *      counts moved, the transaction is rolled back and the script exits 1.
 *
 * Tables deleted (and only these): recommendations, anomaly_alerts,
 * sale_transactions, inventory_logs, ingestion_jobs, products, categories.
 * Tenant, stores and users are deliberately kept, so the logins still work.
 *
 * Run from backend/:
 *   npm run demo:reset -- --slug demo-onboarding
 * ──────────────────────────────────────────────────────────────────────────────
 */

import 'dotenv/config';
import pool, { getClient } from '../../src/db/pool.js';

// ── Configuration ────────────────────────────────────────────────────────────

// Hard allow-list. This script must never be usable to wipe a tenant that holds
// data anyone cares about — add a slug here only if it is disposable by design.
const ALLOWED_SLUGS = Object.freeze(['demo-onboarding']);

// Delete order respects the foreign keys: sale_transactions and inventory_logs
// RESTRICT on products, both reference ingestion_jobs, and anomaly_alerts /
// recommendations point at products and alerts.
const DELETE_ORDER = [
  'recommendations',
  'anomaly_alerts',
  'sale_transactions',
  'inventory_logs',
  'ingestion_jobs',
  'products',
  'categories',
];

// Every table holding tenant-scoped rows. The before/after isolation check covers
// users and stores too, so a stray delete outside the list above is caught.
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

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prints the command-line usage block. */
function usage() {
  console.log(`
Usage: npm run demo:reset -- --slug <slug>

  --slug <slug>   tenant whose imported data should be deleted (required)
  --help          print this message

Allowed slugs: ${ALLOWED_SLUGS.join(', ')}`);
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

/** @param {number} value Integer to format. @returns {string} Thousands-separated string. */
function formatInt(value) {
  return Number(value).toLocaleString('en-US');
}

/**
 * Describes WHERE the connection points, without ever echoing the password.
 * @param {string|undefined} connectionString DATABASE_URL.
 * @returns {string} e.g. "db.example.com:5432 / mydatabase".
 */
function describeDatabaseTarget(connectionString) {
  if (!connectionString) return '(DATABASE_URL is not set)';
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(default)';
    return `${url.host} / ${database}`;
  } catch {
    // Never echo the raw string: it usually carries user:password.
    return '(DATABASE_URL is set but not a parsable URL — host hidden)';
  }
}

/**
 * Counts every tenant's rows in every business table, in one round-trip.
 * @param {(text: string, params?: Array<*>) => Promise<{rows: Array<Object>}>} exec
 *   Query runner — a checked-out client's query inside the transaction.
 * @returns {Promise<Array<Object>>} One row per tenant: id, slug and the counts.
 */
async function countAllTenants(exec) {
  const selects = REPORT_TABLES
    .map((table) => `(SELECT count(*) FROM ${table} WHERE tenant_id = t.id)::int AS ${table}`)
    .join(',\n              ');
  const { rows } = await exec(`SELECT t.id, t.slug, ${selects} FROM tenants t ORDER BY t.slug`);
  return rows;
}

/**
 * Formats one tenant's snapshot as one line: "table=count, table=count, ...".
 * @param {Object<string, number>|undefined} counts Snapshot row.
 * @returns {string} Human-readable snapshot.
 */
function formatCounts(counts) {
  if (!counts) return '(tenant not found)';
  return REPORT_TABLES.map((table) => `${table}=${formatInt(counts[table] ?? 0)}`).join(', ');
}

/**
 * Reports every table whose count moved for a tenant.
 * @param {Object<string, number>} before Snapshot before the reset.
 * @param {Object<string, number>|undefined} after Snapshot after the reset.
 * @returns {string[]} e.g. ["products 3 → 0"]; empty when unchanged.
 */
function describeChanges(before, after) {
  if (!after) return ['tenant row disappeared'];
  return REPORT_TABLES
    .filter((table) => Number(before[table] ?? 0) !== Number(after[table] ?? 0))
    .map((table) => `${table} ${formatInt(before[table] ?? 0)} → ${formatInt(after[table] ?? 0)}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

/** Empties one allow-listed tenant's imported data. @returns {Promise<number>} Exit code. */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return 0;
  }

  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';
  if (!slug) {
    console.error('✗ --slug is required.');
    usage();
    return 1;
  }
  if (!ALLOWED_SLUGS.includes(slug)) {
    console.error(`✗ refusing to reset "${slug}": the allow-list is ${ALLOWED_SLUGS.join(', ')}.`);
    return 1;
  }

  console.log('── demo tenant data reset ─────────────────────────────────');
  console.log(`  database : ${describeDatabaseTarget(process.env.DATABASE_URL)}`);
  console.log('  password : (never printed)');
  console.log(`  slug     : ${slug}`);
  console.log(`  deleting : ${DELETE_ORDER.join(', ')}`);

  const client = await getClient();
  let tenant;
  let before;
  let after;

  try {
    await client.query('BEGIN');

    // ── 1. Resolve the tenant, then re-read its slug before any DELETE ────────
    const { rows } = await client.query(
      'SELECT id, name, slug FROM tenants WHERE slug = $1',
      [slug],
    );
    tenant = rows[0];
    if (!tenant) {
      await client.query('ROLLBACK');
      console.log(`\n  nothing to reset: no tenant has the slug "${slug}".`);
      return 0;
    }

    const { rows: [guard] } = await client.query(
      'SELECT slug FROM tenants WHERE id = $1',
      [tenant.id],
    );
    if (!guard || guard.slug !== slug) {
      throw new Error(`refusing to reset: tenant ${tenant.id} re-read as "${guard?.slug ?? '(missing)'}"`);
    }

    // ── 2. Snapshot every tenant BEFORE touching anything ─────────────────────
    before = await countAllTenants(client);
    const targetBefore = before.find((row) => row.id === tenant.id);

    console.log(`\n  tenant   : ${tenant.name} (${tenant.slug}) — ${tenant.id}`);
    console.log('\n── Row counts BEFORE ──────────────────────────────────────');
    console.log(`  ${formatCounts(targetBefore)}`);

    // ── 3. Delete ONLY the allow-listed tenant's listed tables ────────────────
    console.log('\n── Deleting ───────────────────────────────────────────────');
    let deletedTotal = 0;
    for (const table of DELETE_ORDER) {
      const { rowCount } = await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenant.id]);
      deletedTotal += rowCount;
      console.log(`  ${table.padEnd(18)} ${formatInt(rowCount)} row(s) deleted`);
    }
    console.log(`  ${'TOTAL'.padEnd(18)} ${formatInt(deletedTotal)} row(s) deleted`);

    // ── 4. Snapshot again and verify every OTHER tenant is untouched ──────────
    after = await countAllTenants(client);
    const targetAfter = after.find((row) => row.id === tenant.id);

    const otherTenantsBefore = before.filter((row) => row.id !== tenant.id);
    const changed = [];
    for (const previous of otherTenantsBefore) {
      const current = after.find((row) => row.id === previous.id);
      const diffs = describeChanges(previous, current);
      if (diffs.length > 0) changed.push(`${previous.slug}: ${diffs.join(', ')}`);
    }

    if (changed.length > 0) {
      // The deletes were scoped to one tenant; if anything else moved, something
      // is wrong with this database or this script. Undo everything and abort.
      await client.query('ROLLBACK');
      console.log('\n❌ other tenants changed — ROLLBACK, nothing was deleted:');
      for (const line of changed) console.log(`   ${line}`);
      return 1;
    }

    await client.query('COMMIT');

    console.log('\n── Row counts AFTER ───────────────────────────────────────');
    console.log(`  ${formatCounts(targetAfter)}`);

    console.log(`\n── Isolation check (${formatInt(otherTenantsBefore.length)} other tenant(s)) ──`);
    for (const previous of otherTenantsBefore) {
      console.log(`  ${previous.slug.padEnd(24)} unchanged: ${formatCounts(previous)}`);
    }
    console.log('\n✅ Reset complete — only this tenant was emptied;');
    console.log('   its tenant row, store and users were kept, so the logins still work.');
    return 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  console.error(`\n✗ ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exitCode = 1;
} finally {
  await pool.end();
}

