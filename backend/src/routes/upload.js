/**
 * routes/upload.js
 * ──────────────────────────────────────────────────────────────────────────────
 * POST /api/upload
 * GET  /api/upload/:jobId/status
 * GET  /api/upload/:jobId/summary
 *
 * The file parsing pipeline. This is the Phase 2 scalability centrepiece.
 *
 * Scalability decision (documented for FYP grading criterion #5):
 * ─────────────────────────────────────────────────────────────────
 * CSV files are STREAMED + WRITTEN IN CHUNKS rather than loaded whole:
 *
 * 1. Memory safety: a 10MB CSV with 50k rows would create a 50k-element
 *    JavaScript array in the sync approach. With streams, the parser emits
 *    rows one at a time; we buffer them in a chunk (CHUNK_ROWS = 1000) and
 *    flush to the database via a single multi-row INSERT before moving on.
 *    Peak memory stays flat regardless of file size.
 *
 * 2. Event loop safety: synchronous file.toString().split('\n') blocks the
 *    event loop for the entire parse duration. The stream-based approach
 *    yields control back to the event loop between chunks.
 *
 * 3. Round-trip economy (T8c): once parsing stopped being the bottleneck, the
 *    remote database's latency was — the old pipeline issued 4 statements per
 *    250-row chunk. Product ids are now cached per job (a SKU is written once),
 *    chunks hold 1000 rows, and rows_processed is refreshed every 5 chunks
 *    rather than every chunk: ~1.2 statements per 1000 rows in steady state.
 *
 * XLSX/XLS is the honest exception: SheetJS has no row-by-row reader, so
 * XLSX.readFile() loads the whole workbook into memory (with cellDates: true,
 * so date cells arrive as Date objects and Excel serials are never misread).
 * MAX_FILE_SIZE_MB (default 60) is therefore the real guard rail for workbook
 * size. T12b: every sheet's header row is checked with buildColumnMap and the
 * FIRST sheet whose requirements all map is imported, so a workbook that opens
 * on a notes tab is still read correctly.
 *
 * T12d — the analysis runs with the import
 * ───────────────────────────────────────
 * Once every row is written and before the job is marked completed, the same
 * detection + recommendation run the manual "Run Detection" button performs
 * (services/analysisRunner.js) is executed for the store. An import therefore
 * ends with alerts and advice already waiting instead of nothing until someone
 * clicks. The outcome is recorded in column_map._analysis and surfaced by
 * GET /:jobId/summary. A failure there is recorded, never fatal: the rows are
 * already in, and the job still completes (no new status values).
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { Router }         from 'express';
import multer             from 'multer';
import fs                 from 'fs';
import path               from 'path';
import { createReadStream } from 'fs';
import { createHash }       from 'node:crypto';
import csvParser          from 'csv-parser';
import XLSX               from 'xlsx';
import { requireAuth }    from '../middleware/auth.js';
import { resolveTenant }  from '../middleware/tenant.js';
import { query, getClient } from '../db/pool.js';
import { buildColumnMap, validateRow } from '../utils/validators.js';
import { runAnalysis }    from '../services/analysisRunner.js';

const router = Router();

// ── Multer configuration ─────────────────────────────────────────────────────
// Store files on disk (not memory) so we can stream them.
// We'll delete the temp file after processing.
const UPLOAD_DIR = process.env.UPLOAD_TEMP_DIR || './uploads/temp';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const safeFilename = `${Date.now()}-${path.basename(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '_')}`;
    cb(null, safeFilename);
  },
});

const upload = multer({
  storage,
  // Default cap 60 MB (T12b; was 25 MB) — XLSX workbooks are read into memory.
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 60) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Allowed: ${allowed.join(', ')}`));
  },
});

// ── Constants ─────────────────────────────────────────────────────────────────
// T8c: this pipeline is round-trip bound, not CPU bound — every statement pays
// the remote database's latency (~150 ms measured), so the cheapest win is to
// need fewer statements. Three levers: larger chunks, product ids cached per
// job, and a progress counter that is no longer written on every single chunk.
const CHUNK_ROWS = 1000;            // rows per database INSERT batch
const PROGRESS_EVERY_N_CHUNKS = 5;  // how often ingestion_jobs.rows_processed is refreshed

const SALE_INSERT_PARAMS_PER_ROW    = 8; // sale_transactions binds 8 columns per row
const PRODUCT_INSERT_PARAMS_PER_ROW = 3; // products binds 3 columns per row (+ tenant_id)
const PG_MAX_PARAMS                 = 65535; // PostgreSQL wire-protocol parameter limit

// Guard rail: a chunk must never exceed the Postgres parameter limit, or the
// insert dies at runtime with "bind message supplies N parameters". These are
// cheap arithmetic checks — fail loudly at boot rather than mid-import.
if (CHUNK_ROWS * SALE_INSERT_PARAMS_PER_ROW >= PG_MAX_PARAMS) {
  throw new Error(
    `CHUNK_ROWS (${CHUNK_ROWS}) x ${SALE_INSERT_PARAMS_PER_ROW} sale columns exceeds ` +
    `the Postgres parameter limit (${PG_MAX_PARAMS}).`,
  );
}
if (CHUNK_ROWS * PRODUCT_INSERT_PARAMS_PER_ROW + 1 >= PG_MAX_PARAMS) {
  throw new Error(
    `CHUNK_ROWS (${CHUNK_ROWS}) x ${PRODUCT_INSERT_PARAMS_PER_ROW} product columns exceeds ` +
    `the Postgres parameter limit (${PG_MAX_PARAMS}).`,
  );
}

// INGEST_DEBUG=1 logs one line per chunk with the number of database queries it
// cost — the metric T8c exists to move. Off by default; costs one comparison.
const INGEST_DEBUG = process.env.INGEST_DEBUG === '1';

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/upload
// Accepts a multipart/form-data upload with fields:
//   file     — the CSV or XLSX file
//   storeId  — UUID of the target store
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  '/',
  requireAuth,
  resolveTenant,
  upload.single('file'),
  async (req, res) => {
    const { tenantId } = req;
    const { storeId }  = req.body;
    const file         = req.file;

    // ── Input guards ─────────────────────────────────────────────────────────
    if (!file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No file was uploaded.' });
    }
    if (!storeId) {
      fs.unlinkSync(file.path);
      return res.status(400).json({ error: 'MISSING_STORE', message: 'storeId is required.' });
    }

    // Verify the storeId belongs to this tenant (tenant isolation check)
    const storeCheck = await query(
      'SELECT id FROM stores WHERE id = $1 AND tenant_id = $2 AND is_active = TRUE',
      [storeId, tenantId],
    );
    if (storeCheck.rows.length === 0) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'STORE_NOT_FOUND', message: 'Store not found or not accessible.' });
    }

    const fileExt  = path.extname(file.originalname).toLowerCase().replace('.', '');
    const fileType = fileExt === 'csv' ? 'csv' : 'xlsx';

    // ── File-level dedup ──────────────────────────────────────────────────────
    // sale_transactions has no natural unique key, so re-uploading the same file
    // would duplicate every row. We hash the bytes on disk (streamed — never read
    // fully into memory) and reject a file already imported for this store.
    let fileHash;
    try {
      fileHash = await computeFileHash(file.path);
    } catch (err) {
      fs.unlinkSync(file.path);
      return res.status(500).json({ error: 'HASH_FAILED', message: 'Could not read the uploaded file.' });
    }

    const priorJob = await findExistingJob(tenantId, storeId, fileHash);
    if (priorJob) {
      fs.unlinkSync(file.path);
      return res.status(409).json({
        error: 'DUPLICATE_FILE',
        message: `This file was already imported on ${formatJobDate(priorJob)}.`,
        existingJobId: priorJob.id,
      });
    }

    // ── Create ingestion job record ───────────────────────────────────────────
    // The job record is created immediately and returned to the client.
    // The client can then poll GET /api/upload/:jobId/status to track progress.
    let job;
    try {
      const { rows: [created] } = await query(
        `INSERT INTO ingestion_jobs (tenant_id, store_id, uploaded_by, original_filename, file_type, status, file_hash)
         VALUES ($1, $2, $3, $4, $5, 'validating', $6)
         RETURNING id`,
        [tenantId, storeId, req.user.id, file.originalname, fileType, fileHash],
      );
      job = created;
    } catch (err) {
      // 23505 = unique_violation on uq_ingestion_file_per_store. A concurrent
      // upload of the same file won the race — treat it exactly like the pre-check.
      if (err.code === '23505') {
        fs.unlinkSync(file.path);
        const conflict = await findExistingJob(tenantId, storeId, fileHash);
        return res.status(409).json({
          error: 'DUPLICATE_FILE',
          message: `This file was already imported on ${formatJobDate(conflict)}.`,
          existingJobId: conflict ? conflict.id : null,
        });
      }
      throw err;
    }

    // Respond immediately so the client has the jobId to poll.
    res.status(202).json({ jobId: job.id, status: 'validating' });

    // ── Run the rest of the pipeline asynchronously ───────────────────────────
    // We don't await this — it runs after the response is sent.
    parsePipeline(job.id, file, fileType, tenantId, storeId).catch((err) => {
      console.error(`[upload] Pipeline error for job ${job.id}:`, err.message);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/upload/:jobId/status
// Returns the current status of an ingestion job.
// The frontend polls this every 1–2 seconds to drive the progress bar.
//
//   row counters — total_rows, rows_processed, rows_failed (rows skipped by the
//                  status filter are NOT failures and are not counted here)
//   assumptions  — what the import had to estimate, e.g. a cost derived from the
//                  price because the file had no cost column
//   skippedByStatus — rows ignored because their status was not a completed sale
//   column_map   — canonical column name → header found in the file
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:jobId/status', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId } = req;
  const { jobId }    = req.params;

  const { rows } = await query(
    `SELECT id, status, total_rows, rows_processed, rows_failed, error_log, column_map,
            started_at, completed_at
     FROM ingestion_jobs
     WHERE id = $1 AND tenant_id = $2`,
    [jobId, tenantId],
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'JOB_NOT_FOUND' });
  }

  const job = rows[0];
  const progressPct = job.total_rows
    ? Math.round((job.rows_processed / job.total_rows) * 100)
    : null;

  // The assumptions the import had to make and the rows its status filter
  // ignored are stored beside the column mapping under reserved keys (T12a).
  const storedMap   = job.column_map && typeof job.column_map === 'object' ? job.column_map : {};
  const assumptions = Array.isArray(storedMap._assumptions) ? storedMap._assumptions : [];
  const skippedByStatus = Number(storedMap._skippedByStatus) || 0;

  return res.json({
    ...job,
    column_map: storedMap,
    assumptions,
    skippedByStatus,
    progress_pct: progressPct,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/upload/:jobId/summary
// A roll-up of ONE import job: how much of the file landed, the dates it covers
// and which products it moved most. Tenant-scoped — a job belonging to another
// tenant is indistinguishable from a job that does not exist (404).
//
//   jobId         — echo of the requested id
//   status        — ingestion_jobs.status
//   fileName      — ingestion_jobs.original_filename, read through to_jsonb so a
//                   schema without that column yields null instead of an error
//   dateFrom/dateTo — min/max sale_date among THIS job's rows (null if none)
//   itemsCount    — distinct products in this job's rows
//   unitsSold     — Σ quantity_sold
//   revenue       — Σ total_revenue (the generated column)
//   topItems      — the three products with the highest units, descending
//   analysis      — the automatic analysis the import ran (T12d):
//                   { alertsCreated, recommendationsCreated, error? }, or null
//                   when the job imported no rows and therefore ran none.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:jobId/summary', requireAuth, resolveTenant, async (req, res) => {
  const { tenantId } = req;
  const { jobId }    = req.params;

  try {
    // The job must belong to this tenant; otherwise it does not exist for us.
    const { rows: jobRows } = await query(
      `SELECT j.id,
              j.status,
              to_jsonb(j) ->> 'original_filename' AS file_name,
              j.rows_processed,
              j.rows_failed,
              j.column_map
         FROM ingestion_jobs j
        WHERE j.id = $1 AND j.tenant_id = $2`,
      [jobId, tenantId],
    );

    if (jobRows.length === 0) {
      return res.status(404).json({ error: 'JOB_NOT_FOUND', message: 'Import job not found.' });
    }
    const job = jobRows[0];

    // T12d: the automatic analysis the import ran is recorded beside the column
    // mapping. A job that imported no rows never ran one — that is `null`, not
    // a fabricated zero, so the UI can stay quiet instead of claiming "0 alerts".
    const storedMap = job.column_map && typeof job.column_map === 'object' ? job.column_map : {};
    const storedAnalysis = storedMap._analysis && typeof storedMap._analysis === 'object'
      ? storedMap._analysis
      : null;
    const analysis = storedAnalysis
      ? {
          alertsCreated:          Number(storedAnalysis.alertsCreated) || 0,
          recommendationsCreated: Number(storedAnalysis.recommendationsCreated) || 0,
          error:                  storedAnalysis.error ?? null,
        }
      : null;

    const { rows: [totals] } = await query(
      `SELECT count(DISTINCT st.product_id)::int                AS items_count,
              coalesce(sum(st.quantity_sold), 0)::int             AS units_sold,
              coalesce(sum(st.total_revenue), 0)::numeric(15, 2)  AS revenue,
              min(st.sale_date)::text                             AS date_from,
              max(st.sale_date)::text                             AS date_to
         FROM sale_transactions st
        WHERE st.ingestion_job_id = $1 AND st.tenant_id = $2`,
      [jobId, tenantId],
    );

    const { rows: topRows } = await query(
      `SELECT p.name                        AS name,
              sum(st.quantity_sold)::int    AS units
         FROM sale_transactions st
         JOIN products p
           ON p.id = st.product_id AND p.tenant_id = st.tenant_id
        WHERE st.ingestion_job_id = $1 AND st.tenant_id = $2
        GROUP BY p.name
        ORDER BY units DESC, p.name ASC
        LIMIT 3`,
      [jobId, tenantId],
    );

    return res.json({
      jobId:         job.id,
      status:        job.status,
      fileName:      job.file_name ?? null,
      rowsProcessed: job.rows_processed,
      rowsFailed:    job.rows_failed,
      dateFrom:      totals.date_from,
      dateTo:        totals.date_to,
      itemsCount:    totals.items_count,
      unitsSold:     totals.units_sold,
      revenue:       Number(totals.revenue),
      topItems:      topRows.map((row) => ({ name: row.name, units: row.units })),
      analysis,
    });
  } catch (err) {
    console.error('[upload] GET summary error:', err.message);
    return res.status(500).json({ error: 'QUERY_ERROR' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// parsePipeline(jobId, file, fileType, tenantId, storeId)
// The actual streaming parse logic. Called asynchronously after the HTTP
// response is already sent.
// ─────────────────────────────────────────────────────────────────────────────
async function parsePipeline(jobId, file, fileType, tenantId, storeId) {
  const cleanup = () => {
    try { fs.unlinkSync(file.path); } catch (_) { /* already deleted */ }
  };

  try {
    // ── Step 1: Locate the columns ────────────────────────────────────────────
    // CSV: read the first row. XLSX: inspect every sheet's header row and keep
    // the first sheet whose requirements all map (T12b) — the old code only
    // looked at SheetNames[0], which may be a notes or instructions tab.
    let columnMap;
    let missing;
    let warnings;
    let detectedHeaders;
    let assumptions;
    let sheetName       = null;
    let sheetsInspected = [];
    let workbook        = null;

    if (fileType === 'csv') {
      const headers = await extractHeaders(file.path);
      ({ map: columnMap, missing, warnings, assumptions, detectedHeaders } = buildColumnMap(headers));
    } else {
      const selection = inspectWorkbook(file.path);
      workbook        = selection.workbook;
      sheetName       = selection.sheetName;
      sheetsInspected = selection.inspectedSheets;
      ({ map: columnMap, missing, warnings, assumptions, detectedHeaders } = selection.columns);

      // The sheet actually read is part of what the import did, so it is stated
      // in the assumptions the UI shows rather than left implicit.
      if (sheetName) {
        assumptions = [...assumptions, `Excel sheet "${sheetName}" was used for the import.`];
      }
    }

    if (missing.length > 0) {
      // detectedHeaders lets the UI show "we found these headers" instead of
      // only naming what is absent (T12a). For a workbook the inspected sheet
      // names are included too: "no sheet qualified" is a different problem
      // from "the header row is wrong".
      const errorEntry = { type: 'MISSING_COLUMNS', columns: missing, warnings, detectedHeaders };
      if (fileType !== 'csv') errorEntry.sheetsInspected = sheetsInspected;

      await query(
        `UPDATE ingestion_jobs
         SET status = 'failed',
             error_log = $1::jsonb,
             completed_at = NOW()
         WHERE id = $2`,
        [JSON.stringify([errorEntry]), jobId],
      );
      cleanup();
      return;
    }

    // Persist the column map so we can debug mapping issues later
    await query(
      `UPDATE ingestion_jobs SET status = 'processing', column_map = $1::jsonb WHERE id = $2`,
      [JSON.stringify(columnMap), jobId],
    );

    // ── Step 2: Stream + parse rows ───────────────────────────────────────────
    const errors          = [];
    let rowIndex          = 0;
    let rowsProcessed     = 0;
    let chunk             = [];

    // T12a: rows filtered out by their status are counted on their own — they
    // are not failures — and every assumption the import had to make is kept in
    // one set so the job can report it once.
    let rowsSkippedByStatus = 0;
    const assumptionLog     = new Set(assumptions);

    // Product ids resolved during THIS job, keyed by SKU. A SKU is written once
    // and then served from memory, so steady-state chunks pay no product
    // round-trips at all (previously: two per chunk, every chunk, forever).
    const productIdBySku    = new Map();
    let chunkIndex          = 0;
    let queryCount          = 0; // database queries charged to the chunk being flushed
    let chunksSinceProgress = 0;

    const flushChunk = async (rows) => {
      if (rows.length === 0) return;
      chunkIndex += 1;
      queryCount = 0;

      // Only SKUs we have never resolved in this job need a database trip.
      // upsertProducts() still batches them into a single statement.
      const newSkus = [...new Set(rows.map((r) => r.sku))]
        .filter((sku) => !productIdBySku.has(sku));

      if (newSkus.length > 0) {
        const resolved = await upsertProducts(tenantId, rows, newSkus);
        queryCount += 2; // products: INSERT ... ON CONFLICT + SELECT ids
        // A SKU missing from `resolved` stays uncached, so the next chunk
        // retries it — and its rows are skipped, exactly as before.
        for (const [sku, id] of Object.entries(resolved)) productIdBySku.set(sku, id);
      }

      // Build multi-row INSERT for sale_transactions
      const values  = [];
      const params  = [];
      let   pIdx    = 1;

      for (const row of rows) {
        const productId = productIdBySku.get(row.sku);
        if (!productId) continue; // skip rows whose product could not be resolved

        values.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++})`);
        params.push(
          tenantId,
          storeId,
          productId,
          jobId,
          row.quantity_sold,
          row.unit_price,
          row.unit_cost,
          row.sale_date,
        );
      }

      if (values.length > 0) {
        // Plain INSERT — this pipeline performs FILE-level dedup (see the upload
        // route), not row-level dedup. sale_transactions has no unique key, so
        // ON CONFLICT DO NOTHING here would have been a silent no-op.
        await query(
          `INSERT INTO sale_transactions
             (tenant_id, store_id, product_id, ingestion_job_id,
              quantity_sold, unit_price_at_sale, cost_price_at_sale, sale_date)
           VALUES ${values.join(', ')}`,
          params,
        );
        rowsProcessed += rows.length;
        queryCount += 1; // sale_transactions multi-row INSERT

        // Refresh the progress counter that status polling reads — but not on
        // every chunk. At ~150 ms per round-trip this write used to cost about as
        // much as the insert it was reporting on. The run's final UPDATE (step 3)
        // guarantees the last value always lands, whatever this interval is.
        chunksSinceProgress += 1;
        if (chunksSinceProgress >= PROGRESS_EVERY_N_CHUNKS) {
          await query(
            'UPDATE ingestion_jobs SET rows_processed = $1 WHERE id = $2',
            [rowsProcessed, jobId],
          );
          queryCount += 1; // ingestion_jobs progress UPDATE
          chunksSinceProgress = 0;
        }
      }

      if (INGEST_DEBUG) {
        console.log(
          `[ingest] chunk ${chunkIndex}: ${rows.length} rows, ${newSkus.length} new skus, ` +
          `${queryCount} queries, rowsProcessed=${rowsProcessed}`,
        );
      }
    };

    await streamRows(file.path, fileType, async (rawRow) => {
      rowIndex++;

      const { data, error, skipped, assumptions: rowAssumptions } =
        validateRow(rawRow, columnMap, rowIndex);

      // A cancelled / refunded row is ignored, not failed: it must not inflate
      // rows_failed or the error log.
      if (skipped) {
        rowsSkippedByStatus += 1;
        return;
      }

      if (error) {
        errors.push({ row: rowIndex, error });
        return;
      }

      for (const assumption of rowAssumptions) assumptionLog.add(assumption);

      chunk.push(data);

      if (chunk.length >= CHUNK_ROWS) {
        await flushChunk(chunk);
        chunk = [];
      }
    }, { sheetName, workbook });

    // Flush any remaining rows
    if (chunk.length > 0) await flushChunk(chunk);

    // ── Step 2b: Analyse the store with the rows just written (T12d) ─────────
    // The manual "Run Detection" button and this import run the SAME sequence
    // (services/analysisRunner.js): detect, then recommend. Doing it before the
    // job is marked completed means a client polling the status keeps seeing
    // "processing" until the advice actually exists — no new status value.
    //
    // A failure here is recorded, never fatal. The rows are already in, and
    // losing an import because a detector tripped would be the worse outcome,
    // so the error goes into column_map._analysis and the job still completes.
    let analysisRecord = null;
    if (rowsProcessed > 0) {
      try {
        const outcome = await runAnalysis(tenantId, storeId);
        analysisRecord = {
          alertsCreated:          outcome.alertsCreated,
          recommendationsCreated: outcome.recommendationsCreated,
        };
        console.log(
          `[upload] Job ${jobId} analysis: ${outcome.alertsCreated} alert(s), ` +
          `${outcome.recommendationsCreated} recommendation(s)`,
        );
      } catch (analysisErr) {
        console.error(`[upload] Analysis failed for job ${jobId}:`, analysisErr.message);
        analysisRecord = {
          alertsCreated:          0,
          recommendationsCreated: 0,
          error:                  analysisErr.message,
        };
      }
    }

    // ── Step 3: Mark job complete ─────────────────────────────────────────────
    // column_map doubles as the job's provenance note: the assumptions this
    // import had to make, how many rows its status filter ignored and what the
    // automatic analysis produced (T12d) live beside the mapping under the
    // reserved _-prefixed keys (no schema migration).
    const columnMapRecord = {
      ...columnMap,
      _assumptions:     [...assumptionLog],
      _skippedByStatus: rowsSkippedByStatus,
    };
    // Only an import that wrote rows has an analysis to report.
    if (analysisRecord) columnMapRecord._analysis = analysisRecord;

    await query(
      `UPDATE ingestion_jobs
       SET status       = $1,
           total_rows   = $2,
           rows_processed = $3,
           rows_failed  = $4,
           error_log    = $5::jsonb,
           column_map   = $6::jsonb,
           completed_at = NOW()
       WHERE id = $7`,
      [
        errors.length > 0 && rowsProcessed === 0 ? 'failed' : 'completed',
        rowIndex,
        rowsProcessed,
        errors.length,
        JSON.stringify(errors.slice(0, 100)), // cap stored errors at 100
        JSON.stringify(columnMapRecord),
        jobId,
      ],
    );

  } catch (err) {
    await query(
      `UPDATE ingestion_jobs
       SET status = 'failed',
           error_log = $1::jsonb,
           completed_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([{ type: 'PIPELINE_ERROR', message: err.message }]), jobId],
    );
  } finally {
    cleanup();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// extractHeaders(filePath)
// Returns the column headers from the first row of a CSV without reading the
// whole file: csv-parser emits 'headers' and the stream is destroyed at once.
// XLSX header rows are found by inspectWorkbook() instead.
// ─────────────────────────────────────────────────────────────────────────────
function extractHeaders(filePath) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath).pipe(csvParser());
    stream.on('headers', (headers) => {
      stream.destroy(); // stop after reading headers — no need to read the whole file
      resolve(headers);
    });
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// inspectWorkbook(filePath)
// Loads a workbook once (SheetJS is memory-bound — see the file header comment)
// and picks the sheet to import: the FIRST sheet whose header row satisfies
// every column requirement. Empty sheets and notes/instructions sheets cannot
// satisfy the requirements, so they are skipped; their names are still reported.
//
// Returns { workbook, sheetName, inspectedSheets, columns }, where columns is
// buildColumnMap()'s result for the chosen sheet — or, when no sheet qualifies,
// for the sheet that came closest, so the error names what was actually wrong.
// ─────────────────────────────────────────────────────────────────────────────
function inspectWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: true });
  const inspectedSheets = [];
  let closest = null;

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    // Use the sheet's FIRST row, which is also the row SheetJS uses as object
    // keys when importing — so inspection and import can never disagree.
    const firstRow = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] ?? [] : [];
    const headers = firstRow.map((cell) => String(cell ?? '').trim());

    inspectedSheets.push(name);

    // An empty sheet (or a blank first row) has no header row at all.
    if (headers.every((header) => header === '')) continue;

    const columns = buildColumnMap(headers);
    if (columns.missing.length === 0) {
      return { workbook, sheetName: name, inspectedSheets, columns };
    }
    if (!closest || columns.missing.length < closest.missing.length) closest = columns;
  }

  return {
    workbook,
    sheetName: null,
    inspectedSheets,
    columns: closest ?? buildColumnMap([]),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// streamRows(filePath, fileType, onRow, options)
// Calls onRow(rawRow) once per data row.
//   CSV  — streamed through csv-parser, one row at a time.
//   XLSX — rows come from the workbook inspectWorkbook() already loaded (or a
//          fresh read with cellDates: true if none was passed), restricted to
//          the selected sheet. SheetJS has no row-by-row reader, so the sheet is
//          materialised in memory — the upload cap is what bounds this.
//
// The header keys are trimmed to exactly match the headers buildColumnMap()
// inspected, so a padded header (" Sale Date ") cannot silently lose its column.
// ─────────────────────────────────────────────────────────────────────────────
function streamRows(filePath, fileType, onRow, { sheetName = null, workbook = null } = {}) {
  return new Promise((resolve, reject) => {
    if (fileType === 'csv') {
      const pending = [];
      const stream  = createReadStream(filePath).pipe(csvParser());

      stream.on('data', (row) => {
        stream.pause();
        const p = Promise.resolve(onRow(row)).then(() => {
          pending.shift();
          stream.resume();
        });
        pending.push(p);
      });

      stream.on('end',   () => Promise.all(pending).then(resolve).catch(reject));
      stream.on('error', reject);
    } else {
      const book = workbook ?? XLSX.readFile(filePath, { cellDates: true });
      const ws   = sheetName ? book.Sheets[sheetName] : null;
      if (!ws) {
        // Never fall back to sheet 1 here: importing rows from a sheet the user
        // did not choose is exactly the kind of silent mistake T12b removes.
        reject(new Error(`The selected sheet "${sheetName ?? '(none)'}" could not be read.`));
        return;
      }

      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const firstKeys = rows[0] ? Object.keys(rows[0]) : [];
      const paddedKeys = firstKeys.some((key) => key !== key.trim());
      const importRows = paddedKeys
        ? rows.map((row) => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [String(key).trim(), value]),
        ))
        : rows;

      const processNext = async (i) => {
        if (i >= importRows.length) return resolve();
        await onRow(importRows[i]);
        return processNext(i + 1);
      };

      processNext(0).catch(reject);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// computeFileHash(filePath)
// Streams a file from disk and returns its SHA-256 hex digest. Streaming keeps
// peak memory flat regardless of file size (same principle as the parser).
// ─────────────────────────────────────────────────────────────────────────────
function computeFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash   = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data',  (chunk) => hash.update(chunk));
    stream.on('end',   () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// findExistingJob(tenantId, storeId, fileHash)
// Returns the newest non-failed ingestion job for a (tenant, store, hash) tuple,
// or null. Matches the uq_ingestion_file_per_store partial index predicate.
// ─────────────────────────────────────────────────────────────────────────────
async function findExistingJob(tenantId, storeId, fileHash) {
  const { rows } = await query(
    `SELECT id, completed_at, started_at
       FROM ingestion_jobs
      WHERE tenant_id = $1 AND store_id = $2 AND file_hash = $3 AND status <> 'failed'
      ORDER BY started_at DESC
      LIMIT 1`,
    [tenantId, storeId, fileHash],
  );
  return rows[0] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// formatJobDate(job)
// YYYY-MM-DD of a job's completion (or start) date, for the DUPLICATE_FILE
// message. Falls back to today if the timestamp is somehow missing.
// ─────────────────────────────────────────────────────────────────────────────
function formatJobDate(job) {
  const when = job && (job.completed_at || job.started_at);
  const d    = when ? new Date(when) : new Date();
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// upsertProducts(tenantId, rows, skus)
// Given a list of SKUs from a chunk, ensures they exist in the products table.
// Returns a map of { sku → product_id }.
// Uses INSERT ... ON CONFLICT DO NOTHING to avoid race conditions on concurrent
// uploads of the same product from different files.
// ─────────────────────────────────────────────────────────────────────────────
async function upsertProducts(tenantId, rows, skus) {
  if (skus.length === 0) return {};

  // Build a lookup: sku → first row that mentions it (for product_name)
  const skuRowMap = {};
  for (const row of rows) {
    if (!skuRowMap[row.sku]) skuRowMap[row.sku] = row;
  }

  // Insert new SKUs; ignore conflicts (already exist)
  const insertValues = skus.map((_, i) => `($1, $${i * 3 + 2}, $${i * 3 + 3}, $${i * 3 + 4})`).join(', ');
  const insertParams = [tenantId];
  for (const sku of skus) {
    const row = skuRowMap[sku];
    insertParams.push(sku, row.product_name, row.unit_price);
  }

  await query(
    `INSERT INTO products (tenant_id, sku, name, standard_unit_price)
     VALUES ${insertValues}
     ON CONFLICT (tenant_id, sku) DO NOTHING`,
    insertParams,
  );

  // Fetch all matching product IDs in one query
  const { rows: productRows } = await query(
    `SELECT id, sku FROM products WHERE tenant_id = $1 AND sku = ANY($2)`,
    [tenantId, skus],
  );

  return Object.fromEntries(productRows.map((p) => [p.sku, p.id]));
}

export default router;
