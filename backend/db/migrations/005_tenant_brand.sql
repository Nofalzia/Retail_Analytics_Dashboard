-- =============================================================================
-- Migration 005 — tenant brand colour
-- -----------------------------------------------------------------------------
-- Adds tenants.brand_accent: an optional hex colour (e.g. '#8A5A2B') a tenant may
-- use for its own branding in the dashboard sidebar. NULL means "no brand colour
-- configured", and the UI falls back to the shared palette tokens.
--
-- Safe to run any number of times:
--   * ADD COLUMN IF NOT EXISTS is idempotent.
--   * The UPDATE is guarded by `brand_accent IS NULL`, so it never overwrites a
--     colour an operator has set since.
--
-- Mirrors the definition in backend/db/schema.sql:
--   tenants.brand_accent VARCHAR(9) NULL
-- =============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS brand_accent VARCHAR(9) NULL;

-- Give the second demo tenant a warm brown accent that sits alongside the shared
-- palette. The slug is configuration data written by the seed script, not schema.
UPDATE tenants
  SET brand_accent = '#8A5A2B'
  WHERE slug = 'london-bakers-i10'
    AND brand_accent IS NULL;
