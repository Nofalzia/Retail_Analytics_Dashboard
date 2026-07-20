/**
 * utils/validators.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Column validation for uploaded CSV/XLSX files.
 *
 * This turns the "structural checklist" shown in the DataIngestionHub UI
 * into real, programmatic validation logic.
 *
 * The standardized import template requires these columns (case-insensitive,
 * whitespace-trimmed). Column names are normalised before checking so a user's
 * "Sale Date" and "sale_date" both pass.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * REQUIRED_COLUMNS
 * The minimum set of columns that must be present in any uploaded file.
 * Maps the canonical internal name → an array of accepted aliases.
 *
 * The Phase 2 parser resolves aliases to canonical names and stores the
 * mapping in ingestion_jobs.column_map so we can debug bad files later.
 */
export const REQUIRED_COLUMNS = {
  date:           ['date', 'sale date', 'sale_date', 'transaction date', 'order date'],
  sku:            ['sku', 'item code', 'product code', 'barcode', 'product_id'],
  product_name:   ['product name', 'product_name', 'item name', 'description', 'item'],
  quantity_sold:  ['quantity sold', 'quantity_sold', 'qty sold', 'qty', 'units sold', 'units dispatched'],
  unit_price:     ['unit price', 'unit_price', 'selling price', 'sale price', 'price'],
  unit_cost:      ['unit cost', 'unit_cost', 'cost price', 'cost_price', 'realized cost', 'cogs'],
};

/**
 * OPTIONAL_COLUMNS
 * Present in some files but not required. Parsed when present.
 */
export const OPTIONAL_COLUMNS = {
  category:       ['category', 'product category', 'department', 'type'],
  store_id:       ['store', 'store id', 'store_id', 'branch', 'location'],
};

/**
 * normaliseHeader(str)
 * Lowercases and trims a column header for comparison.
 */
export function normaliseHeader(str) {
  return String(str).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * buildColumnMap(fileHeaders)
 * Given the headers extracted from an uploaded file, returns a mapping of
 * canonical column name → actual header in the file.
 * Returns null for any required column that couldn't be matched.
 *
 * @param {string[]} fileHeaders  — raw headers from the CSV/XLSX
 * @returns {{ map: Object, missing: string[], warnings: string[] }}
 */
export function buildColumnMap(fileHeaders) {
  const normalisedHeaders = fileHeaders.map(normaliseHeader);
  const map = {};
  const missing = [];
  const warnings = [];

  // Check required columns
  for (const [canonicalName, aliases] of Object.entries(REQUIRED_COLUMNS)) {
    const matchedAlias = aliases.find((alias) => normalisedHeaders.includes(alias));
    if (matchedAlias) {
      // Store the actual header from the file (pre-normalisation) for display
      const actualHeader = fileHeaders[normalisedHeaders.indexOf(matchedAlias)];
      map[canonicalName] = actualHeader;
    } else {
      missing.push(canonicalName);
    }
  }

  // Check optional columns — add to map if found, no error if missing
  for (const [canonicalName, aliases] of Object.entries(OPTIONAL_COLUMNS)) {
    const matchedAlias = aliases.find((alias) => normalisedHeaders.includes(alias));
    if (matchedAlias) {
      const actualHeader = fileHeaders[normalisedHeaders.indexOf(matchedAlias)];
      map[canonicalName] = actualHeader;
    }
  }

  // Warn about any unrecognised columns (not an error — we just ignore them)
  const allKnownAliases = [
    ...Object.values(REQUIRED_COLUMNS).flat(),
    ...Object.values(OPTIONAL_COLUMNS).flat(),
  ];
  const unknownHeaders = normalisedHeaders.filter(
    (h) => h && !allKnownAliases.includes(h),
  );
  if (unknownHeaders.length > 0) {
    warnings.push(`Unrecognised columns (will be ignored): ${unknownHeaders.join(', ')}`);
  }

  return { map, missing, warnings };
}

/**
 * validateRow(rawRow, columnMap, rowIndex)
 * Validates a single data row after the column map has been applied.
 * Returns { data: Object | null, error: string | null }.
 *
 * @param {Object} rawRow      — key/value pairs from the CSV parser
 * @param {Object} columnMap   — canonical name → actual header from buildColumnMap()
 * @param {number} rowIndex    — 1-based row number for error messages
 * @returns {{ data: Object|null, error: string|null }}
 */
export function validateRow(rawRow, columnMap, rowIndex) {
  const get = (canonicalName) => {
    const header = columnMap[canonicalName];
    return header ? String(rawRow[header] ?? '').trim() : '';
  };

  const errors = [];

  // date — must be parseable
  const rawDate = get('date');
  const parsedDate = new Date(rawDate);
  if (!rawDate || isNaN(parsedDate.getTime())) {
    errors.push(`row ${rowIndex}: invalid date "${rawDate}"`);
  }

  // sku
  const sku = get('sku');
  if (!sku) errors.push(`row ${rowIndex}: missing SKU`);

  // product_name — fall back to sku if blank
  const productName = get('product_name') || sku;

  // quantity_sold — must be a positive integer
  const rawQty = get('quantity_sold');
  const qty = parseInt(rawQty, 10);
  if (isNaN(qty) || qty <= 0) {
    errors.push(`row ${rowIndex}: invalid quantity "${rawQty}" — must be a positive integer`);
  }

  // unit_price — must be a non-negative number
  const rawPrice = get('unit_price');
  const unitPrice = parseFloat(rawPrice);
  if (isNaN(unitPrice) || unitPrice < 0) {
    errors.push(`row ${rowIndex}: invalid unit_price "${rawPrice}"`);
  }

  // unit_cost — must be a non-negative number
  const rawCost = get('unit_cost');
  const unitCost = parseFloat(rawCost);
  if (isNaN(unitCost) || unitCost < 0) {
    errors.push(`row ${rowIndex}: invalid unit_cost "${rawCost}"`);
  }

  if (errors.length > 0) {
    return { data: null, error: errors.join('; ') };
  }

  return {
    data: {
      sale_date:    parsedDate.toISOString().slice(0, 10),  // 'YYYY-MM-DD'
      sku:          sku,
      product_name: productName,
      category:     get('category') || null,
      quantity_sold: qty,
      unit_price:   unitPrice,
      unit_cost:    unitCost,
    },
    error: null,
  };
}
