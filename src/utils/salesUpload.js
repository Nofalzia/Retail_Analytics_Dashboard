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
 * Canonical requirements, in checklist order. Mirrors REQUIRED_COLUMNS in
 * backend/src/utils/validators.js — the backend also accepts aliases such as
 * "sale date", a line total instead of a unit price, and a product name instead
 * of a SKU, so a requirement is only unmet when nothing matches it.
 */
export const REQUIRED_COLUMNS = ['date', 'quantity_sold', 'unit_price or total_revenue', 'sku or product_name'];

/** Friendly names for the requirements, used in human-readable messages. */
export const REQUIRED_COLUMN_LABELS = {
  date: 'Sale date',
  quantity_sold: 'Quantity sold',
  'unit_price or total_revenue': 'Unit price or line total',
  'sku or product_name': 'SKU or product name',
  // Canonical column names can still arrive in server messages and job logs.
  sku: 'SKU / product code',
  product_name: 'Product name',
  unit_price: 'Unit price',
  total_revenue: 'Line total',
  unit_cost: 'Unit cost',
  quantity_on_hand: 'Quantity on hand',
  count_date: 'Count date',
};

export const TEMPLATE_HEADER = 'date,sku,product_name,quantity_sold,unit_price,unit_cost';
export const TEMPLATE_FILENAME = 'retail-import-template.csv';

// ── Stock-count template (T12e) ──────────────────────────────────────────────
// A stock count is a different file from a sales file: it says how much is on the
// shelf, not what moved. The upload endpoint decides which kind a file is from its
// headers (backend/src/utils/validators.js → detectFileKind), so the two templates
// are the only place a user has to get that choice right. Column names mirror
// INVENTORY_COLUMNS: sku and quantity_on_hand are required; count_date and
// product_name are optional.
export const INVENTORY_TEMPLATE_HEADER = 'sku,quantity_on_hand,count_date,product_name';
export const INVENTORY_TEMPLATE_FILENAME = 'retail-stock-count-template.csv';

/** Extensions the upload endpoint accepts. */
export const ALLOWED_EXTENSIONS = ['.csv', '.xlsx'];

/** Size cap — mirrors MAX_FILE_SIZE_MB in backend/src/routes/upload.js (default 60). */
export const MAX_FILE_SIZE_MB = parseInt(import.meta.env?.VITE_MAX_FILE_SIZE_MB, 10) || 60;
export const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// ── Plain-language upload wording ─────────────────────────────────────────────
// The cashier screen shows these strings verbatim: no codes, no server text.

export const FILE_TYPE_MESSAGE = 'Please choose a CSV or Excel file.';
export const FILE_SIZE_MESSAGE =
  'This file is too large. Please export it as CSV and try again, or ask your manager.';
export const GENERIC_UPLOAD_MESSAGE = 'Something went wrong. Please try again, or ask your manager.';

/**
 * Writes a CSV to the user's downloads folder. Built in the browser with a Blob —
 * templates have no backend endpoint, so these two downloads can never disagree
 * with the column names this module exports.
 * @param {string} fileName Name of the downloaded file.
 * @param {string[]} lines CSV lines, header first.
 */
const saveCsv = (fileName, lines) => {
  const blob = new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** Generates the sales template — the exact required headers plus one sample row. */
export const downloadTemplate = () => saveCsv(TEMPLATE_FILENAME, [
  TEMPLATE_HEADER,
  '2026-10-01,SKU-TPLT-001,Sample Product,10,120.00,80.00',
]);

/**
 * Generates the stock-count template (T12e): one row per product, how many units
 * are on the shelf and the date they were counted. A stock count never creates
 * products, so the sample SKU has to be replaced with one the store already sells.
 */
export const downloadInventoryTemplate = () => saveCsv(INVENTORY_TEMPLATE_FILENAME, [
  INVENTORY_TEMPLATE_HEADER,
  'SKU-TPLT-001,24,2026-10-01,Sample Product',
]);

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
      message: `"${file?.name}" is larger than the ${MAX_FILE_SIZE_MB}MB upload limit. ` +
        'Please export it as CSV and try again.',
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
 * The MISSING_COLUMNS entry of an ingest job's error_log, so a screen can show
 * both what was absent and the headers the file actually had.
 * @param {Array<Object>|null|undefined} errorLog Job error_log array.
 * @returns {{ columns: string[], detectedHeaders: string[] }|null} Null when the
 *   log holds no MISSING_COLUMNS entry.
 */
export const missingColumnsEntryFromLog = (errorLog) => {
  if (!Array.isArray(errorLog)) return null;
  for (const entry of errorLog) {
    if (entry && entry.type === 'MISSING_COLUMNS') {
      return {
        columns: Array.isArray(entry.columns) ? entry.columns : [],
        detectedHeaders: Array.isArray(entry.detectedHeaders) ? entry.detectedHeaders : [],
      };
    }
  }
  return null;
};

/**
 * Column names carried by a MISSING_COLUMNS entry of an ingest job's error_log.
 * @param {Array<Object>|null|undefined} errorLog Job error_log array.
 * @returns {string[]} Canonical column names, or [] when none were reported.
 */
export const missingColumnsFromLog = (errorLog) => missingColumnsEntryFromLog(errorLog)?.columns ?? [];

/**
 * Plain-language wording for a missing required column.
 * @param {string} column Canonical column name, e.g. 'date'.
 * @returns {string} e.g. "Your file is missing the 'Sale date' column. …"
 */
export const missingColumnMessage = (column) =>
  `Your file is missing the '${REQUIRED_COLUMN_LABELS[column] ?? column}' column. ` +
  'Download the example file and compare.';

/**
 * What an import estimated or ignored, in plain sentences for the warning
 * surface. Estimates are stated as estimates — never as measured facts.
 * @param {{ assumptions?: string[], skippedByStatus?: number }|null|undefined} job
 *   A job from GET /api/upload/:jobId/status.
 * @returns {string[]} Warning lines, empty when the import made no compromises.
 */
export const describeIngestionNotices = (job) => {
  const lines = Array.isArray(job?.assumptions)
    ? job.assumptions.map((line) => String(line ?? '').trim()).filter(Boolean)
    : [];
  const skipped = Number(job?.skippedByStatus) || 0;
  if (skipped > 0) {
    lines.push(
      skipped === 1
        ? '1 cancelled or refunded row was ignored.'
        : `${skipped} cancelled or refunded rows were ignored.`,
    );
  }
  return lines;
};

/**
 * Plain-language wording for the analysis an import ran automatically (T12d):
 * the alerts and recommendations the engines wrote from the rows just imported.
 * @param {{ alertsCreated?: number, recommendationsCreated?: number, error?: string }|null|undefined} analysis
 *   The `analysis` field of GET /api/upload/:jobId/summary; null/undefined when
 *   the job imported no rows and therefore ran no analysis.
 * @returns {string|null} e.g. "Analysis complete: 2 alerts, 2 recommendations",
 *   or null when there is nothing honest to say.
 */
export const describeAnalysisOutcome = (analysis) => {
  if (!analysis || typeof analysis !== 'object') return null;
  if (analysis.error) {
    return 'Your data is saved, but the analysis could not finish. It can be re-run from the dashboard.';
  }
  const alerts = Number(analysis.alertsCreated) || 0;
  const recommendations = Number(analysis.recommendationsCreated) || 0;
  // Nothing new is a normal outcome: a clean dataset, or a re-import of days the
  // engines have already looked at (both tables dedupe on conflict). Say so
  // plainly instead of printing "0 alerts, 0 recommendations".
  if (alerts === 0 && recommendations === 0) {
    return 'Analysis complete: no new alerts or recommendations to report.';
  }
  return `Analysis complete: ${alerts} alert${alerts === 1 ? '' : 's'}, `
    + `${recommendations} recommendation${recommendations === 1 ? '' : 's'}`;
};

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
