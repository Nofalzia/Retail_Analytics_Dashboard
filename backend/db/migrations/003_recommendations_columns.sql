-- =============================================================================
-- Migration 003 — recommendations engine columns
-- -----------------------------------------------------------------------------
-- Adds the Phase 4 rule-based recommendation-engine columns to the EXISTING
-- recommendations table (already created by schema.sql), plus the
-- uq_recommendation_per_alert unique constraint so each source alert can have
-- at most one recommendation.
--
-- Safe to run any number of times:
--   * ADD COLUMN IF NOT EXISTS is idempotent.
--   * Postgres has no "ADD CONSTRAINT IF NOT EXISTS", so the unique constraint
--     is guarded with a pg_constraint lookup (same pattern as migration 002).
--
-- The column list mirrors the definition in backend/db/schema.sql:
--   product_id, rec_type, suggested_quantity, revenue_at_risk,
--   UNIQUE (alert_id) AS uq_recommendation_per_alert
-- =============================================================================

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS product_id UUID NULL REFERENCES products(id) ON DELETE SET NULL;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS rec_type VARCHAR(40) NOT NULL DEFAULT 'reorder';

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS suggested_quantity INTEGER NULL;

ALTER TABLE recommendations
  ADD COLUMN IF NOT EXISTS revenue_at_risk NUMERIC(15, 2) NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'uq_recommendation_per_alert'
      AND connamespace = 'public'::regnamespace
  ) THEN
    ALTER TABLE recommendations
      ADD CONSTRAINT uq_recommendation_per_alert UNIQUE (alert_id);
  END IF;
END $$;
