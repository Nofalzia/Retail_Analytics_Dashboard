/**
 * backend/scripts/demo/generateSyntheticSales.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Phase 4 — generates three UPLOAD-READY synthetic sales files (plus one stock
 * count) that exercise the upload pipeline end to end without using any real
 * store's data.
 *
 *   sales_healthy.csv        canonical header, steady demand, no bad rows
 *                            → proves a clean file imports with 0 failures
 *   sales_struggling.csv     canonical header, demand climbing ~85 % from the
 *                            first day to the last, plus a deliberate stockout
 *                            gap in the last days for part of the catalogue
 *   stockcount_struggling.csv  matching count with 0–3 days of cover per SKU
 *                            → together they make Stockout Watch light up
 *   sales_messy.csv          DIFFERENT header wording (Bill Date / Item Code /
 *                            Item Name / Qty / Rate / Order Status / Branch),
 *                            DD/MM/YYYY dates, a status column with cancelled
 *                            and refunded rows, no cost column, and five rows
 *                            that must fail validation on purpose
 *                            → proves flexible mapping and honest row errors
 *
 * Everything is drawn from ONE seeded mulberry32 stream per file (seeds derived
 * from --seed), so the same flags always produce byte-identical files.
 *
 * Rows with 0 units are NOT written: sale_transactions.quantity_sold has a
 * CHECK (> 0), so a zero-unit day would be a row error rather than an honest
 * stockout. The manifest records how many such days were skipped.
 *
 * Run from backend/ (relative --out resolves against the repository root):
 *   npm run demo:generate
 *   npm run demo:generate -- --days 60 --skus 25 --seed 7 --out data/processed/synthetic
 * ──────────────────────────────────────────────────────────────────────────────
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrng } from '../validation/prng.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/scripts/demo → repository root. Same convention as bakery/prepareData.js.
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const DEFAULTS = Object.freeze({ days: 90, skus: 40, seed: 20261117, out: 'data/processed/synthetic' });
const LIMITS = Object.freeze({ days: [14, 365], skus: [5, 200] });

const SALES_HEADER      = ['date', 'sku', 'product_name', 'quantity_sold', 'unit_price', 'unit_cost'];
const STOCK_HEADER      = ['sku', 'product_name', 'quantity_on_hand', 'count_date'];
const MESSY_HEADER      = ['Bill Date', 'Item Code', 'Item Name', 'Qty', 'Rate', 'Order Status', 'Branch'];
const MESSY_CANCELLED   = 'Cancelled';
const MESSY_REFUNDED    = 'Refunded';
const STORE_LABEL       = 'Main Branch';

const WEEKEND_MULTIPLIER = 1.15;
const TREND_STRENGTH     = 0.85;   // struggling file: last day ≈ 1.85 × first day
const CANCELLED_SHARE    = 0.23;
const REFUNDED_SHARE     = 0.07;
const STOCKOUT_SKU_SHARE = 0.30;   // share of the catalogue that stocks out at the end
const BAD_ROW_TOTAL      = 5;

/** @returns {string} `value` padded on the left to `width` characters. */
function pad(value, width) {
  return String(value).padStart(width, '0');
}

/** @param {Date} date @returns {string} Local ISO date (YYYY-MM-DD), no timezone shift. */
function toIsoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
}

/** @param {Date} date @returns {string} Local DD/MM/YYYY date, the messy file's wording. */
function toDayFirstDate(date) {
  return `${pad(date.getDate(), 2)}/${pad(date.getMonth() + 1, 2)}/${date.getFullYear()}`;
}

/** @param {Date} date @param {number} days @returns {Date} A new date shifted by `days`. */
function addDays(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** @returns {number} `value` rounded to 2 decimals (money columns). */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Quotes a CSV field only when it needs it, so generated files stay readable.
 * @param {string|number} value Cell value.
 * @returns {string} CSV-safe representation.
 */
function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Builds the calendar: `days` consecutive days ending YESTERDAY, local time.
 * Ending yesterday keeps every generated row in the past for any as-of window.
 * @param {number} days Day count.
 * @param {Date} [endDate] Reference date (defaults to now).
 * @returns {Array<{date: string, dayFirst: string, progress: number, isWeekend: boolean}>}
 *   progress runs 0 → 1 across the window, used for the struggling trend.
 */
function buildCalendar(days, endDate = new Date()) {
  const last = addDays(endDate, -1);
  const first = addDays(last, -(days - 1));
  const calendar = [];

  for (let index = 0; index < days; index++) {
    const date = addDays(first, index);
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    calendar.push({
      date: toIsoDate(date),
      dayFirst: toDayFirstDate(date),
      progress: days === 1 ? 1 : index / (days - 1),
      isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    });
  }
  return calendar;
}

/**
 * Draws the catalogue for one file. Names and SKUs are deliberately generic
 * (Item 001 / SKU-001) so no industry vocabulary leaks into the demo data.
 * @param {object} prng Seeded sampler bundle from createPrng().
 * @param {number} skuCount How many products to draw.
 * @returns {Array<{sku: string, name: string, baseMean: number, unitPrice: number,
 *                  unitCost: number, stockoutFrom: number|null}>} The catalogue.
 */
function buildCatalogue(prng, skuCount) {
  const catalogue = [];
  for (let index = 0; index < skuCount; index++) {
    const unitPrice = round2(prng.uniform(60, 900));
    catalogue.push({
      sku: `SKU-${pad(index + 1, 3)}`,
      name: `Item ${pad(index + 1, 3)}`,
      baseMean: prng.uniform(8, 45),
      unitPrice,
      unitCost: round2(unitPrice * prng.uniform(0.45, 0.7)),
      stockoutFrom: null,
    });
  }
  return catalogue;
}

/**
 * Generates one sales file's rows.
 *
 * Model per product-day:
 *   expected = baseMean × weekend × trend,  units = round(expected + N(0, 1.2·√expected))
 * where trend is 1 for `healthy` and 1 + 0.85·progress for `struggling`. A
 * struggling SKU whose stockout window has begun gets 0 units (i.e. no row, see
 * the file header) rather than a negative number.
 *
 * @param {'healthy'|'struggling'|'messy'} kind Which scenario to draw.
 * @param {{dayCount: number, skuCount: number, seed: number, endDate?: Date}} options Sizing.
 * @returns {{kind: string, seed: number, calendar: Array, catalogue: Array,
 *            rows: Array<{date: string, dayFirst: string, sku: string, name: string,
 *                         units: number, unitPrice: number, unitCost: number}>,
 *            skippedZero: number}} Generated rows and the counts a manifest needs.
 */
function generateSales(kind, options) {
  const { dayCount, skuCount, seed, endDate = new Date() } = options;
  const prng = createPrng(seed);
  const calendar = buildCalendar(dayCount, endDate);
  const catalogue = buildCatalogue(prng, skuCount);

  if (kind === 'struggling') {
    // Demand climbs all window; part of the catalogue then runs dry for the last
    // few days — that combination is what "rising stockout risk" looks like.
    for (const product of catalogue) {
      if (prng.rand() < STOCKOUT_SKU_SHARE) {
        product.stockoutFrom = dayCount - prng.randInt(1, 5);
      }
    }
  }

  const rows = [];
  let skippedZero = 0;

  calendar.forEach((day, dayIndex) => {
    for (const product of catalogue) {
      const trend = kind === 'struggling' ? 1 + TREND_STRENGTH * day.progress : 1;
      const expected = product.baseMean * trend * (day.isWeekend ? WEEKEND_MULTIPLIER : 1);

      if (product.stockoutFrom !== null && dayIndex >= product.stockoutFrom) {
        skippedZero += 1; // stocked out: no sale to record
        continue;
      }

      const units = Math.max(0, Math.round(expected + prng.normal() * 1.2 * Math.sqrt(expected)));
      if (units === 0) {
        skippedZero += 1;
        continue;
      }

      rows.push({
        date: day.date,
        dayFirst: day.dayFirst,
        sku: product.sku,
        name: product.name,
        units,
        unitPrice: product.unitPrice,
        unitCost: product.unitCost,
      });
    }
  });

  return { kind, seed, calendar, catalogue, rows, skippedZero };
}

/**
 * Renders the canonical sales CSV (the header bakery:prepare writes too).
 * @param {Array<object>} rows Generated rows.
 * @returns {string} CSV text with a trailing newline.
 */
function renderSalesCsv(rows) {
  const lines = [SALES_HEADER.join(',')];
  for (const row of rows) {
    lines.push([
      row.date, row.sku, row.name, row.units,
      row.unitPrice.toFixed(2), row.unitCost.toFixed(2),
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Renders the matching stock-count CSV: 0–3 days of cover per SKU, derived from
 * that SKU's own last-seven-day velocity, so the count is internally consistent
 * with the sales file rather than a random number.
 * @param {object} dataset Output of generateSales('struggling').
 * @returns {{csv: string, rows: Array<{sku: string, quantity: number}>}} CSV and the drawn rows.
 */
function renderStockCsv(dataset) {
  const { calendar, catalogue, rows } = dataset;
  const prng = createPrng(dataset.seed + 7919); // separate stream: catalogue stays stable
  const lastSeven = calendar.slice(-7).map((day) => day.date);
  const unitsBySkuDay = new Map();
  for (const row of rows) unitsBySkuDay.set(`${row.sku}|${row.date}`, row.units);

  const countDate = calendar[calendar.length - 1].date;
  const drawn = catalogue.map((product) => {
    const sold = lastSeven.reduce((sum, date) => sum + (unitsBySkuDay.get(`${product.sku}|${date}`) ?? 0), 0);
    const dailyVelocity = sold / lastSeven.length;
    const coverDays = prng.randInt(0, 3);
    return { sku: product.sku, quantity: Math.round(dailyVelocity * coverDays) };
  });

  const lines = [STOCK_HEADER.join(',')];
  for (const row of drawn) {
    lines.push([row.sku, '', row.quantity, countDate].map(csvCell).join(','));
  }
  return { csv: `${lines.join('\n')}\n`, rows: drawn };
}

/**
 * Renders the "messy" file: different header wording, DD/MM/YYYY dates, a
 * status column with cancelled/refunded rows, no unit cost, and exactly five
 * rows that must be rejected. The rejected rows are deliberate: a demo that
 * only ever shows 0 failures does not prove the validator does anything.
 * @param {object} dataset Output of generateSales('messy').
 * @returns {{csv: string, cancelled: number, refunded: number, badRows: number}} CSV and counts.
 */
function renderMessyCsv(dataset) {
  const prng = createPrng(dataset.seed + 104729);
  const sampleDate = dataset.calendar[dataset.calendar.length - 1].dayFirst;
  const body = [];
  let cancelled = 0;
  let refunded = 0;

  for (const row of dataset.rows) {
    const draw = prng.rand();
    let status = 'COMPLETED';
    if (draw < REFUNDED_SHARE) {
      status = MESSY_REFUNDED;
      refunded += 1;
    } else if (draw < REFUNDED_SHARE + CANCELLED_SHARE) {
      status = MESSY_CANCELLED;
      cancelled += 1;
    }
    body.push([
      row.dayFirst, row.sku, row.name, row.units, row.unitPrice.toFixed(2),
      status, STORE_LABEL,
    ].map(csvCell).join(','));
  }

  const badRows = [
    ['31/02/2026', 'SKU-001', 'Item 001', '3', '120.00', 'COMPLETED', STORE_LABEL], // no such date
    [sampleDate, 'SKU-002', 'Item 002', 'n/a', '80.00', 'COMPLETED', STORE_LABEL],   // quantity not a number
    [sampleDate, 'SKU-003', 'Item 003', '2', '-45.00', 'COMPLETED', STORE_LABEL],    // negative price
    [sampleDate, '', '', '4', '99.00', 'COMPLETED', STORE_LABEL],                    // neither SKU nor name
    [sampleDate, 'SKU-004', 'Item 004', '0', '99.00', 'COMPLETED', STORE_LABEL],     // zero units
  ];
  const step = Math.floor(body.length / (badRows.length + 1));
  if (badRows.length !== BAD_ROW_TOTAL) {
    throw new Error(`expected ${BAD_ROW_TOTAL} deliberate bad rows, built ${badRows.length}`);
  }
  badRows.forEach((row, index) => {
    body.splice(step * (index + 1) + index, 0, row.map(csvCell).join(','));
  });

  return {
    csv: `${[MESSY_HEADER.join(','), ...body].join('\n')}\n`,
    cancelled,
    refunded,
    badRows: badRows.length,
  };
}

/**
 * Parses `--days --skus --seed --out` (and `--help`).
 * @param {string[]} argv Arguments after the script path.
 * @returns {{help: boolean, days: number, skus: number, seed: number, out: string}} Options.
 * @throws {Error} On an unknown flag or a value outside its supported range.
 */
export function parseArgs(argv) {
  const options = { ...DEFAULTS, help: false };
  const numericFlags = { '--days': 'days', '--skus': 'skus', '--seed': 'seed' };

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      continue;
    }
    if (flag === '--out') {
      const value = argv[index + 1];
      if (!value) throw new Error('--out needs a directory');
      options.out = value;
      index += 1;
      continue;
    }
    const key = numericFlags[flag];
    if (!key) throw new Error(`unknown flag "${flag}" (try --help)`);
    const value = Number.parseInt(argv[index + 1], 10);
    if (!Number.isInteger(value)) throw new Error(`${flag} needs an integer`);
    options[key] = value;
    index += 1;
  }

  for (const [name, [min, max]] of Object.entries(LIMITS)) {
    if (options[name] < min || options[name] > max) {
      throw new Error(`--${name} must be between ${min} and ${max}`);
    }
  }
  return options;
}

/** Prints the usage block. */
function usage() {
  console.log(`
  Generates three upload-ready synthetic sales files (+ one stock count).

  Usage: npm run demo:generate -- [--days N] [--skus N] [--seed N] [--out DIR]

    --days   days of history, ${LIMITS.days[0]}-${LIMITS.days[1]}   (default ${DEFAULTS.days}, ends yesterday)
    --skus   products in the catalogue, ${LIMITS.skus[0]}-${LIMITS.skus[1]}   (default ${DEFAULTS.skus})
    --seed   integer seed; the same seed writes byte-identical files (default ${DEFAULTS.seed})
    --out    output directory, resolved against the repository root (default ${DEFAULTS.out})

  Files written:
    sales_healthy.csv          canonical header, steady demand, 0 expected failures
    sales_struggling.csv       demand rising ~85 %, last days stocked out for part of the catalogue
    stockcount_struggling.csv  matching 0-3 days of cover per SKU
    sales_messy.csv            different headers, DD/MM/YYYY, status column, 5 deliberate bad rows
    manifest.json              row counts, seeds and what each file is meant to prove
`);
}


/**
 * Writes and reports the three datasets.
 * @param {{days: number, skus: number, seed: number, out: string}} options Parsed CLI options.
 * @returns {Promise<void>} Resolves once every file is on disk.
 */
async function main(options) {
  const outDir = path.resolve(REPO_ROOT, options.out);
  await mkdir(outDir, { recursive: true });

  const expectedRows = options.days * options.skus;
  const healthy = generateSales('healthy', {
    dayCount: options.days, skuCount: options.skus, seed: options.seed,
  });
  const struggling = generateSales('struggling', {
    dayCount: options.days, skuCount: options.skus, seed: options.seed + 1,
  });
  const messy = generateSales('messy', {
    dayCount: options.days, skuCount: options.skus, seed: options.seed + 2,
  });

  const healthyCsv = renderSalesCsv(healthy.rows);
  const strugglingCsv = renderSalesCsv(struggling.rows);
  const stock = renderStockCsv(struggling);
  const messyFile = renderMessyCsv(messy);

  const files = [
    ['sales_healthy.csv', healthyCsv],
    ['sales_struggling.csv', strugglingCsv],
    ['stockcount_struggling.csv', stock.csv],
    ['sales_messy.csv', messyFile.csv],
  ];
  for (const [name, text] of files) {
    await writeFile(path.join(outDir, name), text, 'utf8');
  }

  const onHand = stock.rows.map((row) => row.quantity);
  const manifest = {
    generatedAt: new Date().toISOString(),
    params: { days: options.days, skus: options.skus, seed: options.seed, out: options.out },
    files: {
      'sales_healthy.csv': {
        seed: healthy.seed, rowsWritten: healthy.rows.length, expectedRows,
        skippedZeroUnitDays: healthy.skippedZero,
        purpose: 'clean import: 0 rows failed',
      },
      'sales_struggling.csv': {
        seed: struggling.seed, rowsWritten: struggling.rows.length, expectedRows,
        skippedZeroUnitDays: struggling.skippedZero,
        purpose: 'rising demand (+85 % day 1 to last day) plus end-of-window stockouts: stockout risk must rise',
      },
      'stockcount_struggling.csv': {
        rowsWritten: stock.rows.length,
        minOnHand: Math.min(...onHand), maxOnHand: Math.max(...onHand),
        purpose: '0-3 days of cover per SKU, matching sales_struggling.csv',
      },
      'sales_messy.csv': {
        seed: messy.seed, rowsWritten: expectedRows - messy.skippedZero,
        skippedZeroUnitDays: messy.skippedZero,
        cancelledRows: messyFile.cancelled, refundedRows: messyFile.refunded,
        deliberateBadRows: messyFile.badRows,
        purpose: 'flexible mapping: aliased headers, DD/MM/YYYY, skipped statuses, 5 rejected rows',
      },
    },
  };
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const show = (label, written, extra) => console.log(
    `  ${label.padEnd(26)} ${String(written).padStart(6)} rows  ${extra}`,
  );
  console.log(`\nSynthetic files -> ${outDir}`);
  show('sales_healthy.csv', healthy.rows.length, 'steady demand, canonical header');
  show('sales_struggling.csv', struggling.rows.length, 'demand rising all window, end-of-window stockouts');
  show('stockcount_struggling.csv', stock.rows.length, `0-3 days of cover (${Math.min(...onHand)}-${Math.max(...onHand)} units)`);
  show('sales_messy.csv', expectedRows - messy.skippedZero + messyFile.badRows, `${messyFile.cancelled} cancelled, ${messyFile.refunded} refunded, ${messyFile.badRows} bad rows`);
  console.log(`  manifest.json              seeds ${options.seed}, ${options.seed + 1}, ${options.seed + 2}; ${options.days} days, ${options.skus} SKUs\n`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();

if (invokedDirectly) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`\n  ${error.message}\n`);
    usage();
    process.exit(1);
  }

  if (options.help) {
    usage();
  } else {
    await main(options);
  }
}

export { buildCalendar, generateSales, renderSalesCsv, renderStockCsv, renderMessyCsv, main };

