-- =============================================================================
-- Migration 004 — file-level dedup for ingestion_jobs
-- -----------------------------------------------------------------------------
-- Adds ingestion_jobs.file_hash (SHA-256 of the uploaded file) and a PARTIAL
-- unique index so the SAME file cannot be imported twice for one store.
--
-- sale_transactions has no natural unique key, so `ON CONFLICT DO NOTHING`
-- could never dedupe a re-upload. We dedupe at the file level instead: the
-- upload route hashes the saved file and stores it here.
--
-- The index is partial because:
--   * rows with file_hash IS NULL (e.g. the seed job) are never indexed, and
--   * failed jobs are excluded, so a file that failed to import can be retried.
--
-- Safe to run any number of times:
--   * ADD COLUMN IF NOT EXISTS is idempotent.
--   * CREATE UNIQUE INDEX IF NOT EXISTS is idempotent.
--
-- Mirrors the definition in backend/db/schema.sql:
--   uq_ingestion_file_per_store ON ingestion_jobs (tenant_id, store_id, file_hash)
--     WHERE file_hash IS NOT NULL AND status <> 'failed'
-- =============================================================================

ALTER TABLE ingestion_jobs
  ADD COLUMN IF NOT EXISTS file_hash VARCHAR(64) NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_file_per_store
  ON ingestion_jobs (tenant_id, store_id, file_hash)
  WHERE file_hash IS NOT NULL AND status <> 'failed';
