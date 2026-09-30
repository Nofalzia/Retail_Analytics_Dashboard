-- =============================================================================
-- Migration 002 — anomaly_alerts dedup constraint
-- -----------------------------------------------------------------------------
-- Adds uq_anomaly_per_product_per_day to EXISTING databases that were created
-- before the constraint was part of schema.sql.
--
-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so we guard with a
-- pg_constraint lookup — safe to run any number of times.
--
-- The column list mirrors the definition in backend/db/schema.sql and the old
-- backend/scripts/runMigration.js:
--   UNIQUE (tenant_id, store_id, product_id, alert_type, alert_date)
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_anomaly_per_product_per_day'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE anomaly_alerts
      ADD CONSTRAINT uq_anomaly_per_product_per_day
        UNIQUE (tenant_id, store_id, product_id, alert_type, alert_date);
  END IF;
END $$;