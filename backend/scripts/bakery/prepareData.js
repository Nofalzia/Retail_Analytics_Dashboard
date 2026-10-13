/**
 * backend/scripts/bakery/prepareData.js
 * ──────────────────────────────────────────────────────────────────────────────
 * T10a — reproducible preparation of the second demonstration tenant's series.
 *
 * Input (NOT in the repository — supplied by path, see --input / --daily):
 *   * a point-of-sale line-item export (one row per line sold)
 *   * a daily export carrying Gross_Revenue_PKR and COGS_Sold_PKR
 *
 * What the script does, in order:
 *   1. stream the line-item export once (fs.createReadStream + csv-parser, the
 *      same parser src/routes/upload.js uses — never readFile);
 *   2. keep only rows where Status = COMPLETED and Quantity > 0;
 *   3. aggregate to one row per (date, SKU): quantity_sold = SUM(Quantity) and
 *      unit_price = round(SUM(Total Price) / SUM(Quantity), 2) — a NET unit price
 *      (list price less discount), so quantity_sold × unit_price reproduces the
 *      money the store actually took for that product on that day;
 *   4. allocate unit_cost = round(unit_price × costRatio, 2);
 *   5. shift every date by one constant number of days so the LAST source date
 *      becomes --end-date (default: yesterday, local time);
 *   6. split the shifted series into the history file and the held-out live-day
 *      file, and emit the product catalogue;
 *   7. run a conservation check (output revenue vs kept input revenue) and exit 1
 *      when the two disagree by more than 0.5 %.
 *
 * THE COST RATIO IS AN ALLOCATION ASSUMPTION, NOT RECORDED COST.
 * The export records no per-item cost. costRatio is the MEAN, over the days in the
 * daily export, of (COGS_Sold_PKR / Gross_Revenue_PKR). Every line's unit_cost is
 * allocated with that single blended ratio, so cost and margin figures for this
 * tenant are internally consistent but are an allocation, not a measurement.
 *
 * Output files (the exact header the upload pipeline requires — the canonical
 * column names live in src/utils/validators.js):
 *   london_bakers_history.csv   date,sku,product_name,quantity_sold,unit_price,unit_cost
 *   london_bakers_live_day.csv  the same header — only the held-out day(s)
 *   products.json               distinct { sku, name, category, referencePrice }
 *
 * Privacy: cashier, payment method, transaction id and every other personal,
 * promotional or channel field are never copied into the output — only the six
 * columns above, plus the catalogue, are written.
 *
 * Run from backend/ (relative paths resolve against the repository root):
 *   npm run bakery:prepare -- --input "<pos.csv>" --daily "<daily.csv>"
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import csvParser from 'csv-parser';

// ── Configuration ────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/scripts/bakery → repository root. Relative path arguments (including the
// --out default) resolve against the repository root, so the same command works
// whether it is run from backend/ or from the repository root.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const DEFAULT_OUT_DIR   = 'data/processed/london-bakers';
const HISTORY_FILENAME  = 'london_bakers_history.csv';
const LIVE_FILENAME     = 'london_bakers_live_day.csv';
const PRODUCTS_FILENAME = 'products.json';
const OUTPUT_HEADER     = ['date', 'sku', 'product_name', 'quantity_sold', 'unit_price', 'unit_cost'];
const CONSERVATION_TOLERANCE = 0.005; // 0.5 %
const COMPLETED_STATUS  = 'COMPLETED';

// Source columns are matched case-insensitively, whitespace-collapsed and with any
// parenthesised unit ignored, so "Date (YYYY-MM-DD)" and "Date" both resolve.
const SOURCE_COLUMNS = {
  date:        ['date (yyyy-mm-dd)', 'date', 'sale date', 'transaction date'],
  sku:         ['sku', 'item code', 'product code'],
  productName: ['item name', 'product name', 'description'],
  category:    ['category', 'product category', 'department'],
  quantity:    ['quantity', 'quantity sold', 'qty'],
  totalPrice:  ['total price (pkr)', 'total price', 'line total', 'net total'],
  status:      ['status', 'order status'],
};

const DAILY_COLUMNS = {
  date:         ['date (yyyy-mm-dd)', 'date', 'sale date'],
  grossRevenue: ['gross_revenue_pkr', 'gross revenue pkr', 'gross_revenue', 'gross revenue'],
  cogsSold:     ['cogs_sold_pkr', 'cogs sold pkr', 'cogs_sold', 'cogs sold', 'cogs'],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Prints the command-line usage block. */
function usage() {
  console.log(`
Usage: npm run bakery:prepare -- [options]

  --input   <path>      point-of-sale line-item CSV              (required)
  --daily   <path>      daily CSV with revenue + COGS            (required)
  --out     <dir>       output directory   (default: ${DEFAULT_OUT_DIR})
  --end-date <date>     last date of the shifted series (default: yesterday, local)
  --holdout-days <n>    days held out as the live-day file (default: 1)
  --help                print this message

Relative paths resolve against the repository root.`);
}

/**
 * Minimal `--flag value` / `--flag=value` argument parser.
 * @param {string[]} argv Arguments after the script path.
 * @returns {Object<string, string|boolean>} Parsed flags.
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq !== -1) {
      args[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

/**
 * Resolves an absolute or repository-relative path.
 * @param {string} value Path from the command line.
 * @returns {string} Absolute path.
 */
function resolvePath(value) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(REPO_ROOT, value);
}

/**
 * Formats a Date as YYYY-MM-DD from LOCAL calendar fields (never toISOString,
 * which would silently shift the day near midnight outside UTC).
 * @param {Date} date Date to format.
 * @returns {string} Local ISO date.
 */
function localDateString(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** @param {string} value Candidate date. @returns {boolean} True for a real YYYY-MM-DD date. */
function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/**
 * Shifts an ISO date by a whole number of days (UTC arithmetic — DST-proof).
 * @param {string} iso ISO date. @param {number} days Days to add (may be negative).
 * @returns {string} Shifted ISO date.
 */
function shiftIsoDate(iso, days) {
  const shifted = new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Whole days from one ISO date to another.
 * @param {string} fromIso Start date. @param {string} toIso End date.
 * @returns {number} Signed day difference.
 */
function daysBetween(fromIso, toIso) {
  return Math.round(
    (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000,
  );
}

/**
 * Header normaliser — the same rule as src/utils/validators.js, so any file the
 * upload pipeline accepts is also accepted here.
 * @param {string} value Raw header. @returns {string} Normalised header.
 */
function normaliseHeader(value) {
  return String(value).toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Every spelling of a header the resolver accepts: as-is, without a parenthesised
 * unit, and with underscores read as spaces.
 * @param {string} header Raw header. @returns {string[]} Candidate spellings.
 */
function headerCandidates(header) {
  const normalised = normaliseHeader(header);
  return [
    normalised,
    normalised.replace(/\(.*?\)/g, '').trim().replace(/\s+/g, ' '),
    normalised.replace(/_/g, ' '),
  ];
}

/**
 * Maps canonical column names to the actual headers found in a file.
 * @param {string[]} headers Headers of the file.
 * @param {Object<string, string[]>} spec Canonical name → accepted spellings.
 * @param {string} label File label used in error messages.
 * @returns {Object<string, string>} Canonical name → actual header.
 * @throws {Error} If a required column is missing.
 */
function resolveColumns(headers, spec, label) {
  const candidateIndex = new Map();
  headers.forEach((header) => {
    headerCandidates(header).forEach((candidate) => {
      if (!candidateIndex.has(candidate)) candidateIndex.set(candidate, header);
    });
  });

  const map = {};
  const missing = [];
  for (const [canonical, spellings] of Object.entries(spec)) {
    const match = spellings.map((word) => candidateIndex.get(word)).find(Boolean);
    if (match) map[canonical] = match;
    else missing.push(canonical);
  }

  if (missing.length > 0) {
    throw new Error(
      `${label}: missing required column(s): ${missing.join(', ')}\n` +
      `       headers found: ${headers.join(', ')}`,
    );
  }
  return map;
}

/**
 * Parses a numeric cell — tolerates thousands separators, spaces and currency text.
 * @param {*} value Raw cell.
 * @returns {number} Parsed number, or NaN.
 */
function parseNumber(value) {
  if (typeof value === 'number') return value;
  const cleaned = String(value ?? '').replace(/[^0-9eE+\-.]/g, '');
  return cleaned === '' ? Number.NaN : Number(cleaned);
}

/** @param {number} value Number to round. @returns {number} Value rounded to 2 dp. */
function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** @param {number} value Integer to format. @returns {string} Thousands-separated string. */
function formatInt(value) {
  return value.toLocaleString('en-US');
}

/**
 * Quotes a CSV cell when it contains a comma, quote or newline.
 * @param {string|number} value Cell value.
 * @returns {string} CSV-safe cell.
 */
function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Serialises rows to CSV text with the canonical output header.
 * @param {Array<Object>} rows Objects carrying the OUTPUT_HEADER keys.
 * @returns {string} CSV document (LF line endings, trailing newline).
 */
function toCsv(rows) {
  const lines = [OUTPUT_HEADER.join(',')];
  for (const row of rows) lines.push(OUTPUT_HEADER.map((key) => csvCell(row[key])).join(','));
  return `${lines.join('\n')}\n`;
}

// ── Input readers (streaming) ────────────────────────────────────────────────

/**
 * Reads only the header row of a CSV — the same streaming approach as
 * src/routes/upload.js `extractHeaders` (the stream is destroyed after the
 * header line, so the file is not read into memory).
 * @param {string} filePath CSV to inspect.
 * @param {Object<string, string[]>} spec Canonical name → accepted spellings.
 * @returns {Promise<Object<string, string>>} Canonical name → actual header.
 */
function readColumns(filePath, spec) {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath).pipe(csvParser());
    stream.on('headers', (headers) => {
      stream.destroy();
      try {
        resolve(resolveColumns(headers, spec, path.basename(filePath)));
      } catch (err) {
        reject(err);
      }
    });
    stream.on('error', reject);
  });
}

/**
 * Streams the line-item export once, applies the keep rules (Status = COMPLETED
 * and Quantity > 0) and aggregates the kept rows to one record per (date, SKU).
 * product_name and category are taken from the first kept row seen for the SKU.
 * @param {string} filePath Line-item CSV.
 * @param {Object<string, string>} columns Resolved column map.
 * @returns {Promise<{rowsRead: number, rowsKept: number, keptRevenue: number,
 *   excluded: Object<string, number>, aggregates: Array<Object>}>} Aggregation result.
 */
function aggregatePos(filePath, columns) {
  return new Promise((resolve, reject) => {
    const byKey = new Map();
    const excluded = {};
    let rowsRead = 0;
    let rowsKept = 0;
    let keptRevenue = 0;

    const exclude = (reason) => {
      excluded[reason] = (excluded[reason] || 0) + 1;
    };

    const stream = createReadStream(filePath).pipe(csvParser());

    stream.on('data', (row) => {
      rowsRead++;

      const status = normaliseHeader(row[columns.status] ?? '').toUpperCase();
      if (status !== COMPLETED_STATUS) { exclude('status_not_completed'); return; }

      const quantity = parseNumber(row[columns.quantity]);
      if (!Number.isFinite(quantity) || quantity <= 0) { exclude('quantity_not_positive'); return; }

      const sku = String(row[columns.sku] ?? '').trim();
      if (!sku) { exclude('missing_sku'); return; }

      const date = String(row[columns.date] ?? '').trim();
      if (!isIsoDate(date)) { exclude('invalid_date'); return; }

      const totalPrice = parseNumber(row[columns.totalPrice]);
      if (!Number.isFinite(totalPrice) || totalPrice < 0) { exclude('invalid_total_price'); return; }

      const key = `${date}\u0000${sku}`;
      let record = byKey.get(key);
      if (!record) {
        record = {
          date,
          sku,
          productName: String(row[columns.productName] ?? '').trim() || sku,
          category:    String(row[columns.category] ?? '').trim() || null,
          quantity:    0,
          revenue:     0,
        };
        byKey.set(key, record);
      }

      record.quantity += quantity;
      record.revenue  += totalPrice;
      rowsKept++;
      keptRevenue += totalPrice;
    });

    stream.on('end', () => resolve({
      rowsRead,
      rowsKept,
      keptRevenue,
      excluded,
      aggregates: [...byKey.values()],
    }));
    stream.on('error', reject);
  });
}

/**
 * Computes the blended cost ratio: the MEAN, over the days of the daily export, of
 * (COGS_Sold_PKR / Gross_Revenue_PKR). Days with no gross revenue are skipped.
 * @param {string} filePath Daily CSV.
 * @param {Object<string, string>} columns Resolved column map.
 * @returns {Promise<{costRatio: number, daysUsed: number, daysSkipped: number,
 *   firstDate: string|null, lastDate: string|null}>} Cost-ratio summary.
 */
function readCostRatio(filePath, columns) {
  return new Promise((resolve, reject) => {
    let ratioSum = 0;
    let daysUsed = 0;
    let daysSkipped = 0;
    let firstDate = null;
    let lastDate = null;

    const stream = createReadStream(filePath).pipe(csvParser());

    stream.on('data', (row) => {
      const date = String(row[columns.date] ?? '').trim();
      if (isIsoDate(date)) {
        if (firstDate === null || date < firstDate) firstDate = date;
        if (lastDate === null || date > lastDate) lastDate = date;
      }

      const gross = parseNumber(row[columns.grossRevenue]);
      const cogs  = parseNumber(row[columns.cogsSold]);
      if (!Number.isFinite(gross) || !Number.isFinite(cogs) || gross <= 0) {
        daysSkipped++;
        return;
      }

      ratioSum += cogs / gross;
      daysUsed++;
    });

    stream.on('end', () => resolve({
      costRatio: daysUsed === 0 ? Number.NaN : ratioSum / daysUsed,
      daysUsed,
      daysSkipped,
      firstDate,
      lastDate,
    }));
    stream.on('error', reject);
  });
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Runs the whole preparation pipeline.
 * @returns {Promise<void>} Resolves when the outputs are written and the
 *   conservation check has passed; exits 1 when it has not.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const optionValue = (key) => (typeof args[key] === 'string' ? args[key] : undefined);

  if (args.help) {
    usage();
    return;
  }
  if (!optionValue('input') || !optionValue('daily')) {
    usage();
    throw new Error('both --input (line-item export) and --daily (daily export) are required');
  }

  const posPath   = resolvePath(optionValue('input'));
  const dailyPath = resolvePath(optionValue('daily'));
  const outDir    = resolvePath(optionValue('out') ?? DEFAULT_OUT_DIR);

  const holdoutDays = optionValue('holdout-days') === undefined
    ? 1
    : Number.parseInt(optionValue('holdout-days'), 10);
  if (!Number.isInteger(holdoutDays) || holdoutDays < 0) {
    throw new Error(`--holdout-days must be a non-negative integer (got "${args['holdout-days']}")`);
  }

  const endDate = optionValue('end-date') ?? localDateString(new Date(Date.now() - 86_400_000));
  if (!isIsoDate(endDate)) throw new Error(`--end-date must be YYYY-MM-DD (got "${endDate}")`);

  // ── 1/2/3 resolve columns, stream the export once, filter, aggregate ────────
  const posColumns   = await readColumns(posPath, SOURCE_COLUMNS);
  const dailyColumns = await readColumns(dailyPath, DAILY_COLUMNS);

  console.log('\n── Source ─────────────────────────────────────────────────');
  console.log(`  line-item export : ${posPath}`);
  console.log(`  daily export     : ${dailyPath}`);
  console.log(`  columns resolved : ${Object.entries(posColumns).map(([k, v]) => `${k}="${v}"`).join(', ')}`);

  // ── 4 the cost ratio (single blended ratio, printed once) ───────────────────
  const daily = await readCostRatio(dailyPath, dailyColumns);
  if (!Number.isFinite(daily.costRatio)) {
    throw new Error('daily export holds no usable (COGS, gross revenue) day — cannot derive a cost ratio');
  }
  const costRatio = daily.costRatio;

  console.log('\n── Cost ratio — ALLOCATION ASSUMPTION, not recorded cost ──');
  console.log('  The export records no per-item cost. costRatio is the mean over days of');
  console.log(`  (COGS_Sold_PKR / Gross_Revenue_PKR) = ${costRatio.toFixed(6)}`);
  console.log(`  days used ${formatInt(daily.daysUsed)} · days skipped (no gross revenue) ${formatInt(daily.daysSkipped)}`);
  console.log(`  daily export range : ${daily.firstDate} .. ${daily.lastDate}`);
  console.log(`  unit_cost          = round(unit_price × ${costRatio.toFixed(6)}, 2)`);

  const pos = await aggregatePos(posPath, posColumns);

  console.log('\n── Filtering (Status = COMPLETED, Quantity > 0) ───────────');
  console.log(`  rows read        : ${formatInt(pos.rowsRead)}`);
  console.log(`  rows kept        : ${formatInt(pos.rowsKept)}`);
  console.log(`  rows excluded    : ${formatInt(pos.rowsRead - pos.rowsKept)}`);
  for (const [reason, count] of Object.entries(pos.excluded).sort((a, b) => b[1] - a[1])) {
    console.log(`      ${reason.padEnd(20)} ${formatInt(count)}`);
  }
  console.log(`  source (date, SKU) pairs : ${formatInt(pos.aggregates.length)}`);
  console.log(`  distinct SKUs            : ${formatInt(new Set(pos.aggregates.map((r) => r.sku)).size)}`);

  const fractional = pos.aggregates.filter((r) => !Number.isInteger(r.quantity));
  if (fractional.length > 0) {
    throw new Error(
      `${fractional.length} (date, SKU) group(s) have a non-integer aggregated quantity — ` +
      'quantity_sold must be a positive integer for the upload pipeline',
    );
  }

  // ── 5 shift every date so the last source date becomes --end-date ───────────
  const sourceDates = [...new Set(pos.aggregates.map((r) => r.date))].sort();
  if (sourceDates.length === 0) throw new Error('no rows survived filtering — nothing to write');
  const lastSourceDate = sourceDates[sourceDates.length - 1];
  const shiftDays = daysBetween(lastSourceDate, endDate);

  const rows = pos.aggregates.map((record) => {
    const unitPrice = round2(record.revenue / record.quantity); // net unit price
    return {
      date:            shiftIsoDate(record.date, shiftDays),
      sku:             record.sku,
      product_name:    record.productName,
      quantity_sold:   record.quantity,
      unit_price:      unitPrice,
      unit_cost:       round2(unitPrice * costRatio),
      _category:       record.category,
    };
  });
  rows.sort((a, b) => (a.date === b.date ? a.sku.localeCompare(b.sku) : a.date.localeCompare(b.date)));

  console.log('\n── Constant date shift ───────────────────────────────────');
  console.log(`  original range : ${sourceDates[0]} .. ${lastSourceDate} (${formatInt(sourceDates.length)} days)`);
  console.log(`  shift          : ${shiftDays >= 0 ? '+' : ''}${formatInt(shiftDays)} days`);
  console.log(`  new range      : ${rows[0].date} .. ${rows[rows.length - 1].date}`);

  // ── 6 split off the held-out live day(s) and build the catalogue ─────────────
  const allDates = [...new Set(rows.map((r) => r.date))].sort();
  const holdoutCount = Math.min(holdoutDays, allDates.length);
  const holdoutDates = new Set(allDates.slice(allDates.length - holdoutCount));

  const historyRows = rows.filter((r) => !holdoutDates.has(r.date));
  const liveRows    = rows.filter((r) => holdoutDates.has(r.date));

  // referencePrice = the LAST unit_price seen for the SKU in the shifted series
  const catalogue = new Map();
  for (const row of rows) {
    catalogue.set(row.sku, {
      sku:            row.sku,
      name:           row.product_name,
      category:       row._category,
      referencePrice: row.unit_price,
    });
  }
  const products = [...catalogue.values()].sort((a, b) => a.sku.localeCompare(b.sku));

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, HISTORY_FILENAME), toCsv(historyRows), 'utf8');
  await writeFile(path.join(outDir, LIVE_FILENAME), toCsv(liveRows), 'utf8');
  await writeFile(path.join(outDir, PRODUCTS_FILENAME), `${JSON.stringify(products, null, 2)}\n`, 'utf8');

  console.log('\n── Output ────────────────────────────────────────────────');
  console.log(`  directory : ${outDir}`);
  console.log(`  ${HISTORY_FILENAME.padEnd(28)} ${formatInt(historyRows.length)} rows`);
  console.log(`  ${LIVE_FILENAME.padEnd(28)} ${formatInt(liveRows.length)} rows (${[...holdoutDates].join(', ') || 'none'})`);
  console.log(`  ${PRODUCTS_FILENAME.padEnd(28)} ${formatInt(products.length)} products, ` +
    `${formatInt(new Set(products.map((p) => p.category)).size)} categories`);
  console.log(`  header : ${OUTPUT_HEADER.join(',')}`);
  console.log('  (cashier, payment, transaction id and other personal fields are not written)');

  // ── 7 conservation check — exit 1 when the revenue is not reproduced ────────
  const outputRevenue = rows.reduce((sum, r) => sum + r.quantity_sold * r.unit_price, 0);
  const difference    = Math.abs(outputRevenue - pos.keptRevenue);
  const differencePct = pos.keptRevenue > 0 ? (difference / pos.keptRevenue) * 100 : Number.POSITIVE_INFINITY;
  const conserved     = pos.keptRevenue > 0 && difference / pos.keptRevenue <= CONSERVATION_TOLERANCE;

  console.log('\n── Conservation check (output revenue vs kept input revenue) ──');
  console.log(`  kept input  Σ(Total Price)           : ${pos.keptRevenue.toFixed(2)}`);
  console.log(`  output      Σ(quantity × unit_price) : ${outputRevenue.toFixed(2)}`);
  console.log(`  difference                           : ${difference.toFixed(2)} (${differencePct.toFixed(4)} %)`);
  console.log(`  tolerance                            : ${(CONSERVATION_TOLERANCE * 100).toFixed(1)} %`);
  console.log(`  kept input rows ${formatInt(pos.rowsKept)} → output rows ${formatInt(rows.length)} ` +
    `across ${formatInt(allDates.length)} days, ${formatInt(new Set(rows.map((r) => r.sku)).size)} SKUs`);
  console.log(conserved
    ? '  ✅ CONSERVED — the output rows reproduce the kept input revenue'
    : '  ❌ MISMATCH — the output rows do not reproduce the kept input revenue');

  if (!conserved) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n❌ Preparation failed:', err.message);
  process.exit(1);
});
