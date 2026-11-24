-- Keep the ingestion status constraint compatible with deployments running
-- older upload-route versions that use validating or processing.

ALTER TABLE ingestion_jobs
  DROP CONSTRAINT IF EXISTS ingestion_jobs_status_check;

UPDATE ingestion_jobs
   SET status = CASE status
     WHEN 'pending' THEN 'queued'
     WHEN 'validating' THEN 'parsing'
     WHEN 'processing' THEN 'importing'
     ELSE status
   END
 WHERE status IN ('pending', 'validating', 'processing');

ALTER TABLE ingestion_jobs
  ADD CONSTRAINT ingestion_jobs_status_check
  CHECK (status IN (
    'queued', 'parsing', 'importing', 'completed', 'failed',
    'pending', 'validating', 'processing'
  ));
