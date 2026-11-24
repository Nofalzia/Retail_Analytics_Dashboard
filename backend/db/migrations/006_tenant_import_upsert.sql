-- Tenant-scoped re-import support and an idempotent empty demo tenant.
-- Transaction source keys are assigned by the streaming importer; legacy rows
-- with an unambiguous product/date identity are backfilled. Ambiguous legacy
-- duplicates remain untouched and unkeyed.

ALTER TABLE ingestion_jobs
  ADD COLUMN IF NOT EXISTS rows_inserted INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rows_updated INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rows_skipped INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rows_rejected INTEGER NOT NULL DEFAULT 0;

ALTER TABLE ingestion_jobs
  ALTER COLUMN status SET DEFAULT 'queued';

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

ALTER TABLE sale_transactions
  ADD COLUMN IF NOT EXISTS source_transaction_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS source_record_key VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_row_key VARCHAR(64);

ALTER TABLE inventory_logs
  ADD COLUMN IF NOT EXISTS source_record_key VARCHAR(64),
  ADD COLUMN IF NOT EXISTS source_row_key VARCHAR(64);

DROP INDEX IF EXISTS uq_ingestion_file_per_store;

WITH unambiguous_sales AS (
  SELECT tenant_id, store_id, product_id, sale_date
    FROM sale_transactions
   WHERE source_record_key IS NULL
   GROUP BY tenant_id, store_id, product_id, sale_date
  HAVING count(*) = 1
)
UPDATE sale_transactions AS sale
   SET source_record_key = md5(sale.product_id::text || '|' || sale.sale_date::text)
  FROM unambiguous_sales AS legacy
 WHERE sale.tenant_id = legacy.tenant_id
   AND sale.store_id = legacy.store_id
   AND sale.product_id = legacy.product_id
   AND sale.sale_date = legacy.sale_date
   AND sale.source_record_key IS NULL;

WITH unambiguous_inventory AS (
  SELECT tenant_id, store_id, product_id, log_date
    FROM inventory_logs
   WHERE source_record_key IS NULL
   GROUP BY tenant_id, store_id, product_id, log_date
  HAVING count(*) = 1
)
UPDATE inventory_logs AS inventory
   SET source_record_key = md5(inventory.product_id::text || '|' || inventory.log_date::text)
  FROM unambiguous_inventory AS legacy
 WHERE inventory.tenant_id = legacy.tenant_id
   AND inventory.store_id = legacy.store_id
   AND inventory.product_id = legacy.product_id
   AND inventory.log_date = legacy.log_date
   AND inventory.source_record_key IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_tx_source_record
  ON sale_transactions(tenant_id, store_id, source_record_key)
  WHERE source_record_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sale_tx_source_row
  ON sale_transactions(tenant_id, store_id, source_row_key)
  WHERE source_row_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_source_record
  ON inventory_logs(tenant_id, store_id, source_record_key)
  WHERE source_record_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_source_row
  ON inventory_logs(tenant_id, store_id, source_row_key)
  WHERE source_row_key IS NOT NULL;

INSERT INTO tenants (name, slug, currency_code, locale)
VALUES ('New Tenant (No Data)', 'demo-onboarding', 'PKR', 'en-PK')
ON CONFLICT (slug) DO NOTHING;

INSERT INTO stores (tenant_id, name)
SELECT t.id, 'Main Branch'
FROM tenants t
WHERE t.slug = 'demo-onboarding'
  AND NOT EXISTS (
    SELECT 1 FROM stores s
    WHERE s.tenant_id = t.id AND s.name = 'Main Branch'
  );
