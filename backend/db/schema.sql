-- =============================================================================
-- Retail Analytics Dashboard — PostgreSQL Schema
-- Phase 2: Backend Foundation
-- =============================================================================
-- Design principles enforced throughout:
--   1. Multi-tenancy via tenant_id on every business-data table.
--      Every query that touches these tables MUST filter by tenant_id first.
--      The application layer enforces this; the schema makes it impossible to
--      forget by surfacing the column prominently on every table.
--
--   2. Generic, business-agnostic naming.
--      No "bakery", "grocery", or "apparel" anywhere. SaaS sells to all of them.
--      A "product" is a product. A "category" is a category.
--
--   3. Immutable transaction log.
--      sale_transactions rows are never UPDATEd or DELETEd after insert.
--      To correct an error, ingest a new job with the corrected file.
--      This keeps the audit trail clean and Phase 5 research validation honest.
--
--   4. Separate inventory log from transactions.
--      Sales tell you what moved. Inventory logs tell you what was on hand.
--      These are separate data sources (different spreadsheets in practice).
--
--   5. Explicit currency column on every monetary field.
--      All monetary values are stored as NUMERIC(15,2) — no floats.
--      Currency code (ISO 4217) defaults to 'PKR'. Multi-currency is
--      supported structurally even though the UI currently only shows PKR.
--
--   6. Phase 3 intelligence tables are defined here now.
--      anomaly_alerts and recommendations are written by the intelligence layer
--      in Phase 3 but their schema is locked today. This prevents a
--      Phase 2→3 migration that would break the running API.
-- =============================================================================

-- Enable the uuid extension for primary keys
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- UTILITY: updated_at auto-maintenance trigger function
-- Attach this to any table that has an updated_at column.
-- =============================================================================
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- =============================================================================
-- LAYER 1: TENANCY & IDENTITY
-- These tables are the SaaS shell. Every downstream table references tenants.
-- =============================================================================

-- tenants
-- One row per business that subscribes to the platform.
-- A "tenant" is the unit of data isolation — no tenant ever sees another's data.
CREATE TABLE tenants (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(255)  NOT NULL,                  -- "Al-Rehman Mart"
  slug          VARCHAR(100)  NOT NULL UNIQUE,            -- "al-rehman-mart" (URL-safe)
  currency_code CHAR(3)       NOT NULL DEFAULT 'PKR',     -- ISO 4217
  locale        VARCHAR(20)   NOT NULL DEFAULT 'en-PK',   -- for number formatting
  is_active     BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- users
-- Platform users, scoped to a tenant.
-- System Administrators (role = 'system_admin') can act on any tenant — the
-- application layer handles this by skipping the tenant_id filter for them.
-- All other roles are strictly scoped: tenant_id is always required.
--
-- store_id is nullable because:
--   - Owners and Managers with cross-store access don't belong to one store.
--   - Data Entry Clerks are typically locked to a single store (store_id set).
CREATE TABLE users (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email           VARCHAR(320)  NOT NULL,
  password_hash   VARCHAR(255)  NOT NULL,         -- bcrypt hash, never plaintext
  role            VARCHAR(50)   NOT NULL           -- 'owner' | 'manager' | 'data_entry_clerk' | 'system_admin'
                  CHECK (role IN ('owner', 'manager', 'data_entry_clerk', 'system_admin')),
  store_id        UUID          NULL,              -- nullable: resolved AFTER stores table is created (FK added below)
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ   NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, email)                        -- email is unique per tenant, not globally
);

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_email     ON users(email);


-- =============================================================================
-- LAYER 2: BUSINESS STRUCTURE
-- Stores → Categories → Products
-- These are the master-data tables. Transactional data references them.
-- =============================================================================

-- stores
-- A tenant may operate more than one physical location.
-- The dashboard can aggregate across all stores or filter by one.
CREATE TABLE stores (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255)  NOT NULL,              -- "Main Branch", "DHA Outlet"
  location    VARCHAR(500)  NULL,                  -- free-text address
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_stores_tenant_id ON stores(tenant_id);

-- Now that stores exists, add the deferred FK from users.store_id
ALTER TABLE users
  ADD CONSTRAINT fk_users_store_id
  FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE SET NULL;


-- categories
-- Product groupings, defined by each tenant. No global category taxonomy —
-- a kiryana store and an electronics shop will have completely different needs.
CREATE TABLE categories (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        VARCHAR(255)  NOT NULL,              -- "Beverages", "Electronics"
  description TEXT          NULL,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, name)
);

CREATE TRIGGER trg_categories_updated_at
  BEFORE UPDATE ON categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_categories_tenant_id ON categories(tenant_id);


-- products
-- The product catalogue. One product can be sold across all of a tenant's stores.
-- Pricing here is the "standard" price — the actual price at the time of each
-- sale is captured in sale_transactions.unit_price_at_sale.
CREATE TABLE products (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  category_id         UUID            NULL REFERENCES categories(id) ON DELETE SET NULL,
  name                VARCHAR(255)    NOT NULL,
  sku                 VARCHAR(100)    NOT NULL,      -- stock-keeping unit code
  standard_unit_cost  NUMERIC(15, 2)  NOT NULL DEFAULT 0,  -- what you pay the supplier
  standard_unit_price NUMERIC(15, 2)  NOT NULL DEFAULT 0,  -- what you charge the customer
  reorder_threshold   INTEGER         NOT NULL DEFAULT 0,   -- trigger stockout alert below this
  is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),

  UNIQUE (tenant_id, sku)                           -- SKU is unique per tenant
);

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_products_tenant_id   ON products(tenant_id);
CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_products_sku         ON products(tenant_id, sku);


-- =============================================================================
-- LAYER 3: DATA INGESTION PIPELINE
-- Tracks every file upload so we can show status in the UI and correlate
-- rows back to their source job for debugging bad data.
-- =============================================================================

-- ingestion_jobs
-- Every CSV or Excel file upload creates one row here.
-- The streaming parser updates this row as it processes chunks.
-- The UI polls GET /api/ingestion/:jobId/status to show a live progress bar.
CREATE TABLE ingestion_jobs (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        UUID          NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  uploaded_by     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_filename VARCHAR(500) NOT NULL,
  file_type       VARCHAR(10)   NOT NULL              -- 'csv' | 'xlsx'
                  CHECK (file_type IN ('csv', 'xlsx')),
  status          VARCHAR(30)   NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'validating', 'processing', 'completed', 'failed')),
  total_rows      INTEGER       NULL,                 -- populated after initial scan
  rows_processed  INTEGER       NOT NULL DEFAULT 0,
  rows_failed     INTEGER       NOT NULL DEFAULT 0,
  -- JSON array of validation/parse error messages, e.g.:
  -- [{"row": 14, "col": "unit_price", "error": "expected number, got 'N/A'"}]
  error_log       JSONB         NOT NULL DEFAULT '[]',
  -- Column mapping: how the file's columns map to our standard schema
  -- e.g. {"date": "Sale Date", "sku": "Item Code", "quantity_sold": "Qty"}
  column_map      JSONB         NULL,
  started_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ   NULL
);

CREATE INDEX idx_ingestion_jobs_tenant_id ON ingestion_jobs(tenant_id);
CREATE INDEX idx_ingestion_jobs_status    ON ingestion_jobs(status);
CREATE INDEX idx_ingestion_jobs_store_id  ON ingestion_jobs(tenant_id, store_id);


-- =============================================================================
-- LAYER 4: TRANSACTIONAL DATA
-- The main fact tables. These power every chart and KPI on the dashboard.
-- =============================================================================

-- sale_transactions
-- One row per line item sold. This is the financial heartbeat of the dashboard.
--
-- Immutability rule: rows are INSERTED, never UPDATE/DELETE.
-- An ingestion_job_id FK on every row lets us trace each sale to its source file.
--
-- Storing unit_price_at_sale and cost_price_at_sale separately from the
-- products table captures real historical margin — prices change over time.
CREATE TABLE sale_transactions (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id            UUID            NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id          UUID            NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  ingestion_job_id    UUID            NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  quantity_sold       INTEGER         NOT NULL CHECK (quantity_sold > 0),
  unit_price_at_sale  NUMERIC(15, 2)  NOT NULL CHECK (unit_price_at_sale >= 0),
  cost_price_at_sale  NUMERIC(15, 2)  NOT NULL CHECK (cost_price_at_sale >= 0),
  -- Derived: stored for query performance, always = quantity_sold * unit_price_at_sale
  total_revenue       NUMERIC(15, 2)  GENERATED ALWAYS AS (quantity_sold * unit_price_at_sale) STORED,
  -- Derived: stored for query performance, always = quantity_sold * cost_price_at_sale
  total_cost          NUMERIC(15, 2)  GENERATED ALWAYS AS (quantity_sold * cost_price_at_sale) STORED,
  sale_date           DATE            NOT NULL,      -- the date the sale occurred (not ingest date)
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
  -- No updated_at — this table is append-only
);

-- Composite index: the single most important index in the whole schema.
-- Almost every dashboard query filters by (tenant_id, store_id, sale_date).
CREATE INDEX idx_sale_tx_tenant_store_date ON sale_transactions(tenant_id, store_id, sale_date DESC);
CREATE INDEX idx_sale_tx_product_date      ON sale_transactions(tenant_id, product_id, sale_date DESC);
CREATE INDEX idx_sale_tx_ingestion_job     ON sale_transactions(ingestion_job_id);


-- inventory_logs
-- Point-in-time inventory snapshots. Typically uploaded separately from sales.
-- The Phase 3 stockout prediction algorithm uses quantity_on_hand here
-- combined with the daily sales velocity from sale_transactions to project
-- "days of inventory left."
--
-- One row per product per store per date, per ingestion job.
CREATE TABLE inventory_logs (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id          UUID          NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id        UUID          NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  ingestion_job_id  UUID          NOT NULL REFERENCES ingestion_jobs(id) ON DELETE CASCADE,
  quantity_on_hand  INTEGER       NOT NULL CHECK (quantity_on_hand >= 0),
  log_date          DATE          NOT NULL,          -- the date this stock count was recorded
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_inventory_tenant_store_date ON inventory_logs(tenant_id, store_id, log_date DESC);
CREATE INDEX idx_inventory_product_date      ON inventory_logs(tenant_id, product_id, log_date DESC);


-- =============================================================================
-- LAYER 5: INTELLIGENCE LAYER
-- Written by Phase 3 algorithms. Schema is locked now so the API contract
-- doesn't need a migration when Phase 3 starts writing to these tables.
-- =============================================================================

-- anomaly_alerts
-- Generated by the Phase 3 rolling z-score / threshold detection engine.
-- The UI AlertCard in StoreManagerDashboard.jsx reads from this table.
-- Each alert is tied to a specific product+date where the anomaly occurred.
--
-- alert_type values (extensible, don't hardcode in the app):
--   'sales_spike'     — unusually high sales volume vs. rolling average
--   'sales_drop'      — unusually low sales volume vs. rolling average
--   'low_stock'       — inventory below reorder_threshold
--   'stockout_risk'   — projected to hit 0 within N days
--   'margin_erosion'  — gross margin dropped below defined threshold
CREATE TABLE anomaly_alerts (
  id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID            NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        UUID            NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  product_id      UUID            NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  alert_type      VARCHAR(50)     NOT NULL,
  severity        VARCHAR(20)     NOT NULL DEFAULT 'warning'
                  CHECK (severity IN ('info', 'warning', 'critical')),
  title           VARCHAR(255)    NOT NULL,           -- "Unusual Sales Drop — Product X"
  description     TEXT            NOT NULL,           -- human-readable, shown in UI
  -- The raw numbers behind the alert — "show its work" per the product vision.
  metric_value    NUMERIC(15, 4)  NOT NULL,           -- the observed value
  threshold_value NUMERIC(15, 4)  NOT NULL,           -- the value that triggered the alert
  z_score         NUMERIC(8, 4)   NULL,               -- statistical z-score if applicable
  alert_date      DATE            NOT NULL,            -- the date the anomaly occurred
  -- Lifecycle: null = unactioned, timestamped = actioned by a user
  acknowledged_at TIMESTAMPTZ     NULL,
  acknowledged_by UUID            NULL REFERENCES users(id) ON DELETE SET NULL,
  dismissed_at    TIMESTAMPTZ     NULL,
  dismissed_by    UUID            NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_anomaly_tenant_store_date   ON anomaly_alerts(tenant_id, store_id, alert_date DESC);
CREATE INDEX idx_anomaly_tenant_unactioned   ON anomaly_alerts(tenant_id, acknowledged_at, dismissed_at)
  WHERE acknowledged_at IS NULL AND dismissed_at IS NULL;


-- recommendations
-- Generated by the Phase 4 rule-based recommendation engine.
-- Each recommendation is optionally linked to an anomaly_alert that triggered it.
-- The RecommendationsPanel.jsx UI reads from this table.
CREATE TABLE recommendations (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  store_id        UUID          NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  alert_id        UUID          NULL REFERENCES anomaly_alerts(id) ON DELETE SET NULL,
  priority        INTEGER       NOT NULL DEFAULT 5    -- 1 = highest urgency, 10 = lowest
                  CHECK (priority BETWEEN 1 AND 10),
  title           VARCHAR(255)  NOT NULL,             -- "Reorder Basmati Rice by Friday"
  body            TEXT          NOT NULL,             -- full action description
  due_date        DATE          NULL,                 -- optional deadline
  completed_at    TIMESTAMPTZ   NULL,                 -- null = pending, set = done
  completed_by    UUID          NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_recommendations_updated_at
  BEFORE UPDATE ON recommendations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_recommendations_tenant_store    ON recommendations(tenant_id, store_id);
CREATE INDEX idx_recommendations_tenant_pending  ON recommendations(tenant_id, completed_at)
  WHERE completed_at IS NULL;


-- =============================================================================
-- LAYER 6: CONVENIENCE VIEWS
-- Pre-joined views used by the API routes. Using views here means the SQL
-- in the route files stays readable and the join logic lives in one place.
-- =============================================================================

-- daily_revenue_by_store
-- The primary data source for the revenue trend chart on BusinessOwnerDashboard.
-- Returns one row per (tenant, store, date) with aggregate revenue + cost.
CREATE OR REPLACE VIEW daily_revenue_by_store AS
SELECT
  st.tenant_id,
  st.store_id,
  s.name                          AS store_name,
  st.sale_date,
  COUNT(DISTINCT st.id)           AS transaction_count,
  SUM(st.quantity_sold)           AS units_sold,
  SUM(st.total_revenue)           AS gross_revenue,
  SUM(st.total_cost)              AS total_cogs,
  SUM(st.total_revenue)
    - SUM(st.total_cost)          AS gross_profit
FROM sale_transactions st
JOIN stores s ON s.id = st.store_id
GROUP BY st.tenant_id, st.store_id, s.name, st.sale_date;


-- product_daily_velocity
-- Used by Phase 3 stockout prediction: average daily units sold per product.
-- The Phase 3 engine will join this with inventory_logs to project days remaining.
CREATE OR REPLACE VIEW product_daily_velocity AS
SELECT
  st.tenant_id,
  st.store_id,
  st.product_id,
  p.name                          AS product_name,
  p.sku,
  st.sale_date,
  SUM(st.quantity_sold)           AS units_sold_on_day,
  SUM(st.total_revenue)           AS revenue_on_day
FROM sale_transactions st
JOIN products p ON p.id = st.product_id
GROUP BY st.tenant_id, st.store_id, st.product_id, p.name, p.sku, st.sale_date;


-- latest_inventory_per_product
-- For each product+store, returns only the most recent inventory_log row.
-- Joining this with product_daily_velocity gives stockout ETA.
CREATE OR REPLACE VIEW latest_inventory_per_product AS
SELECT DISTINCT ON (tenant_id, store_id, product_id)
  tenant_id,
  store_id,
  product_id,
  quantity_on_hand,
  log_date                        AS last_counted_date
FROM inventory_logs
ORDER BY tenant_id, store_id, product_id, log_date DESC;


-- active_anomaly_alerts
-- Unacknowledged + undismissed alerts with product details.
-- The AlertCard feed reads from this view.
CREATE OR REPLACE VIEW active_anomaly_alerts AS
SELECT
  aa.id,
  aa.tenant_id,
  aa.store_id,
  aa.product_id,
  p.name    AS product_name,
  p.sku     AS product_sku,
  aa.alert_type,
  aa.severity,
  aa.title,
  aa.description,
  aa.metric_value,
  aa.threshold_value,
  aa.z_score,
  aa.alert_date,
  aa.created_at
FROM anomaly_alerts aa
JOIN products p ON p.id = aa.product_id
WHERE aa.acknowledged_at IS NULL
  AND aa.dismissed_at    IS NULL
ORDER BY
  CASE aa.severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
  aa.alert_date DESC;


-- =============================================================================
-- SEED: single demo tenant
-- Remove or replace before any production deployment.
-- Used for local development and Vercel demo.
-- =============================================================================
INSERT INTO tenants (id, name, slug, currency_code, locale)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Demo Kiryana Store',
  'demo-kiryana',
  'PKR',
  'en-PK'
)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO stores (id, tenant_id, name, location)
VALUES (
  '00000000-0000-0000-0000-000000000010',
  '00000000-0000-0000-0000-000000000001',
  'Main Branch',
  'Block 5, Gulshan-e-Iqbal, Karachi'
)
ON CONFLICT DO NOTHING;
