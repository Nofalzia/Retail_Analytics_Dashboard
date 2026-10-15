/**
 * src/utils/salesUpload.js
 * ──────────────────────────────────────────────────────────────────────────────
 * The framework-free half of the sales-file upload flow.
 *
 * The Data Ingestion Hub and the cashier upload screen must accept exactly the
 * same files and describe the same failures, so the file contract, the
 * client-side pre-checks, the example-file download and the plain-language
 * wording all live here once. Nothing in this module names an industry: the file
 * contract is the column set the backend already requires
 * (backend/src/utils/validators.js) and role labels come from tenant config.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Canonical required headers, in template order. Mirrors REQUIRED_COLUMNS in
 * backend/src/utils/validators.js — the backend also accepts aliases such as
 * "sale date".
 */
export const REQUIRED_COLUMNS = ['date', 'sku', 'product_name', 'quantity_sold', 'unit_price', 'unit_cost'];

/** Friendly names for the required columns, used in human-readable messages. */
export const REQUIRED_COLUMN_LABELS = {
  date: 'Sale date',
  sku: 'SKU / product code',
  product_name: 'Product name',
  quantity_sold: 'Quantity sold',
  unit_price: 'Unit price',
  unit_cost: 'Unit cost',
};

export const TEMPLATE_HEADER = 'date,sku,product_name,quantity_sold,unit_price,unit_cost';
export const TEMPLATE_FILENAME = 'retail-import-template.csv';

/** Extensions the upload endpoint accepts. */
export const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];

/** Size cap — mirrors MAX_FILE_SIZE_MB in backend/src/routes/upload.js (default 25). */
export const MAX_FILE_SIZE_MB = parseInt(import.meta.env?.VITE_MAX_FILE_SIZE_MB, 10) || 25;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ── Plain-language upload wording ─────────────────────────────────────────────
// The cashier screen shows these strings verbatim: no codes, no server text.

export const FILE_TYPE_MESSAGE = 'Please choose a CSV or Excel file.';
export const FILE_SIZE_MESSAGE = 'This file is too large. Please send a smaller one or ask your manager.';
export const GENERIC_UPLOAD_MESSAGE = 'Something went wrong. Please try again, or ask your manager.';

/** Generates a CSV with the exact required headers, client-side. */
export const downloadTemplate = () => {
  const blob = new Blob(
    [`${TEMPLATE_HEADER}\n2026-10-01,SKU-TPLT-001,Sample Product,10,120.00,80.00\n`],
    { type: 'text/csv' },
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = TEMPLATE_FILENAME;
  anchor.click();
  URL.revokeObjectURL(url);
};

/**
 * Lower-cased extension of a file name, dot included.
 * @param {string} [fileName] File name as reported by the browser.
 * @returns {string} e.g. '.csv', or '' when the name has no extension.
 */
export const fileExtension = (fileName = '') => {
  const name = String(fileName);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
};

/**
 * Client-side pre-check that mirrors the backend contract — extension filter plus
 * the MAX_FILE_SIZE_MB cap — so an obviously bad pick fails instantly, with the
 * same wording on both upload screens.
 * @param {File} file File chosen or dropped by the user.
 * @returns {{ok: true}|{ok: false, reason: 'type'|'size', message: string}}
 */
export const validateSalesFile = (file) => {
  if (!ALLOWED_EXTENSIONS.includes(fileExtension(file?.name))) {
    return {
      ok: false,
      reason: 'type',
      message: `"${file?.name}" is not supported. Only .csv and .xlsx files can be imported.`,
    };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      reason: 'size',
      message: `"${file?.name}" is larger than the ${MAX_FILE_SIZE_MB}MB upload limit.`,
    };
  }
  return { ok: true };
};

/**
 * Short human date for messages: '2026-10-15' → '15 Oct 2026'. Values that are
 * already human-readable are returned unchanged, missing ones as null.
 * @param {string|null|undefined} value Date string (ISO date or timestamp).
 * @returns {string|null}
 */
export const toFriendlyDate = (value) => {
  if (!value) return null;
  const iso = String(value).slice(0, 10);
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return String(value);
  return parsed.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

/**
 * Date range for the summary card: one date, a range, or null when both ends are
 * unknown.
 * @param {string|null|undefined} dateFrom Earliest sale date in the upload.
 * @param {string|null|undefined} dateTo Latest sale date in the upload.
 * @returns {string|null}
 */
export const describeDateRange = (dateFrom, dateTo) => {
  const from = toFriendlyDate(dateFrom);
  const to = toFriendlyDate(dateTo);
  if (!from) return to;
  if (!to || from === to) return from;
  return `${from} – ${to}`;
};

/** ISO date carried by a duplicate-file message ("… already imported on 2026-10-15."). */
const DATE_IN_MESSAGE = /(\d{4}-\d{2}-\d{2})/;

/**
 * Column names carried by a MISSING_COLUMNS entry of an ingest job's error_log.
 * @param {Array<Object>|null|undefined} errorLog Job error_log array.
 * @returns {string[]} Canonical column names, or [] when none were reported.
 */
export const missingColumnsFromLog = (errorLog) => {
  if (!Array.isArray(errorLog)) return [];
  for (const entry of errorLog) {
    if (entry && entry.type === 'MISSING_COLUMNS' && Array.isArray(entry.columns)) return entry.columns;
  }
  return [];
};

/**
 * Plain-language wording for a missing required column.
 * @param {string} column Canonical column name, e.g. 'date'.
 * @returns {string} e.g. "Your file is missing the 'Sale date' column. …"
 */
export const missingColumnMessage = (column) =>
  `Your file is missing the '${REQUIRED_COLUMN_LABELS[column] ?? column}' column. ` +
  'Download the example file and compare.';

/**
 * Plain-language wording for a failed upload or a failed ingest job. No status
 * codes and no server text ever reach the screen.
 * @param {Error & {status?: number, code?: string, reason?: string}} err Failure to describe.
 * @returns {string} One calm English sentence.
 */
export const describeUploadFailure = (err) => {
  const raw = `${err?.message || ''} ${err?.data?.message || ''}`;

  // 409 DUPLICATE_FILE — the exact same file was already imported for this store.
  if (err?.status === 409 || err?.code === 'DUPLICATE_FILE') {
    const found = DATE_IN_MESSAGE.exec(raw);
    const when = found ? toFriendlyDate(found[1]) : null;
    return `This file was already uploaded${when ? ` on ${when}` : ' earlier'}. Nothing was changed.`;
  }
  if (err?.status === 413 || err?.code === 'FILE_TOO_LARGE') return FILE_SIZE_MESSAGE;
  if (/unsupported file type/i.test(raw)) return FILE_TYPE_MESSAGE;
  if (err?.reason === 'type') return FILE_TYPE_MESSAGE;
  if (err?.reason === 'size') return FILE_SIZE_MESSAGE;
  return GENERIC_UPLOAD_MESSAGE;
};
