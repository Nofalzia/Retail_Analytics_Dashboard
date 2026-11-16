# Upload templates

The importer accepts two kinds of file: a **sales export** and a **stock count**. Which one a file
is comes from its **header row**, never from its file name or extension
(`detectFileKind()` in `backend/src/utils/validators.js`). A file that satisfies the sales
requirements is always treated as sales, even if it also carries a leftover `stock` column — choosing
inventory there would silently import the wrong facts.

The browser offers both templates for download from Data Ingestion. They are generated in
`src/utils/salesUpload.js`, and their headers mirror the canonical columns the parser reads
(`backend/src/utils/validators.js`), so a downloaded template maps without guessing.

| Template | File name | Header row |
|---|---|---|
| Sales | `retail-import-template.csv` | `date,sku,product_name,quantity_sold,unit_price,unit_cost` |
| Stock count | `retail-stock-count-template.csv` | `sku,quantity_on_hand,count_date,product_name` |

Each template contains exactly one sample row:

```csv
date,sku,product_name,quantity_sold,unit_price,unit_cost
2026-10-01,SKU-TPLT-001,Sample Product,10,120.00,80.00
```

```csv
sku,quantity_on_hand,count_date,product_name
SKU-TPLT-001,24,2026-10-01,Sample Product
```

The sales sample row imports as-is: an unknown SKU is created as a product. The stock-count sample
row does **not** — a count never creates products, so replace `SKU-TPLT-001` with a SKU the store
already sells (import its sales history first) before uploading a filled-in count.

## Accepted files

- `.csv`, `.xlsx` and `.xls`. The browser file picker offers `.csv` and `.xlsx`; the API accepts all
  three.
- Up to `MAX_FILE_SIZE_MB` (default **60**). XLSX/XLS workbooks are read into memory by SheetJS, so
  the cap is the real guard rail for workbook size; CSV is streamed.
- Uploaded through `POST /api/upload` with the target store. The **store is not read from the file**;
  a `store` / `branch` / `location` column is recognised and ignored.
- Each file is deduplicated per store by SHA-256 hash, so re-uploading the same bytes returns `409`
  instead of importing twice.

## How headers are matched

Before comparison every header is normalised (`normaliseHeader()`):

1. lower-cased;
2. bracketed parts are dropped — `Unit Price (PKR)`, `Cost [Net]`;
3. underscores, dashes and dots become spaces — `unit_price`, `unit-price`, `Unit.Price`;
4. repeated whitespace is collapsed and the ends trimmed.

So `Sale Date`, `sale_date` and `SALE  DATE` are the same header. A header can be claimed by **one**
canonical column only, which is why `Total Price` always lands on `total_revenue` and never on
`unit_price`. Columns that match nothing are listed back to the user as
*"Unrecognised columns (will be ignored)"* — they are ignored, not an error.

## Sales file

### Required

A requirement is reported missing only when **nothing** matched it.

| Requirement | Accepted canonical columns |
|---|---|
| A date | `date` |
| A quantity | `quantity_sold` |
| A price | `unit_price` **or** `total_revenue` |
| A product identity | `sku` **or** `product_name` |

### Aliases

| Canonical column | Accepted headers (after normalisation) |
|---|---|
| `date` | `date`, `sale date`, `transaction date`, `order date`, `invoice date`, `bill date`, `day` |
| `sku` | `sku`, `item code`, `product code`, `product id`, `item id`, `barcode`, `code` |
| `product_name` | `product name`, `product`, `item name`, `item`, `description`, `name` |
| `quantity_sold` | `quantity sold`, `quantity`, `qty`, `qty sold`, `units sold`, `units`, `pieces`, `pcs` |
| `unit_price` | `unit price`, `selling price`, `sale price`, `price`, `rate`, `price per unit` |
| `total_revenue` | `total price`, `total`, `line total`, `revenue`, `sales`, `amount`, `net amount`, `net sales`, `total sales` |
| `unit_cost` | `unit cost`, `cost price`, `cost`, `cogs`, `unit cogs`, `purchase price`, `realized cost` |
| `category` | `category`, `product category`, `department`, `type` |
| `status` | `status`, `order status`, `transaction status`, `payment status` |
| `store_id` | `store`, `store id`, `branch`, `location` |

### Optional columns

| Situation | What the import does |
|---|---|
| `unit_price` absent, `total_revenue` present | Net unit price = `total_revenue / quantity_sold`, rounded to 2 dp — a line total is already net of discounts, so that is what is kept. |
| Both price columns present | `total_revenue` wins, for the same reason. |
| `unit_cost` absent | `unit_cost = round(unit_price × COST_RATIO_DEFAULT, 2)` — **60 % of price by default**. The job reports *"No cost column found: cost estimated at 60% of price, so margins are estimates."* |
| `sku` absent | The product name becomes the product code, and the job says *"No SKU column: product names are used as product codes."* |
| `category` absent | The product is created without a category. |
| `status` present | Rows whose status is not a completed sale are **skipped and counted** (`skippedByStatus`), not failed. Accepted: `completed`, `complete`, `paid`, `sold`, `success`, `successful`, `delivered`, `closed`. |
| `store_id` present | Ignored: the store comes from the upload request and is verified against the tenant. |

### Row rules

- `quantity_sold` must be a **positive integer** — it is also the divisor of a line total.
- A price must be a **non-negative number**.
- `unit_cost`, when present, must be a non-negative number.
- An invalid row is logged with its row number and the raw value and does not stop the file; the job
  reports `rows_failed` and keeps the error log.

## Stock-count file

### Required

| Requirement | Accepted canonical columns |
|---|---|
| A product identity | `sku` (same aliases as the sales contract) |
| A quantity on hand | `quantity_on_hand` |

### Aliases

| Canonical column | Accepted headers (after normalisation) |
|---|---|
| `sku` | `sku`, `item code`, `product code`, `product id`, `item id`, `barcode`, `code` |
| `quantity_on_hand` | `quantity on hand`, `qty on hand`, `on hand`, `stock on hand`, `stock`, `stock level`, `current stock`, `closing stock`, `inventory`, `balance` |
| `count_date` *(optional)* | `count date`, `counted date`, `date`, `stock date`, `stock count date`, `inventory date`, `as of date`, `as of`, `snapshot date` |
| `product_name` *(optional)* | `product name`, `product`, `item name`, `item`, `description`, `name` — parsed and never used to create a product |

### Row rules

- `quantity_on_hand` must be a **non-negative whole number**. `12.5`, `-3`, `1,200` and `abc` are all
  rejected — a fractional or negative count is not a count.
- `count_date` is optional. An empty cell (or an absent column) means **today**; a cell that holds
  something unreadable is a row error.
- The SKU must already exist for the tenant. A count never creates products, so an unknown SKU is a
  row error — import the sales history that contains it first.
- No assumptions are recorded for a count file's columns — nothing is estimated — but a `count_date`
  that had to be read day-first still records *"Dates read as day/month/year"* on the job.

## Dates

Both contracts use the same parser (`parseFlexibleDate()`). Accepted:

| Input | Example |
|---|---|
| ISO date, with or without a time (the time is ignored) | `2025-10-12`, `2025-10-12T08:30:00` |
| Excel serial number, 20000–80000 (a numeric cell or numeric text) | `45658` -> 2025-01-01 |
| Day-first slash or dash date | `31/12/2025`, `31-12-2025` |
| Month-first slash date, only when unambiguous (second part over 12) | `12/31/2025` |
| Day then month name | `12 Oct 2025`, `12 October 2025` |
| Month name then day | `Oct 12, 2025` |

An ambiguous slash date (`03/04/2025` — both parts 12 or under) is read **day/month/year** and the
job records the assumption *"Dates read as day/month/year"*. A cell that matches no format is a row
error quoting the raw text, because a guessed date is worse than a rejected row. Years before 2000
and impossible days (31 February) are rejected.

## What happens when a column is missing

The header check runs **before** any row is written, so a file with missing columns imports nothing:

- the job is marked `failed` and its error log holds one entry,
  `{ type: 'MISSING_COLUMNS', columns, warnings, detectedHeaders }`;
- `columns` names only the requirements nothing matched, e.g.
  `['date', 'unit_price or total_revenue']`;
- `detectedHeaders` echoes the headers that were found, so the screen can say what it saw instead of
  only what it wanted;
- `warnings` lists unrecognised headers;
- for a workbook, `sheetsInspected` names every sheet whose first row was checked.

For XLSX/XLS, **every sheet's first row** is inspected and the **first** sheet satisfying either
contract is imported (sales first, then stock count). Empty sheets, notes tabs and instruction tabs
cannot satisfy a contract, so they are skipped. When no sheet qualifies, the error is reported against
the sheet that came closest. The chosen sheet is recorded in the job's assumptions:
*`Excel sheet "<name>" was used for the import.`*

## Verifying the contract locally

The sales-contract validators have a database-free self-test:

```cmd
:: run from backend/
npm run test:validators
```

It asserts alias resolution, the missing-requirement reporting, the price-source precedence, the
estimated cost, the status skip and the date formats above, so a table in this document that drifts
from `backend/src/utils/validators.js` shows up as a failing assertion. The stock-count contract is
not covered by that self-test; exercise it with a small count file against a seeded store.

