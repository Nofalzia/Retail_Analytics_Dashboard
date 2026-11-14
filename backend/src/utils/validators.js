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

// ── Flexible date parsing (T12b) ──────────────────────────────────────────────
// `new Date(rawValue)` is not safe for uploaded data: it reads an Excel serial
// number such as 45658 as 1970, and it reads "03/04/2025" as March 4th in some
// environments. A wrong date is worse than a rejected row, so the accepted
// formats are listed explicitly and anything else is rejected with its raw text.

/** Recorded when a slash-separated date could be day-first or month-first. */
export const DAY_FIRST_ASSUMPTION = 'Dates read as day/month/year';

/** Excel's 1900 date system counts days from 1899-12-30 (serial 1 = 1900-01-01). */
const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);

/** Accepted range for Excel serial cells: about 1954-10-03 to 2119-01-03. */
const EXCEL_SERIAL_MIN = 20000;
const EXCEL_SERIAL_MAX = 80000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Earliest year an imported sale may carry. */
const MIN_SALE_YEAR = 2000;

/** Month-name stems: the first three letters of every English month. */
const MONTH_NUMBER_BY_STEM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Pads a positive integer to two digits without any locale involvement.
 * @param {number} value Integer to pad.
 * @returns {string} e.g. 3 → "03".
 */
function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * Builds "YYYY-MM-DD" from calendar parts using pure UTC arithmetic, so no
 * local timezone offset can move the day. Rejects impossible dates (31 February
 * and friends) and any year outside 2000..(current year + 1).
 * @param {number} year Full year, e.g. 2025.
 * @param {number} month 1–12.
 * @param {number} day 1–31.
 * @returns {string|null} The ISO date, or null when the parts are not a real day.
 */
function formatUtcDate(year, month, day) {
  const lastAcceptedYear = new Date().getUTCFullYear() + 1;
  if (!Number.isInteger(year) || year < MIN_SALE_YEAR || year > lastAcceptedYear) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (!Number.isInteger(day) || day < 1 || day > 31) return null;

  const utc = new Date(Date.UTC(year, month - 1, day));
  // A roll-over (31/02 → 03/03) means that day does not exist in that month.
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * Converts an Excel serial number to "YYYY-MM-DD".
 * @param {number} serial Days since 1899-12-30; a time fraction is ignored.
 * @returns {string|null} The ISO date, or null outside the accepted range.
 */
function formatExcelSerial(serial) {
  if (!Number.isFinite(serial)) return null;
  if (serial < EXCEL_SERIAL_MIN || serial > EXCEL_SERIAL_MAX) return null;
  const utc = new Date(EXCEL_EPOCH_UTC_MS + Math.floor(serial) * MS_PER_DAY);
  return formatUtcDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
}

/**
 * Resolves a month name to its number, accepting abbreviations and full names
 * in any case ("Oct", "October").
 * @param {string} name Month name from the cell.
 * @returns {number|null} 1–12, or null when the text is not a month.
 */
function monthNumberFromName(name) {
  return MONTH_NUMBER_BY_STEM[String(name).slice(0, 3).toLowerCase()] ?? null;
}

/**
 * parseFlexibleDate(rawValue[, assumptions])
 * Turns one uploaded date cell into "YYYY-MM-DD". Accepted inputs:
 *   • ISO dates with or without a time — "2025-10-12", "2025-10-12T08:30:00"
 *     (the time is ignored: a sale is reported on the day it was recorded);
 *   • JS Date objects — what SheetJS produces with { cellDates: true };
 *   • Excel serial numbers 20000–80000 — 45658 is 2025-01-01, not 1970;
 *   • DD/MM/YYYY and DD-MM-YYYY;
 *   • MM/DD/YYYY only when the second part is over 12 and must be the day;
 *   • "12 Oct 2025" and "Oct 12, 2025" (full month names work too).
 *
 * When a slash date is ambiguous (both parts 12 or under) it is read
 * day/month/year and DAY_FIRST_ASSUMPTION is pushed onto `assumptions`, so the
 * import can state what it assumed instead of hiding it.
 *
 * @param {string|number|Date|null|undefined} rawValue The cell as uploaded.
 * @param {string[]} [assumptions] Optional list that receives any assumption.
 * @returns {string|null} "YYYY-MM-DD", or null when unparseable or out of range.
 */
export function parseFlexibleDate(rawValue, assumptions) {
  const recordDayFirst = () => {
    if (Array.isArray(assumptions) && !assumptions.includes(DAY_FIRST_ASSUMPTION)) {
      assumptions.push(DAY_FIRST_ASSUMPTION);
    }
  };

  // ── JS Date (an XLSX date cell read with cellDates: true) ─────────────────
  if (rawValue instanceof Date) {
    if (Number.isNaN(rawValue.getTime())) return null;
    // A Date sitting exactly on UTC midnight is a pure calendar date (ISO
    // strings and Date.UTC() land there), so read its UTC parts. A Date that
    // carries a wall-clock time is read with local parts — that is the day the
    // spreadsheet shows.
    const utcMidnight = Date.UTC(
      rawValue.getUTCFullYear(), rawValue.getUTCMonth(), rawValue.getUTCDate(),
    );
    const pureCalendarDate = rawValue.getTime() === utcMidnight;
    const year  = pureCalendarDate ? rawValue.getUTCFullYear() : rawValue.getFullYear();
    const month = (pureCalendarDate ? rawValue.getUTCMonth() : rawValue.getMonth()) + 1;
    const day   = pureCalendarDate ? rawValue.getUTCDate() : rawValue.getDate();
    return formatUtcDate(year, month, day);
  }

  // ── Excel serial numbers (a numeric cell in a workbook) ───────────────────
  if (typeof rawValue === 'number') return formatExcelSerial(rawValue);

  if (typeof rawValue !== 'string') return null;
  const text = rawValue.trim();
  if (text === '') return null;

  // ── ISO 8601: 2025-10-12 or 2025-10-12T08:30:00 (time part ignored) ──────
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (isoMatch) {
    return formatUtcDate(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // ── An Excel serial that arrived as text, e.g. from a CSV cell ───────────
  if (/^\d+(?:\.\d+)?$/.test(text)) return formatExcelSerial(Number(text));

  // ── Slash/dash dates: 31/12/2025, 31-12-2025, 12/31/2025 ─────────────────
  const numericMatch = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (numericMatch) {
    const first  = Number(numericMatch[1]);
    const second = Number(numericMatch[2]);
    const year   = Number(numericMatch[3]);

    // Two parts over 12 cannot be a month/day pair in either order.
    if (first > 12 && second > 12) return null;

    let day   = first;
    let month = second;
    if (second > 12) {
      // Only the second part can be the day, so this is unambiguously MM/DD.
      day   = second;
      month = first;
    } else if (first <= 12) {
      // Both parts could be the month: read day-first and say so.
      recordDayFirst();
    }
    // Otherwise first > 12 and second <= 12: unambiguously DD/MM.
    return formatUtcDate(year, month, day);
  }

  // ── Month names: "12 Oct 2025" and "Oct 12, 2025" ─────────────────────────
  const dayMonthName = /^(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{4})$/.exec(text);
  if (dayMonthName) {
    const month = monthNumberFromName(dayMonthName[2]);
    return month === null
      ? null
      : formatUtcDate(Number(dayMonthName[3]), month, Number(dayMonthName[1]));
  }

  const monthNameDay = /^([A-Za-z]{3,9})\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4})$/.exec(text);
  if (monthNameDay) {
    const month = monthNumberFromName(monthNameDay[1]);
    return month === null
      ? null
      : formatUtcDate(Number(monthNameDay[3]), month, Number(monthNameDay[2]));
  }

  return null;
}

/**
 * validateRow(rawRow, columnMap, rowIndex)
 * Validates a single data row after the column map has been applied.
 *
 * Date: parsed by parseFlexibleDate() — ISO, Excel serials, day-first slash
 * dates and month names are all accepted. An unreadable date is a row error
 * that quotes the raw cell, because a guessed date is worse than a rejection.
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
  const assumptions = [];

  // date — parsed explicitly (T12b), so Excel serials and day-first dates are
  // read correctly. The raw cell is passed untouched: a Date object from an
  // XLSX cell must not be stringified before parsing.
  const rawDate = columnMap.date ? rawRow[columnMap.date] : '';
  const parsedDate = parseFlexibleDate(rawDate, assumptions);
  if (!parsedDate) {
    errors.push(`row ${rowIndex}: invalid date "${String(rawDate ?? '').trim()}"`);
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
      sale_date:     parsedDate,  // 'YYYY-MM-DD', already UTC-built
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
