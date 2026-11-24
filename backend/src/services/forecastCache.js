/**
 * services/forecastCache.js
 * ──────────────────────────────────────────────────────────────────────────────
 * A tiny in-process cache for one forecast result.
 *
 * Why it exists: fitting Holt-Winters costs ~230 ms on the 50-SKU tenant on top
 * of the stockout query, and Stockout Watch asks for the SAME forecast on every
 * poll — the store's own data cannot have changed inside a minute unless a file
 * was just imported. Measured on london-bakers-i10 (see the Phase 1 latency
 * note): 694 ms median without it.
 *
 * Scope, deliberately small:
 *   * key        — tenant + store + as-of date + every input that changes the
 *                  answer (engine, horizon, history window, velocity window);
 *   * lifetime   — TTL_MS, then the entry is refetched;
 *   * freshness  — invalidateForecastCache() is called by the upload pipeline the
 *                  moment an import for that store completes, so new rows are
 *                  never hidden behind a stale forecast;
 *   * bound      — MAX_ENTRIES, evicting the least-recently-read entry.
 *
 * It is a cache of pure output, not a source of truth: a miss, an eviction or a
 * restart all produce the same numbers, only later. Nothing here is exported to
 * the API surface.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/** How long a forecast stays fresh. Short: demand data is daily, not second-by-second. */
export const FORECAST_CACHE_TTL_MS = 60_000;

/** Upper bound on cached forecasts, so a long-lived server cannot grow without end. */
export const FORECAST_CACHE_MAX_ENTRIES = 500;

/** key -> { expiresAt: number, value: object } */
const entries = new Map();

/**
 * Builds the cache key. Every field that can change the forecast is in it —
 * including the engine and both windows — so two different requests can never
 * read each other's answer.
 * @param {{tenantId: string, storeId: string, asOfDate: string, engine: string,
 *   horizonDays: number, historyDays: number, velocityDays: number}} scope
 * @returns {string}
 */
export function buildForecastCacheKey(scope) {
  return [
    scope.tenantId,
    scope.storeId,
    scope.asOfDate,
    scope.engine,
    scope.horizonDays,
    scope.historyDays,
    scope.velocityDays,
  ].join('|');
}

/**
 * Reads a cached forecast.
 * @param {string} key Key from buildForecastCacheKey().
 * @returns {object|null} A private copy of the cached value, or null on a miss
 *   or an expired entry.
 */
export function readForecastCache(key) {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    entries.delete(key);
    return null;
  }
  // Re-insert so Map order stays least-recently-used first for the eviction below.
  entries.delete(key);
  entries.set(key, entry);
  return structuredClone(entry.value);
}

/**
 * Stores a forecast. Copies both ways, so a caller that mutates the object it
 * received (the routes add nothing, but a future caller might) cannot corrupt
 * what the next request reads back.
 * @param {string} key Key from buildForecastCacheKey().
 * @param {object} value The forecast result.
 */
export function writeForecastCache(key, value) {
  if (entries.size >= FORECAST_CACHE_MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value;
    if (oldestKey !== undefined) entries.delete(oldestKey);
  }
  entries.set(key, { expiresAt: Date.now() + FORECAST_CACHE_TTL_MS, value: structuredClone(value) });
}

/**
 * Drops every cached forecast for one store. Called by routes/upload.js right
 * after an import is marked completed: the sales or stock counts it wrote are
 * exactly what a forecast is computed from.
 * @param {string} tenantId Tenant UUID.
 * @param {string} storeId Store UUID.
 * @returns {number} How many entries were removed.
 */
export function invalidateForecastCache(tenantId, storeId) {
  const prefix = `${tenantId}|${storeId}|`;
  let removed = 0;
  for (const key of entries.keys()) {
    if (key.startsWith(prefix)) {
      entries.delete(key);
      removed += 1;
    }
  }
  return removed;
}

/** @returns {number} Cached forecasts currently held (diagnostics and tests). */
export function forecastCacheSize() {
  return entries.size;
}

/** Drops everything. For tests; the server never needs it. */
export function clearForecastCache() {
  entries.clear();
}
