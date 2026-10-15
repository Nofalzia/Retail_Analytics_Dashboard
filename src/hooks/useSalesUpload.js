/**
 * src/hooks/useSalesUpload.js
 * ──────────────────────────────────────────────────────────────────────────────
 * One-file upload + poll, shared by the screens that ingest sales files.
 *
 * It wraps the same API calls the Data Ingestion Hub uses (POST /api/upload,
 * then GET /api/upload/:jobId/status until a terminal state) plus the T11a
 * roll-up (GET /api/upload/:jobId/summary), so no screen re-implements the
 * pipeline. Everything it reports comes from real job fields — nothing here is
 * simulated. The target store is resolved from the signed-in account's token
 * (see resolveStoreId), never from component input.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext';
import { resolveStoreId } from '../utils/resolveStoreId.js';
import { readTokenClaims } from '../utils/tokenClaims.js';
import {
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
  describeUploadFailure,
  missingColumnMessage,
  missingColumnsFromLog,
  validateSalesFile,
} from '../utils/salesUpload.js';

// One poll per second: imports of a few thousand rows settle in seconds, so the
// screen can stay calm rather than tuning a backoff.
const POLL_INTERVAL_MS = 1000;

/** No store on the account means there is nowhere to write the rows. */
const NO_STORE_MESSAGE = 'Your account is not linked to a store. Please contact support.';

/**
 * Tracks a single sales-file upload from pick to summary.
 *
 * @returns {{
 *   storeId: string|null,
 *   phase: 'idle'|'uploading'|'processing'|'done'|'error',
 *   fileName: string|null,
 *   jobId: string|null,
 *   rowsProcessed: number,
 *   totalRows: number|null,
 *   rowsFailed: number,
 *   summary: Object|null,
 *   error: string|null,
 *   start: (file: File) => void,
 *   reset: () => void,
 * }}
 */
export function useSalesUpload() {
  const { user, tenant, token } = useAuth();
  // A page refresh keeps the token but drops the user object, so the store claim
  // is read back from the token before falling back to the demo constant.
  const storeId = resolveStoreId(user?.storeId ?? readTokenClaims(token)?.storeId, tenant?.slug);

  const [phase, setPhase] = useState('idle');
  const [fileName, setFileName] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [rowProgress, setRowProgress] = useState({ rowsProcessed: 0, totalRows: null, rowsFailed: 0 });
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);

  // One timer, cancelled on unmount so polling stops when the screen goes.
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => () => {
    cancelledRef.current = true;
    stopPolling();
  }, [stopPolling]);

  const failWith = useCallback((message) => {
    setError(message);
    setPhase('error');
  }, []);

  /** The roll-up is a courtesy: if it cannot be read, the card still thanks them. */
  const loadSummary = useCallback(async (id) => {
    try {
      const data = await api.getUploadSummary(id);
      if (cancelledRef.current) return;
      setSummary(data ?? null);
    } catch {
      if (cancelledRef.current) return;
      setSummary(null);
    }
    if (!cancelledRef.current) setPhase('done');
  }, []);

  const poll = useCallback((id) => {
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const job = await api.getUploadStatus(id);
        if (cancelledRef.current) return;

        setRowProgress({
          rowsProcessed: job.rows_processed || 0,
          totalRows: job.total_rows ?? null,
          rowsFailed: job.rows_failed || 0,
        });

        if (job.status === 'completed' || job.status === 'failed') {
          stopPolling();
          const missing = missingColumnsFromLog(job.error_log);
          if (missing.length > 0) return failWith(missingColumnMessage(missing[0]));
          // A job that imported nothing is not a success, and a failed job has no
          // summary worth showing — both get the calm generic sentence.
          if (job.status === 'failed' || (job.rows_processed || 0) === 0) {
            return failWith(describeUploadFailure({ status: job.status }));
          }
          await loadSummary(id);
          return;
        }
      } catch (err) {
        // A dropped poll is a speed bump — the next tick retries. A 401 has
        // already returned the user to the sign-in screen (see api/client.js).
        if (cancelledRef.current || err?.status === 401) return;
      }
      timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [failWith, loadSummary, stopPolling]);

  /** Validate, upload, then follow the job to its terminal state. */
  const start = useCallback((file) => {
    if (!file) return;
    stopPolling();
    setFileName(file.name);
    setJobId(null);
    setSummary(null);
    setError(null);
    setRowProgress({ rowsProcessed: 0, totalRows: null, rowsFailed: 0 });

    if (!storeId) return failWith(NO_STORE_MESSAGE);

    const check = validateSalesFile(file);
    if (!check.ok) return failWith(check.reason === 'type' ? FILE_TYPE_MESSAGE : FILE_SIZE_MESSAGE);

    setPhase('uploading');
    api.uploadFile(storeId, file)
      .then(({ jobId: id }) => {
        if (cancelledRef.current) return;
        setJobId(id);
        setPhase('processing');
        poll(id);
      })
      .catch((err) => {
        if (!cancelledRef.current) failWith(describeUploadFailure(err));
      });
  }, [failWith, poll, stopPolling, storeId]);

  /** Back to a clean slate for the next file. */
  const reset = useCallback(() => {
    stopPolling();
    setPhase('idle');
    setFileName(null);
    setJobId(null);
    setRowProgress({ rowsProcessed: 0, totalRows: null, rowsFailed: 0 });
    setSummary(null);
    setError(null);
  }, [stopPolling]);

  return {
    storeId,
    phase,
    fileName,
    jobId,
    rowsProcessed: rowProgress.rowsProcessed,
    totalRows: rowProgress.totalRows,
    rowsFailed: rowProgress.rowsFailed,
    summary,
    error,
    start,
    reset,
  };
}

export default useSalesUpload;
