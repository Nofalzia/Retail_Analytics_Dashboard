/**
 * utils/validators.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Column validation for uploaded CSV/XLSX files.
 *
 * This turns the "structural checklist" shown in the DataIngestionHub UI
 * into real, programmatic validation logic.
 *
 * T12a — flexible column mapping:
 *   • headers are normalised before comparison, so "Unit Price (PKR)",
 *     "unit_price" and "Unit  Price" are the same header;
 *   • a file may carry a unit price OR a line total (the "price source"), and a
 *     SKU OR a product name (the "product identity") — both are accepted;
 *   • unit_cost is optional: when it is absent the cost is estimated from the
 *     price with COST_RATIO_DEFAULT, and the estimate is reported as an
 *     assumption rather than hidden;
 *   • rows whose status is cancelled / refunded / otherwise not a completed sale
 *     are skipped, not counted as errors.
 *
 * A header can only ever be claimed by ONE canonical column, so "Total Price"
 * always lands on total_revenue and never on unit_price.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * ACCEPTED_ROW_STATUSES
 * Rows whose normalised status is NOT in this list are skipped (they are not
 * errors): cancelled orders, refunds, quotes and the like.
 */
export const ACCEPTED_ROW_STATUSES = [
  'completed',
  'complete',
  'paid',
  'sold',
  'success',
  'successful',
  'delivered',
  'closed',
];

/** Ratio used when the file carries no cost column, unless the env says otherwise. */
const COST_RATIO_FALLBACK = 0.6;

/**
 * Reads COST_RATIO_DEFAULT from the environment, falling back to 0.6 whenever
 * it is missing, unparseable or outside the sensible 0–1 range.
 * @returns {number} A ratio between 0 and 1.
 */
function resolveCostRatio() {
  const configured = Number.parseFloat(process.env.COST_RATIO_DEFAULT ?? '');
  if (!Number.isFinite(configured) || configured < 0 || configured > 1) return COST_RATIO_FALLBACK;
  return configured;
}

/**
 * COST_RATIO_DEFAULT
 * Share of the unit price used as the unit cost when an uploaded file has no
 * cost column. Exported so the ingestion route, the UI wording and the
 * self-test all quote the number the row validator actually uses.
 */
export const COST_RATIO_DEFAULT = resolveCostRatio();

/**
 * COLUMN_ALIASES
 * Canonical column name → every header wording accepted for it. Aliases are
 * normalised with normaliseHeader() before comparison, so punctuation and
 * spacing in this table never matter.
 *
 * The Phase 2 parser resolves aliases to canonical names and stores the
 * mapping in ingestion_jobs.column_map so we can debug bad files later.
 */
export const COLUMN_ALIASES = {
  date:           ['date', 'sale date', 'transaction date', 'order date', 'invoice date', 'bill date', 'day'],
  sku:            ['sku', 'item code', 'product code', 'product id', 'item id', 'barcode', 'code'],
  product_name:   ['product name', 'product', 'item name', 'item', 'description', 'name'],
  quantity_sold:  ['quantity sold', 'quantity', 'qty', 'qty sold', 'units sold', 'units', 'pieces', 'pcs'],
  unit_price:     ['unit price', 'selling price', 'sale price', 'price', 'rate', 'price per unit'],
  total_revenue:  ['total price', 'total', 'line total', 'revenue', 'sales', 'amount', 'net amount', 'net sales', 'total sales'],
  unit_cost:      ['unit cost', 'cost price', 'cost', 'cogs', 'unit cogs', 'purchase price', 'realized cost'],
  category:       ['category', 'product category', 'department', 'type'],
  status:         ['status', 'order status', 'transaction status', 'payment status'],
  store_id:       ['store', 'store id', 'branch', 'location'],
};

/**
 * REQUIRED_COLUMNS
 * Requirements every upload must satisfy. A requirement is reported as missing
 * only when NOTHING matched it — the two "or" entries accept either of their
 * two canonical columns.
 */
export const REQUIRED_COLUMNS = ['date', 'quantity_sold', 'unit_price or total_revenue', 'sku or product_name'];

/** Canonical columns that can satisfy the price requirement. */
export const PRICE_COLUMNS = ['unit_price', 'total_revenue'];

/** Canonical columns that can satisfy the product-identity requirement. */
export const IDENTITY_COLUMNS = ['sku', 'product_name'];

/** Canonical columns that are parsed when present and never required. */
export const OPTIONAL_COLUMNS = ['sku', 'product_name', 'unit_cost', 'category', 'status', 'store_id'];

/** Reported when the file has no SKU column and product names become the codes. */
export const NO_SKU_ASSUMPTION = 'No SKU column: product names are used as product codes.';

/**
 * Wording for the estimated-cost assumption. The percentage is derived from the
 * ratio actually in force, so the sentence can never drift from it.
 * @param {number} [ratio] Cost ratio in use (defaults to COST_RATIO_DEFAULT).
 * @returns {string} e.g. "No cost column found: cost estimated at 60% of price, so margins are estimates."
 */
export function describeCostAssumption(ratio = COST_RATIO_DEFAULT) {
  const percent = Math.round(ratio * 100);
  return `No cost column found: cost estimated at ${percent}% of price, so margins are estimates.`;
}

/**
 * The order in which canonical columns claim headers. It only matters when one
 * header wording could suit two columns; the more specific column is listed
 * first so the mapping is deterministic. unit_price and total_revenue never
 * shadow each other because their alias lists do not overlap.
 */
const MATCH_ORDER = [
  'date',
  'quantity_sold',
  'sku',
  'product_name',
  'unit_price',
  'total_revenue',
  'unit_cost',
  'category',
  'status',
  'store_id',
];

/**
 * normaliseHeader(str)
 * Prepares a column header for comparison: lowercases, trims, drops any
 * bracketed suffix such as "(PKR)" or "[Net]", turns _ - . into spaces and
 * collapses repeated spaces.
 *
 * "Unit Price (PKR)" → "unit price"; "Total_Price." → "total price".
 * @param {string|number|null|undefined} str Raw header cell.
 * @returns {string} The normalised header, '' for an empty cell.
 */
export function normaliseHeader(str) {
  return String(str ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // "(PKR)", "(net of tax)"
    .replace(/\[[^\]]*\]/g, ' ')  // "[PKR]", "[Net]"
    .replace(/[_\-.]/g, ' ')      // underscores, dashes and dots act as spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every accepted alias, normalised, for the "unrecognised column" warning. */
const KNOWN_ALIASES = new Set(Object.values(COLUMN_ALIASES).flat().map(normaliseHeader));


/**
 * buildColumnMap(fileHeaders)
 * Given the headers extracted from an uploaded file, returns a mapping of
 * canonical column name → actual header in the file. Each header is claimed by
 * at most one canonical column.
 *
 * @param {string[]} fileHeaders — raw headers from the CSV/XLSX
 * @returns {{
 *   map: Object,
 *   missing: string[],
 *   warnings: string[],
 *   assumptions: string[],
 *   detectedHeaders: string[],
 * }} `missing` lists only requirements nothing matched; `assumptions` records
 *    the estimates the import will make (estimated cost, product name as SKU).
 */
export function buildColumnMap(fileHeaders) {
  const detectedHeaders = (Array.isArray(fileHeaders) ? fileHeaders : [])
    .map((header) => String(header ?? '').trim())
    .filter(Boolean);
  const normalisedHeaders = detectedHeaders.map(normaliseHeader);

  const map = {};
  const claimedIndexes = new Set();

  for (const canonicalName of MATCH_ORDER) {
    for (const alias of COLUMN_ALIASES[canonicalName]) {
      const normalisedAlias = normaliseHeader(alias);
      const index = normalisedHeaders.findIndex(
        (header, headerIndex) => !claimedIndexes.has(headerIndex) && header === normalisedAlias,
      );
      if (index !== -1) {
        // Keep the actual header from the file (pre-normalisation) for display.
        claimedIndexes.add(index);
        map[canonicalName] = detectedHeaders[index];
        break;
      }
    }
  }

  // A requirement is reported only when NOTHING matched it.
  const missing = [];
  if (!map.date) missing.push('date');
  if (!map.quantity_sold) missing.push('quantity_sold');
  if (!PRICE_COLUMNS.some((column) => map[column])) missing.push('unit_price or total_revenue');
  if (!IDENTITY_COLUMNS.some((column) => map[column])) missing.push('sku or product_name');

  // Values we estimate instead of asking for. Reported up front so the UI can
  // say "this is an estimate" rather than presenting a guess as a measurement.
  const assumptions = [];
  if (!map.unit_cost) assumptions.push(describeCostAssumption());
  if (!map.sku) assumptions.push(NO_SKU_ASSUMPTION);

  // Unrecognised columns are ignored, not an error.
  const unknownHeaders = normalisedHeaders.filter(
    (header, index) => header && !claimedIndexes.has(index) && !KNOWN_ALIASES.has(header),
  );
  const warnings = [];
  if (unknownHeaders.length > 0) {
    warnings.push(`Unrecognised columns (will be ignored): ${unknownHeaders.join(', ')}`);
  }

  return { map, missing, warnings, assumptions, detectedHeaders };
}

/**
 * Rounds a number to two decimal places (money precision).
 * @param {number} value Value to round.
 * @returns {number} The value rounded to 2 dp.
 */
function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

/**
 * validateRow(rawRow, columnMap, rowIndex)
 * Validates a single data row after the column map has been applied.
 *
 * Price: when a line total is mapped it becomes the net unit price
 * (total_revenue / quantity_sold, rounded to 2 dp) — the figure after
 * discounts. Otherwise the unit_price column is used. A row is rejected only
 * when neither can be read.
 *
 * Cost: when no cost column is mapped, unit_cost = round(unit_price ×
 * COST_RATIO_DEFAULT, 2) and the estimate is reported in `assumptions`.
 *
 * Identity: when no SKU column is mapped, the trimmed product name becomes the
 * SKU (and the assumption says so).
 *
 * Status: when status is mapped, a row whose normalised status is not a
 * completed sale is skipped — it is not counted as an error.
 *
 * @param {Object} rawRow     — key/value pairs from the CSV parser
 * @param {Object} columnMap  — canonical name → actual header from buildColumnMap()
 * @param {number} rowIndex   — 1-based row number for error messages
 * @returns {{ data: Object|null, error: string|null, skipped: 'status'|null, assumptions: string[] }}
 */
export function validateRow(rawRow, columnMap, rowIndex) {
  const get = (canonicalName) => {
    const header = columnMap[canonicalName];
    return header ? String(rawRow[header] ?? '').trim() : '';
  };

  // ── Status filter: cancelled / refunded / unknown rows are skipped ────────
  if (columnMap.status) {
    const normalisedStatus = normaliseHeader(get('status'));
    if (!ACCEPTED_ROW_STATUSES.includes(normalisedStatus)) {
      return { data: null, error: null, skipped: 'status', assumptions: [] };
    }
  }

  const errors = [];

  // date — must be parseable
  const rawDate = get('date');
  const parsedDate = new Date(rawDate);
  if (!rawDate || isNaN(parsedDate.getTime())) {
    errors.push(`row ${rowIndex}: invalid date "${rawDate}"`);
  }

  // quantity_sold — must be a positive integer (also the divisor of a line total)
  const rawQuantity = get('quantity_sold');
  const quantitySold = parseInt(rawQuantity, 10);
  const hasUsableQuantity = !isNaN(quantitySold) && quantitySold > 0;
  if (!hasUsableQuantity) {
    errors.push(`row ${rowIndex}: invalid quantity "${rawQuantity}" — must be a positive integer`);
  }

  // ── Price: a usable line total wins, because it is already net of discounts ─
  const rawTotalRevenue = get('total_revenue');
  const totalRevenue = parseFloat(rawTotalRevenue);
  const rawUnitPrice = get('unit_price');
  const unitPriceFromColumn = parseFloat(rawUnitPrice);

  let unitPrice = null;
  if (columnMap.total_revenue && isFinite(totalRevenue) && totalRevenue >= 0 && hasUsableQuantity) {
    unitPrice = roundCurrency(totalRevenue / quantitySold);
  } else if (isFinite(unitPriceFromColumn) && unitPriceFromColumn >= 0) {
    unitPrice = unitPriceFromColumn;
  } else {
    // Say why the price could not be read: a bad number, or a line total that
    // has no valid quantity to divide by.
    const source = columnMap.total_revenue
      ? `total_revenue "${rawTotalRevenue}"`
      : `unit_price "${rawUnitPrice}"`;
    const reason = columnMap.total_revenue && !hasUsableQuantity
      ? 'needs a valid quantity to divide by'
      : 'must be a non-negative number';
    errors.push(`row ${rowIndex}: invalid price — ${source} ${reason}`);
  }

  // ── Cost: mapped column, or an estimate at COST_RATIO_DEFAULT ─────────────
  const assumptions = [];
  let unitCost = null;
  if (columnMap.unit_cost) {
    const rawCost = get('unit_cost');
    unitCost = parseFloat(rawCost);
    if (isNaN(unitCost) || unitCost < 0) {
      errors.push(`row ${rowIndex}: invalid unit_cost "${rawCost}"`);
      unitCost = null;
    }
  } else if (unitPrice !== null) {
    unitCost = roundCurrency(unitPrice * COST_RATIO_DEFAULT);
    assumptions.push(describeCostAssumption());
  }

  // ── Identity: SKU, or the product name acting as the product code ─────────
  const sku = get('sku');
  const productName = get('product_name') || sku;
  const resolvedSku = sku || productName;
  if (!sku && productName) assumptions.push(NO_SKU_ASSUMPTION);
  if (!resolvedSku) {
    errors.push(`row ${rowIndex}: missing SKU and product name`);
  }

  if (errors.length > 0) {
    return { data: null, error: errors.join('; '), skipped: null, assumptions: [] };
  }

  return {
    data: {
      sale_date:     parsedDate.toISOString().slice(0, 10),  // 'YYYY-MM-DD'
      sku:           resolvedSku,
      product_name:  productName,
      category:      get('category') || null,
      quantity_sold: quantitySold,
      unit_price:    unitPrice,
      unit_cost:     unitCost,
    },
    error: null,
    skipped: null,
    assumptions,
  };
}
