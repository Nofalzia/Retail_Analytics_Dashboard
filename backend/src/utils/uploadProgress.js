/**
 * backend/src/utils/uploadProgress.js
 * ────────────────────────────────────────────────────────────────────────────
 * Import-progress arithmetic for `GET /api/upload/:jobId/status`.
 *
 * WHY THIS IS A SEPARATE FUNCTION
 * ────────────────────────────────────────────────────────────────────────────
 * `ingestion_jobs` keeps three counters, and they do not partition the file the
 * way a naive percentage assumes:
 *
 *   total_rows     — every data row the parser saw, INCLUDING rows the import
 *                    deliberately did not write
 *   rows_processed — rows actually inserted
 *   rows_failed    — rows rejected with an error (surfaced in error_log)
 *
 * Rows skipped by the status filter (cancelled / refunded, T12a) are counted in
 * neither `rows_processed` nor `rows_failed`; they live in
 * `column_map._skippedByStatus`. Dividing `rows_processed` by `total_rows` alone
 * therefore under-reports a finished import: the messy demo file (3,599 rows,
 * 1,123 skipped, 5 rejected, 2,471 written) reported 69 % on a job that had
 * completed. The percentage must count every row the job is done with.
 * ────────────────────────────────────────────────────────────────────────────

/** Status value that means "the import ran to the end of the file". */
const COMPLETED_STATUS = 'completed';

/**
 * Coerces a counter to a non-negative integer. Anything unparseable counts as
 * zero: a missing counter must never make the bar go backwards.
 *
 * @param {unknown} value Raw counter from the database row.
 * @returns {number} A finite integer ≥ 0.
 */
function toCount(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

/**
 * Percentage of the file an import job has finished with.
 *
 * - A `completed` job is always **100**, whatever the counters say. Rows are
 *   written and then the job is marked complete in the same step, so any other
 *   answer would be a rounding artifact shown to the user as "still working".
 * - Any other status counts rows processed **plus** rows failed **plus** rows
 *   skipped by the status filter, and is capped at **99**: a running job that
 *   has counted every row but not yet committed the last chunk is not finished
 *   yet, and a failed job did not finish either.
 * - A job with no row count yet (nothing parsed, e.g. while a header is still
 *   being checked) returns `null`, which the client renders as an indeterminate
 *   bar rather than 0 %.
 *
 * @param {object} counters
 * @param {string|null} [counters.status] `ingestion_jobs.status`.
 * @param {number|null} [counters.totalRows] `ingestion_jobs.total_rows`.
 * @param {number|null} [counters.rowsProcessed] `ingestion_jobs.rows_processed`.
 * @param {number|null} [counters.rowsFailed] `ingestion_jobs.rows_failed`.
 * @param {number|null} [counters.skippedByStatus] `column_map._skippedByStatus`.
 * @returns {number|null} Integer 0–100, or `null` when nothing has been counted.
 */
export function computeProgressPct({
  status = null,
  totalRows = null,
  rowsProcessed = null,
  rowsFailed = null,
  skippedByStatus = null,
} = {}) {
  if (status === COMPLETED_STATUS) return 100;

  const total = toCount(totalRows);
  if (total === 0) return null;

  const settledRows = toCount(rowsProcessed) + toCount(rowsFailed) + toCount(skippedByStatus);
  const percentage = Math.round((settledRows / total) * 100);

  return Math.max(0, Math.min(percentage, 99));
}
