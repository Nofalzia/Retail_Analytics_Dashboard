/**
 * db/pool.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Singleton pg Pool. Import this everywhere you need database access.
 * Using a singleton means all routes share the same connection pool —
 * no risk of exhausting connections by creating a new Pool per request.
 *
 * Pool size is conservative (max: 10) — suitable for a student/free-tier
 * hosted database. Raise it if you move to a dedicated instance.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set. Check your .env file.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,                      // maximum simultaneous connections
  idleTimeoutMillis: 30_000,    // close idle connections after 30s
  connectionTimeoutMillis: 5_000, // fail fast if the DB is unreachable
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // required by most hosted PostgreSQL providers
    : false,
});

// Crash loudly on unexpected pool errors rather than silently hanging
pool.on('error', (err) => {
  console.error('[db/pool] Unexpected pool error:', err.message);
  process.exit(1);
});

/**
 * Convenience wrapper: runs a single parameterised query.
 * Usage: const { rows } = await query('SELECT * FROM products WHERE tenant_id = $1', [tenantId])
 */
export const query = (text, params) => pool.query(text, params);

/**
 * Checks out a client from the pool for multi-statement transactions.
 * ALWAYS use try/finally to release the client back to the pool.
 *
 * Usage:
 *   const client = await getClient();
 *   try {
 *     await client.query('BEGIN');
 *     // ... your statements ...
 *     await client.query('COMMIT');
 *   } catch (err) {
 *     await client.query('ROLLBACK');
 *     throw err;
 *   } finally {
 *     client.release();
 *   }
 */
export const getClient = () => pool.connect();

export default pool;
