/**
 * utils/asOfDate.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Resolves the "as-of date" that every analysis window is anchored to.
 *
 * Measuring an analysis from today's date silently produces nothing for a store
 * whose data ends weeks or months ago: the velocity window contains no sales,
 * the detector evaluates empty days and the trend chart comes out flat. Anchoring
 * to the store's latest sale_date means "now" is wherever the data ends, so a
 * retailer who uploads last month's export still gets a real analysis.
 *
 * The date is cast to text inside SQL on purpose: a DATE → JS Date round-trip
 * applies a timezone and can move the date by one day.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** @returns {string} Today's local date as 'YYYY-MM-DD' (no UTC shift). */
function todayIsoDate() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Latest sale date for a tenant, optionally narrowed to one store.
 *
 * @param {(text: string, params?: any[]) => Promise<{ rows: any[] }>} runQuery
 *   Query runner — `query` from db/pool.js, or a client-bound `client.query`.
 * @param {string} tenantId  Tenant UUID (always taken from the JWT).
 * @param {string|null} [storeId] Store UUID. Omit / pass null for a tenant-wide
 *   date (used by the all-stores overview aggregate).
 * @returns {Promise<string>} 'YYYY-MM-DD' — the latest sale date in scope, or
 *   today's date when the scope has no sales at all.
 */
export async function getStoreAsOfDate(runQuery, tenantId, storeId) {
  const storeFilter = storeId ? 'AND st.store_id = $2' : '';
  const params      = storeId ? [tenantId, storeId] : [tenantId];

  const { rows } = await runQuery(
    `SELECT COALESCE(MAX(st.sale_date)::text, CURRENT_DATE::text) AS as_of_date
       FROM sale_transactions st
      WHERE st.tenant_id = $1
        ${storeFilter}`,
    params,
  );

  // MAX() over an empty scope is handled by COALESCE in SQL; the JS fallback
  // only guards against a driver that returns no row at all.
  return rows?.[0]?.as_of_date ?? todayIsoDate();
}
