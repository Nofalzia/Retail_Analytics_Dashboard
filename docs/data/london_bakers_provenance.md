# London Bakers I-10 — dataset provenance

**What this file is.** The audit trail for the second demonstration tenant (`london-bakers-i10`):
which source files were used, which columns they contributed, every filter and assumption applied,
and the exact commands that reproduce the datasets. It is the only file from that pipeline that is
committed — the raw export and the prepared CSVs are ignored by `.gitignore`.

**Why a second tenant.** `demo-kiryana` is a 12-SKU synthetic store. `london-bakers-i10` is a real
two-year point-of-sale export (731 days, 50 SKUs, 304,614 line items), which is what makes the
multi-tenant isolation, the dashboard charts and the ingestion path meaningful at realistic volume.

---

## 1. Sources

| File | Size | Used | Role |
|---|---|---|---|
| `pos_sales_log.csv` | ~41 MB | ✅ | line-item export (one row per item sold) — quantities, prices, dates, SKUs |
| `daily_performance.csv` | ~97 KB | ✅ | one row per day — `Gross_Revenue_PKR`, `COGS_Sold_PKR` (cost ratio only) |
| `pos_sales_log_real_extrapolated.csv` | ~32 MB | ❌ | alternative/extended export; not used |
| `London_Bakers_Dataset.xlsx` | ~28 MB | ❌ | spreadsheet bundle of the same data; not used |

Both files are supplied **by path** and are never copied into the repository:

```cmd
npm run bakery:prepare -- --input "<path>\pos_sales_log.csv" --daily "<path>\daily_performance.csv"
```

Only three columns of `daily_performance.csv` are read — `Date`, `Gross_Revenue_PKR`,
`COGS_Sold_PKR`. Its weather, staffing, spoilage, footfall and cash-variance columns play no part in
the prepared data.

Columns are matched using the same header rule as `backend/src/utils/validators.js`
(`normaliseHeader`: lowercase, trim, collapse inner whitespace), plus dropping any parenthesised
unit — so `Date (YYYY-MM-DD)` and `Date` both resolve. On this export the resolver picked:

| Canonical | Actual header | Values seen |
|---|---|---|
| `date` | `Date` | `YYYY-MM-DD` |
| `sku` | `SKU` | `SKU-101` … `SKU-150` |
| `productName` | `Item Name` | e.g. `Brown Bread` |
| `category` | `Category` | Bakery, Beverages, Breakfast, Chaat, Fast Food, Snacks, Sweets (7) |
| `quantity` | `Quantity` | integers ≥ 1 |
| `totalPrice` | `Total Price (PKR)` | net line revenue (list price less discount) |
| `status` | `Status` | `COMPLETED` / cancelled + refund variants |

---

## 2. Filters

Row-level filter, applied while streaming `pos_sales_log.csv` (never `readFile`):

* `Status` = `COMPLETED` (case- and whitespace-insensitive) — this is what removes cancelled and
  refunded lines;
* `Quantity` > 0;
* a parseable ISO date, a non-empty SKU and a non-negative `Total Price (PKR)`.

Rows that fail any test are counted by reason and reported. On the seed run above:

| | Rows |
|---|---|
| read | 304,614 |
| kept | 299,687 |
| excluded — `status_not_completed` | 4,310 |
| excluded — `quantity_not_positive` | 617 |

---

## 3. Aggregation

One output row per **(date, SKU)** — the shape `sale_transactions` stores:

* `quantity_sold` = `SUM(Quantity)`, and the pipeline **fails loudly** if any group's total is not a
  positive integer, because `sale_transactions.quantity_sold` is an integer column;
* `unit_price` = `round(SUM(Total Price) / SUM(Quantity), 2)` — a **net** unit price (list price less
  any discount on the line), so `quantity_sold × unit_price` reproduces the money the store actually
  took for that product that day. Averaging only the per-line unit price would have overstated
  revenue by ignoring discounts;
* `product_name` = the first `Item Name` seen for the SKU (the export has one name per SKU).

Result: 299,687 kept lines → **36,051 (date, SKU) groups** across **731 days** and **50 SKUs**.
Not every SKU sells every day, which is why 36,051 is below the 731 × 50 = 36,550 theoretical maximum.

---

## 4. Cost — an ALLOCATION, not recorded cost

> **The export records no per-item cost.** `pos_sales_log.csv` has list price, discount and net
> received, but nothing that says what the store paid for the bread it sold. Inventing a cost per
> SKU would have been fabrication, so the pipeline states one assumption and applies it uniformly.

`costRatio` = the **mean, over the 731 days of `daily_performance.csv`, of
`COGS_Sold_PKR / Gross_Revenue_PKR`**:

```
costRatio = 0.398136      (731 days used, 0 skipped — every day has gross revenue > 0)
unit_cost = round(unit_price × 0.398136, 2)
```

The seed does not hard-code that number: it re-derives it from the file it is about to load
(`Σ(quantity_sold × unit_cost) ÷ Σ(quantity_sold × unit_price)`, printed as `0.3981`) and uses it for
each product's `standard_unit_cost`. Editing the ratio therefore means re-running `bakery:prepare`
only — `bakery:seed` follows the data.

Consequences, stated plainly:

* every product carries the **same blended margin**, so **per-product gross margin is not
  trustworthy** for this tenant and no such claim should be made from it;
* **store-level and day-level totals are trustworthy**, because the ratio is calibrated so that
  aggregate cost ≈ aggregate recorded COGS;
* turnover, revenue trends, seasonality, weekday patterns and anomaly detection are all unaffected —
  they read quantities, revenue and dates, not cost;
* the schema column `cost_price_at_sale` therefore holds an allocated cost for this tenant. The
  rolling z-score engine and the recommendation rules do not depend on it.

To replace the assumption with real data, drop a per-SKU cost column into the export and change the
`unit_cost` line in `backend/scripts/bakery/prepareData.js` — nothing else needs to move.

---

## 5. Date shift

The source series ends in the past; a demo series must end near today, otherwise every trend chart
is flat-empty. Every date is shifted by **one constant number of days**, computed as the difference
between the last source date and `--end-date` (default: **yesterday, local**). A constant shift keeps
weekday alignment, payday rhythm and seasonality intact — no date is resampled or dropped.

| | From | To |
|---|---|---|
| source range | 2023-10-01 | 2025-09-30 |
| shift applied | +377 days | |
| shifted range | 2024-10-12 | 2026-10-12 |

Dates move with pure UTC arithmetic, so a daylight-saving boundary cannot shift a row by a day, and
the script never uses `toISOString()` for a local "yesterday".

**Reproducibility note:** the date range depends on the day the script runs, because the default
`--end-date` is "yesterday". Row counts, SKU counts and totals are identical on any run; pass
`--end-date 2026-10-12` to reproduce this exact calendar range byte-for-byte.

---

## 6. Outputs (in `data/processed/london-bakers/`, git-ignored)

| File | Rows | Contents |
|---|---|---|
| `london_bakers_history.csv` | 36,002 | 2024-10-12 → 2026-10-11, the series that is seeded |
| `london_bakers_live_day.csv` | 49 | the held-out last day (2026-10-12) — never seeded |
| `products.json` | 50 | `{ sku, name, category, referencePrice }`, 7 categories |

All three use one header — the exact canonical column names the upload pipeline requires:

```
date,sku,product_name,quantity_sold,unit_price,unit_cost
2024-10-12,SKU-101,Brown Bread,8,193.75,77.14
```

`referencePrice` is the **last** `unit_price` seen for the SKU in the shifted series (the most recent
observed selling price), and it becomes `products.standard_unit_price` at seed time.

The held-out day exists so the Data Ingestion screen can be demonstrated on a file that has **never**
been ingested: logging in as the London Bakers owner and uploading
`london_bakers_live_day.csv` walks the real upload path end to end.

---

## 7. Conservation check

The pipeline refuses to hand over data it cannot account for. After writing the files it compares the
money it kept on the way in with the money the output rows can reproduce:

| | PKR |
|---|---|
| kept input `Σ(Total Price (PKR))` | 131,887,011.00 |
| output `Σ(quantity_sold × unit_price)` | 131,887,074.20 |
| difference | 63.20 — **0.0000 %** |
| tolerance | 0.5 % |

`✅ CONSERVED` on every run; a difference above 0.5 % prints `❌ MISMATCH` and exits **1**, so a silent
regression in the aggregation cannot reach the database.

The residual 63.20 PKR is purely the 2-decimal rounding of `unit_price` on each of the 36,051 groups,
multiplied back out by quantity — it is not lost or invented revenue.

---

## 8. What the seed writes

`npm run bakery:seed` is idempotent and touches **only** this tenant; a re-run deletes this tenant's
`sale_transactions` / `inventory_logs` / `ingestion_jobs` / `anomaly_alerts` / `recommendations` and
rewrites them. It re-reads the tenant slug after the upsert and aborts before any `DELETE` if it is
not `london-bakers-i10`.

| Table | Rows | Content |
|---|---|---|
| `tenants` | 1 | `London Bakers I-10` / `london-bakers-i10`, PKR, `en-PK` |
| `stores` | 1 | `I-10 Branch` (location `NULL` — the export carries no address, none is invented) |
| `users` | 2 | `owner@londonbakers.demo`, `manager@londonbakers.demo`, password `Demo@1234` |
| `categories` | 7 | taken from `products.json` |
| `products` | 50 | `standard_unit_price` = `referencePrice`, `standard_unit_cost` = `round(referencePrice × costRatio, 2)`, reorder threshold 10 |
| `ingestion_jobs` | 1 | `london_bakers_history.csv`, `completed`, `file_hash` NULL |
| `sale_transactions` | 36,002 | chunked inserts, ≤ 1,000 rows per statement |
| `inventory_logs` | 0 | **none** — the export holds no stock counts, so none are invented |
| `anomaly_alerts` / `recommendations` | 0 | left for the detection engine to find, not copied from source labels |

Verified against the live database after the seed:

```
tenant id  : efd46f53-e1db-4717-a775-22b5203ea794     (generated by the upsert, not fixed)
sale rows  : 36,002        distinct products : 50        distinct days : 730
date range : 2024-10-12 → 2026-10-11                    inventory rows : 0
revenue    : 131,696,774.38 (Σ total_revenue, generated column)
products 50, categories 7, users 2, stores 1
```

(The `131,887,074.20` in §7 includes the held-out day; the seeded total is smaller by that day's
190,299.82 PKR, which is the point of the holdout.)

Invariants checked directly in SQL, all zero: quantity not a positive integer, fractional quantity,
cost above revenue, and any row where `unit_price_at_sale` ≠ `round(total_revenue / quantity_sold, 2)`.

**Isolation.** Before and after the seed the script prints a full row-count snapshot of the other demo
tenant (`demo-kiryana`) across all nine tenant tables. Both snapshots on the seed run above were
identical — `users=2, stores=1, categories=4, products=12, ingestion_jobs=4, sale_transactions=2,160,
inventory_logs=24, anomaly_alerts=14, recommendations=14` — and `demo-kiryana` still reads back as
`Demo Kiryana Store` / PKR / `en-PK`. If any count moves, the script prints which table changed and
exits **1**.

---

## 9. Privacy — what is deliberately not written

Only these six columns ever leave the pipeline: `date`, `sku`, `product_name`, `quantity_sold`,
`unit_price`, `unit_cost`. The source export's other columns are read and discarded:

* **personal / operational**: `Cashier`, `Payment Method`, `Channel`, `Promo Code`, `Transaction ID`,
  `Time`, `Order Time`, `Shift`;
* **redundant money columns**: `Unit Price (PKR)`, `Discount (PKR)`, `Commission/Fee (PKR)`,
  `Net Received (PKR)` — all already reflected in `Total Price (PKR)`;
* **source labels**: `Is_Anomaly`, `Anomaly_Type`. These are ignored on purpose: the demo must let the
  rolling z-score engine find anomalies from the numbers, so nobody can mistake shipped labels for
  detection quality.

---

## 10. Reproduce it

From the repository root (or `backend/` — relative paths resolve against the repo root either way):

```cmd
cd backend
npm run bakery:prepare -- --input "C:\Users\Nofal Zia\Desktop\London Bakers Data\pos_sales_log.csv" --daily "C:\Users\Nofal Zia\Desktop\London Bakers Data\daily_performance.csv" --end-date 2026-10-12
npm run bakery:seed
```

`bakery:prepare` prints the resolved columns, the cost-ratio derivation, the exclusion breakdown, the
date shift and the conservation check; `bakery:seed` prints the reset counts, the tenant summary and
the isolation check. Both exit non-zero on failure.

---

## 11. Known limitations

* **Cost is allocated, not measured** (§4) — do not quote per-product margins for this tenant.
* **No inventory snapshot, and `/api/stockout` does not return empty because of it.** The route LEFT
  JOINs `latest_inventory_per_product` and coalesces the missing count to `0`
  (`backend/src/routes/stockout.js`), so Stockout Watch lists **all 50 products as `stockout`, 0 days
  remaining**. That is an artifact of the absent inventory upload, not a signal in the sales data —
  upload an inventory CSV for this tenant before demoing that screen, or don't show it.
* **One row per (date, SKU)**, not one row per POS ticket. `daily_revenue_by_store.transaction_count`
  therefore counts product-days for this tenant, so the "orders / transactions" KPI is not directly
  comparable with `demo-kiryana`'s seed data. Ticket-level detail is not in the output by design
  (see §9).
* **The date range follows the run date** (§5) unless `--end-date` is passed explicitly.
* The two source files must be supplied by path; they are intentionally not committed.


