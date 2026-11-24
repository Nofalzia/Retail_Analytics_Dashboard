/**
 * scripts/validation/forecastBacktest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 backtest for the demand forecaster: does Holt-Winters actually beat
 * the velocity baseline Stockout Watch ships with today?
 *
 * THE DATA IS THE POINT. This script answers that question on the REAL London
 * Bakers workbook — 13,544 point-of-sale lines over 35 calendar days
 * (2026-09-01 .. 2026-10-05) — and on DEV FOLDS ONLY. The last week
 * (2026-09-29 .. 2026-10-05) is SEALED: the script refuses a dev window that
 * touches it, and rows from that week are dropped at read time, so they never
 * reach the grid a method can see.
 *
 * An earlier run of this script was pointed at London_Bakers_Dataset.xlsx, an
 * EXTRAPOLATED 731-day series. Its numbers are not evidence about accuracy, and
 * the guards below exist so that mistake aborts instead of producing a report:
 *
 *   --data-kind real (default)
 *       ABORTS unless the workbook spans 2026-09-01 .. 2026-10-05, has fewer
 *       than 50,000 rows and no more than 35 distinct days. Real data is never
 *       date-shifted (--end-date is refused) and rows outside the dev window are
 *       discarded before aggregation. Writes forecast_backtest_*.csv/json.
 *
 *   --data-kind synthetic
 *       For the extrapolated series only. No coverage guard, dates may be
 *       shifted onto --end-date, and EVERY output file is suffixed _synthetic
 *       and carries a "NOT ACCURACY EVIDENCE" banner.
 *
 * Runs from backend/:
 *   node scripts/validation/forecastBacktest.js --input "<Real London Bakers 5 Week Performance.xlsx>"
 *   npm run validate:forecast -- --input "<Real London Bakers 5 Week Performance.xlsx>"
 *
 * What it does:
 *   1. reads sheet "POS Sales Log" cell by cell, keeps rows with a parseable
 *      date, Quantity > 0 and a SKU (the real export has no Status column; when
 *      one exists, Status = COMPLETED is applied), and aggregates
 *      SUM(Quantity) per (SKU, day) — the shape sale_transactions stores;
 *   2. lays that on a dense (SKU x calendar day) grid over the dev window, zero
 *      for a day with no sale;
 *   3. runs 7 rolling-origin folds with EXPANDING training windows: origins
 *      2026-09-21 .. 2026-09-27 (one per day), each training on every day from
 *      2026-09-01 up to its origin (21 to 27 days), each projecting 7 days and
 *      scored only on days inside the dev window — so fold 1 is scored on 7 days
 *      and fold 7 on 1;
 *   4. scores WAPE (headline), MAE and signed bias pooled, per fold, per horizon
 *      bucket (h1-3 / h4-7) and per top-10 SKU, against the Poisson noise floor
 *      of the data itself;
 *   5. pairs every method against the seasonal-naive baseline (M1) on the same
 *      SKU-day and reports a seeded BLOCK bootstrap over calendar days: horizons
 *      overlap inside a fold and all SKUs share a day, so the calendar day — not
 *      the SKU-day — is the independent unit;
 *   6. reports the store's weekday pattern (SUM of units per day) as context for
 *      why a seasonal method does or does not pay off on five weeks of data.
 *
 * Methods
 *   M1 seasonal naive     — same weekday last week
 *   M2 moving average     — mean of the last 7 training days, flat
 *   M3 velocity           — the production baseline: mean of the 14 days before
 *                           the origin (src/services/forecastService.js)
 *   M4 Holt-Winters grid  — src/services/holtWinters.js, in-service parameter
 *                           grid search, i.e. exactly what the API would serve
 *   M5 Holt-Winters fixed — the same estimator with beta = 0 and (alpha, gamma)
 *                           drawn from a preset list fixed before the run
 *   M6 weekday profile    — store-level weekday index applied to each SKU's level
 *
 * Outputs (default: docs/validation/, all suffixed _synthetic for synthetic runs)
 *   forecast_backtest_metrics.csv         pooled + bucket metrics per method
 *   forecast_backtest_by_fold.csv         the same per fold
 *   forecast_backtest_top10_skus.csv      secondary per-SKU table
 *   forecast_backtest_weekday_pattern.csv store weekday pattern (SUM per day)
 *   forecast_backtest_observations.csv    one row per fold x SKU x scored day
 *   forecast_backtest_params.csv          the parameters M4 picked, per fold and SKU
 *   forecast_backtest_raw.json            everything above, machine-readable
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import {
  SEASON_LENGTH,
  forecastHoltWinters,
} from '../../src/services/holtWinters.js';
import { velocityAverage } from '../../src/services/forecastService.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** The sheet the task names, and the only one read. */
const SHEET_NAME = 'POS Sales Log';

// ─────────────────────────────────────────────────────────────────────────────
// Data-kind guards
// ─────────────────────────────────────────────────────────────────────────────

/** The only two kinds of input this script will touch. */
const DATA_KINDS = Object.freeze(['real', 'synthetic']);

/** What the real workbook covers. A file outside this span is not that workbook. */
const REAL_COVERAGE = Object.freeze({ start: '2026-09-01', end: '2026-10-05' });

/** The real export is 13,544 lines; the extrapolated one is 304,614. */
const REAL_MAX_ROWS = 50_000;

/** Five weeks of daily sales, no more. */
const REAL_MAX_DAYS = 35;

/** Where a synthetic series is shifted to, so it lines up with the seeded tenant. */
const SYNTHETIC_END_DATE = '2026-10-12';

// ─────────────────────────────────────────────────────────────────────────────
// The protocol — fixed before any number in this file was produced
// ─────────────────────────────────────────────────────────────────────────────

/** Dev folds span these days — four weeks, method selection happens here. */
const DEFAULT_DEV_START = '2026-09-01';
const DEFAULT_DEV_END = '2026-09-28';

/** SEALED. A dev window touching these days is refused and their rows are dropped. */
const HOLD_OUT_START = '2026-09-29';
const HOLD_OUT_END = '2026-10-05';

/** Seven origins, one per day: the last week of the dev window seeds them. */
const FOLD_ORIGIN_START = '2026-09-21';
const FOLD_ORIGIN_END = '2026-09-27';

/** Expanding training windows: at least three weeks before the first origin. */
const MIN_TRAIN_DAYS = 21;

/** The production forecast window; a fold uses what it has, never more. */
const MAX_HISTORY_DAYS = 28;

/** The production velocity window (routes/stockout.js default). */
const VELOCITY_DAYS = 14;

/** Days projected per fold: one retail week. */
const HORIZON_DAYS = SEASON_LENGTH;

/** Horizon buckets reported alongside the pooled numbers. */
const BUCKETS = [
  { label: 'h1-3', from: 1, to: 3 },
  { label: 'h4-7', from: 4, to: 7 },
];

/** How many SKUs the secondary table shows. */
const TOP_SKU_COUNT = 10;

/** Weekday names, indexed the way Date#getUTCDay indexes them. */
const WEEKDAY_NAMES = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);

/**
 * M5's preset list — fixed BEFORE the run, beta pinned to 0 because a 21–27 day
 * series carries almost no evidence for a trend.
 */
const M5_PRESETS = Object.freeze(
  [0.2, 0.3, 0.5].flatMap((alpha) => (
    [0.2, 0.3, 0.5].map((gamma) => Object.freeze({ alpha, beta: 0, gamma }))
  )),
);

/** Bootstrap size and seed: fixed, so the interval is reproducible. */
const BOOTSTRAP_DRAWS = 2000;
const BOOTSTRAP_SEED = 20260917;

// ─────────────────────────────────────────────────────────────────────────────
// Arguments and dates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parses `--key value` pairs (also accepts `--key=value`).
 * @param {string[]} argv Process arguments after the script name.
 * @returns {Record<string, string|true>}
 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    if (inlineValue !== undefined) {
      args[rawKey] = inlineValue;
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) {
      args[rawKey] = argv[i + 1];
      i += 1;
    } else {
      args[rawKey] = true;
    }
  }
  return args;
}

/** @returns {string} `value` if it is an ISO date, otherwise throws. */
function requireIsoDate(label, value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`--${label} must be a YYYY-MM-DD date (got "${value}")`);
  }
  return value;
}

/** @returns {string} `isoDate` shifted by `deltaDays`, as YYYY-MM-DD. */
function shiftIsoDate(isoDate, deltaDays) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

/** @returns {number} Whole days from `fromIso` to `toIso` (positive when later). */
function daysBetween(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** @returns {string[]} Every ISO date from `startIso` to `endIso`, inclusive. */
function isoDatesBetween(startIso, endIso) {
  const dates = [];
  for (let date = startIso; date <= endIso; date = shiftIsoDate(date, 1)) dates.push(date);
  return dates;
}

/** @returns {number} 0 = Sunday … 6 = Saturday, read in UTC (no local-time drift). */
function isoWeekday(isoDate) {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

/** @returns {string} A count with thousands separators, for the banner. */
function grouped(value) {
  return Number(value).toLocaleString('en-GB');
}

/**
 * Column names are matched the way the import pipeline matches them:
 * lowercase, trimmed, inner whitespace collapsed, any parenthesised unit dropped.
 * @param {unknown} raw Cell text from the sheet's first row.
 * @returns {string}
 */
function normaliseHeader(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the workbook
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads sheet "POS Sales Log" and aggregates SUM(Quantity) per (SKU, date).
 *
 * Cells are read one at a time rather than through sheet_to_json: a large export
 * is hundreds of thousands of line items, and touching only the columns this
 * script needs keeps peak memory flat.
 *
 * Filters, in order: a parseable ISO date, a non-empty SKU, Status = COMPLETED
 * when the sheet has a Status column (the real export does not), Quantity > 0.
 * Rows that pass but fall outside `[windowStart, windowEnd]` are counted and
 * DISCARDED — that is what keeps the sealed hold-out week out of the grid.
 *
 * @param {string} filePath Absolute path to the workbook.
 * @param {{windowStart: string|null, windowEnd: string|null}} [options] Inclusive
 *   window for aggregation; null means "every valid row".
 * @returns {{
 *   rowsInSheet: number, rowsValid: number, rowsAggregated: number,
 *   outsideWindow: number, excluded: Record<string, number>,
 *   units: Map<string, Map<string, number>>, productNames: Map<string, string>,
 *   categories: Map<string, string>, pairCount: number,
 *   fileFacts: {firstDate: string|null, lastDate: string|null, distinctDays: number},
 *   windowFacts: {firstDate: string|null, lastDate: string|null, distinctDays: number},
 *   hasStatusColumn: boolean, sheets: string[],
 * }}
 */
function readPosSheet(filePath, options = {}) {
  const { windowStart = null, windowEnd = null } = options;
  const workbook = XLSX.readFile(filePath);
  const sheet = workbook.Sheets[SHEET_NAME];
  if (!sheet) {
    throw new Error(`sheet "${SHEET_NAME}" not found — sheets: ${workbook.SheetNames.join(', ')}`);
  }

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const cellAt = (row, col) => sheet[XLSX.utils.encode_cell({ r: row, c: col })];
  const cellText = (row, col) => {
    const cell = cellAt(row, col);
    if (!cell) return '';
    if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10);
    return String(cell.w ?? cell.v ?? '').trim();
  };

  // Header row → column indexes. Only date, sku and quantity are mandatory.
  const headerRow = range.s.r;
  const columns = {};
  for (let col = range.s.c; col <= range.e.c; col += 1) {
    const key = normaliseHeader(cellText(headerRow, col));
    if (key === 'date') columns.date = col;
    else if (key === 'sku') columns.sku = col;
    else if (key === 'quantity') columns.quantity = col;
    else if (key === 'status') columns.status = col;
    else if (key === 'item name') columns.itemName = col;
    else if (key === 'category') columns.category = col;
  }
  for (const required of ['date', 'sku', 'quantity']) {
    if (columns[required] === undefined) {
      throw new Error(`sheet "${SHEET_NAME}" has no "${required}" column`);
    }
  }

  const units = new Map();
  const productNames = new Map();
  const categories = new Map();
  const excluded = {
    status_not_completed: 0, quantity_not_positive: 0, bad_date: 0, missing_sku: 0,
  };
  const fileDates = new Set();
  const windowDates = new Set();
  let rowsInSheet = 0;
  let rowsValid = 0;
  let rowsAggregated = 0;
  let outsideWindow = 0;
  let pairCount = 0;
  let fileFirst = null;
  let fileLast = null;

  for (let row = headerRow + 1; row <= range.e.r; row += 1) {
    rowsInSheet += 1;

    if (columns.status !== undefined) {
      const status = cellText(row, columns.status).toUpperCase();
      if (status !== 'COMPLETED') { excluded.status_not_completed += 1; continue; }
    }

    const date = cellText(row, columns.date);
    const sku = cellText(row, columns.sku);
    const quantity = Number(cellAt(row, columns.quantity)?.v);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { excluded.bad_date += 1; continue; }
    if (!sku) { excluded.missing_sku += 1; continue; }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      excluded.quantity_not_positive += 1;
      continue;
    }

    rowsValid += 1;
    fileDates.add(date);
    if (fileFirst === null || date < fileFirst) fileFirst = date;
    if (fileLast === null || date > fileLast) fileLast = date;

    if (windowStart !== null && (date < windowStart || date > windowEnd)) {
      outsideWindow += 1;
      continue;
    }

    let byDate = units.get(sku);
    if (!byDate) {
      byDate = new Map();
      units.set(sku, byDate);
    }
    if (!byDate.has(date)) pairCount += 1;
    byDate.set(date, (byDate.get(date) ?? 0) + quantity);

    if (columns.itemName !== undefined && !productNames.has(sku)) {
      productNames.set(sku, cellText(row, columns.itemName));
    }
    if (columns.category !== undefined && !categories.has(sku)) {
      categories.set(sku, cellText(row, columns.category));
    }
    windowDates.add(date);
    rowsAggregated += 1;
  }

  const sortedWindowDates = [...windowDates].sort();

  return {
    rowsInSheet,
    rowsValid,
    rowsAggregated,
    outsideWindow,
    excluded,
    units,
    productNames,
    categories,
    pairCount,
    fileFacts: {
      firstDate: fileFirst,
      lastDate: fileLast,
      distinctDays: fileDates.size,
    },
    windowFacts: {
      firstDate: sortedWindowDates[0] ?? null,
      lastDate: sortedWindowDates[sortedWindowDates.length - 1] ?? null,
      distinctDays: windowDates.size,
    },
    hasStatusColumn: columns.status !== undefined,
    sheets: workbook.SheetNames,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input guards — the wrong workbook must abort, not become a report
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proves the workbook is the real five-week export before anything is computed.
 *
 * The check that matters is the SPAN: an extrapolated series of 731 days cannot
 * sneak through as 35 days, and a file that starts after the dev window cannot
 * be scored on it. Row count and day count are belt-and-braces.
 *
 * @param {{parsed: ReturnType<typeof readPosSheet>, devStart: string, devEnd: string}} input
 * @returns {Array<{label: string, detail: string, pass: boolean}>}
 */
function realDataChecks({ parsed, devStart, devEnd }) {
  const { fileFacts, rowsInSheet } = parsed;
  return [
    {
      label: 'rows in sheet',
      detail: `${grouped(rowsInSheet)} must be < ${grouped(REAL_MAX_ROWS)}`,
      pass: rowsInSheet > 0 && rowsInSheet < REAL_MAX_ROWS,
    },
    {
      label: 'first date',
      detail: `${fileFacts.firstDate} must be >= ${REAL_COVERAGE.start}`,
      pass: Boolean(fileFacts.firstDate && fileFacts.firstDate >= REAL_COVERAGE.start),
    },
    {
      label: 'last date',
      detail: `${fileFacts.lastDate} must be <= ${REAL_COVERAGE.end}`,
      pass: Boolean(fileFacts.lastDate && fileFacts.lastDate <= REAL_COVERAGE.end),
    },
    {
      label: 'distinct days',
      detail: `${fileFacts.distinctDays} must be <= ${REAL_MAX_DAYS}`,
      pass: fileFacts.distinctDays > 0 && fileFacts.distinctDays <= REAL_MAX_DAYS,
    },
    {
      label: 'covers dev window',
      detail: `file must start on or before ${devStart} and reach ${devEnd}`,
      pass: Boolean(
        fileFacts.firstDate && fileFacts.firstDate <= devStart
        && fileFacts.lastDate && fileFacts.lastDate >= devEnd,
      ),
    },
  ];
}

/**
 * Aborts a --data-kind real run whose workbook is not the real five-week export.
 * @param {Array<{label: string, detail: string, pass: boolean}>} checks
 * @returns {void}
 * @throws {Error} Listing every failed check.
 */
function assertRealData(checks) {
  const failed = checks.filter((check) => !check.pass);
  if (failed.length === 0) return;
  const lines = failed.map((check) => `  - ${check.label}: ${check.detail}`);
  throw new Error(
    'the workbook does not look like the real London Bakers export '
    + `(${REAL_COVERAGE.start} .. ${REAL_COVERAGE.end}, < ${grouped(REAL_MAX_ROWS)} rows, `
    + `<= ${REAL_MAX_DAYS} days):\n${lines.join('\n')}\n`
    + 'An extrapolated 731-day series (London_Bakers_Dataset.xlsx) is NOT accuracy evidence. '
    + 'Re-run with --data-kind synthetic if that is genuinely what you mean to measure.',
  );
}

/**
 * Prints what was read, what it is, and whether it passed the guards — before a
 * single metric is computed, so the reader can see the input the numbers rest on.
 * @param {{parsed: ReturnType<typeof readPosSheet>, dataKind: string, inputPath: string,
 *   devStart: string, devEnd: string,
 *   checks: Array<{label: string, detail: string, pass: boolean}>}} input
 * @returns {void}
 */
function printDataBanner({ parsed, dataKind, inputPath, devStart, devEnd, checks }) {
  const isReal = dataKind === 'real';
  console.log('\n── Data banner ────────────────────────────────────────────────');
  console.log(
    isReal
      ? '  DATA KIND     : REAL — real point-of-sale export (accuracy evidence)'
      : '  DATA KIND     : SYNTHETIC — NOT ACCURACY EVIDENCE',
  );
  console.log(`  workbook      : ${inputPath}`);
  console.log(`  sheet         : "${SHEET_NAME}"  (sheets: ${parsed.sheets.join(', ')})`);
  console.log(`  status column : ${parsed.hasStatusColumn ? 'yes — COMPLETED only' : 'none (no status filter applied)'}`);
  console.log(`  rows in sheet : ${grouped(parsed.rowsInSheet)} (${grouped(parsed.rowsValid)} valid lines)`);
  console.log(`  rows used     : ${grouped(parsed.rowsAggregated)} inside ${devStart} .. ${devEnd}`);
  console.log(`  rows dropped  : ${grouped(parsed.outsideWindow)} outside the dev window (never enter the grid)`);
  console.log(
    `  distinct days : ${parsed.fileFacts.distinctDays} in file · ` +
    `${parsed.windowFacts.distinctDays} used`,
  );
  console.log(
    `  date range    : ${parsed.fileFacts.firstDate} .. ${parsed.fileFacts.lastDate} in file · ` +
    `${parsed.windowFacts.firstDate} .. ${parsed.windowFacts.lastDate} used`,
  );
  console.log(`  SKUs          : ${parsed.units.size} · (SKU, day) pairs ${grouped(parsed.pairCount)}`);
  for (const check of checks) {
    console.log(`  guard ${check.pass ? 'PASS' : 'FAIL'}   : ${check.label} — ${check.detail}`);
  }
  if (!isReal) {
    console.log('  !! NOT ACCURACY EVIDENCE — every output file is suffixed _synthetic');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Methods — every one of them sees only its own fold's training days
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {number} Arithmetic mean (0 for an empty list). */
function mean(values) {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

/** @returns {number[]} The same value repeated `horizon` times. */
function flatForecast(value, horizon) {
  return new Array(horizon).fill(value);
}

/**
 * M1 — seasonal naive: the same weekday one week earlier.
 * @param {number[]} values Training series, oldest first.
 * @param {number} lastIndex Index of the fold's origin day inside `values`.
 * @param {number} horizon Days to project.
 * @returns {number[]}
 */
function seasonalNaiveForecast(values, lastIndex, horizon) {
  const forecast = new Array(horizon);
  for (let h = 1; h <= horizon; h += 1) {
    forecast[h - 1] = values[lastIndex + h - SEASON_LENGTH];
  }
  return forecast;
}

/**
 * M2 — mean of the last `window` training days, held flat.
 * @param {number[]} values Training series, oldest first.
 * @param {number} lastIndex Index of the fold's origin day.
 * @param {number} window Days averaged.
 * @param {number} horizon Days to project.
 * @returns {number[]}
 */
function movingAverageForecast(values, lastIndex, window, horizon) {
  return flatForecast(mean(values.slice(lastIndex - window + 1, lastIndex + 1)), horizon);
}

/**
 * M6 — a store-level weekday index applied to each SKU's own level.
 *
 * The index is built from the store's TOTAL units per day, so it needs far less
 * data per bucket than a per-SKU weekday estimate, and then scales each product's
 * mean demand. It is the cheap "shared shape" alternative to Holt-Winters: one
 * shape for the store, one level per SKU.
 *
 * @param {number[]} values The SKU's training series.
 * @param {Float64Array} storeDaily Store-wide units per grid day.
 * @param {string[]} dates Grid dates.
 * @param {number} lastIndex Index of the fold's origin day.
 * @param {number} historyDays Training length (21 to 27 here).
 * @param {number} horizon Days to project.
 * @returns {number[]} One non-negative figure per projected day.
 */
function weekdayProfileForecast(values, storeDaily, dates, lastIndex, historyDays, horizon) {
  const sums = new Array(SEASON_LENGTH).fill(0);
  const counts = new Array(SEASON_LENGTH).fill(0);
  let total = 0;
  for (let i = lastIndex - historyDays + 1; i <= lastIndex; i += 1) {
    const weekday = isoWeekday(dates[i]);
    sums[weekday] += storeDaily[i];
    counts[weekday] += 1;
    total += storeDaily[i];
  }
  const overallMean = total / historyDays;
  const index = sums.map((sum, weekday) => (
    overallMean > 0 && counts[weekday] > 0 ? (sum / counts[weekday]) / overallMean : 1
  ));
  const level = mean(values);

  const forecast = new Array(horizon);
  for (let h = 1; h <= horizon; h += 1) {
    const weekday = isoWeekday(dates[lastIndex + h]);
    forecast[h - 1] = Math.max(0, level * index[weekday]);
  }
  return forecast;
}

/** M5 preset labels, e.g. M5_hw_a0.2_g0.3 (beta is 0 in every preset). */
const M5_KEYS = M5_PRESETS.map((preset) => `M5_hw_a${preset.alpha}_g${preset.gamma}`);

/** Every method, in the order the report shows them. */
const METHOD_KEYS = Object.freeze([
  'M1_seasonal_naive',
  'M2_ma7',
  'M3_velocity14',
  'M4_hw_grid',
  ...M5_KEYS,
  'M6_weekday_profile',
]);

/** Human labels for the results doc, kept next to the keys so they cannot drift. */
const METHOD_LABELS = Object.freeze({
  M1_seasonal_naive: 'M1 seasonal naive (same weekday last week)',
  M2_ma7: 'M2 7-day moving average (flat)',
  M3_velocity14: 'M3 velocity (14-day mean, flat) — production baseline',
  M4_hw_grid: 'M4 Holt-Winters, in-service grid search',
  M6_weekday_profile: 'M6 store weekday profile x SKU level',
  ...Object.fromEntries(
    M5_PRESETS.map((preset, i) => [
      M5_KEYS[i],
      `M5 Holt-Winters fixed a=${preset.alpha} b=0 g=${preset.gamma}`,
    ]),
  ),
});

/** Baseline every paired comparison is made against. */
const BASELINE_KEY = 'M1_seasonal_naive';

/** The engine that ships today — the reference an engine change has to beat. */
const INCUMBENT_KEY = 'M3_velocity14';

/** The method that would be served if FORECAST_ENGINE=holt_winters. */
const HOLT_WINTERS_KEY = 'M4_hw_grid';

// ─────────────────────────────────────────────────────────────────────────────
// The dense grid every method reads from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lays the parsed rows on a (SKU x calendar day) grid so each fold can slice any
 * window out of it without re-reading the file. A day with no sale is a real
 * zero-demand day, not missing data — that is what the zero fill means.
 *
 * @param {ReturnType<typeof readPosSheet>} parsed
 * @param {{startDate: string, endDate: string, shiftDays: number}} options
 *   `shiftDays` is 0 for real data (never shifted) and the alignment offset for a
 *   synthetic series.
 * @returns {{
 *   skus: string[], dates: string[], indexByDate: Map<string, number>,
 *   values: Map<string, Float64Array>, shiftDays: number, calendarDays: number,
 *   zeroCells: number, filledCells: number,
 * }}
 */
function buildGrid(parsed, { startDate, endDate, shiftDays }) {
  const dates = isoDatesBetween(startDate, endDate);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const skus = [...parsed.units.keys()].sort();
  const values = new Map();
  let zeroCells = 0;

  for (const sku of skus) {
    const series = new Float64Array(dates.length);
    for (const [sourceDate, units] of parsed.units.get(sku)) {
      const alignedDate = shiftIsoDate(sourceDate, shiftDays);
      const index = indexByDate.get(alignedDate);
      if (index === undefined) {
        throw new Error(`${sku}: date ${alignedDate} fell outside the grid ${startDate}..${endDate}`);
      }
      series[index] = units;
    }
    // Counting the zeros makes the "days without a sale" claim checkable in the docs.
    for (let index = 0; index < series.length; index += 1) {
      if (series[index] === 0) zeroCells += 1;
    }
    values.set(sku, series);
  }

  return {
    skus,
    dates,
    indexByDate,
    values,
    shiftDays,
    calendarDays: dates.length,
    zeroCells,
    filledCells: skus.length * dates.length - zeroCells,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Folds — expanding training windows, scored inside the dev window only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the seven expanding-window folds.
 *
 * Each fold trains on EVERY day from the grid's first day up to its origin (the
 * grid starts at the dev window's first day, so fold 1 has 21 days and fold 7 has
 * 27), then projects HORIZON_DAYS. Only days inside the dev window are scored, so
 * fold 1 is scored on 7 days and fold 7 on 1 — 28 scored days in total, no day
 * reused at the same horizon, and no day after 2026-09-28 ever touched.
 *
 * @param {ReturnType<typeof buildGrid>} grid
 * @param {{devEnd: string}} window
 * @returns {Array<{fold: number, origin: string, trainDays: number,
 *   trainingFrom: string, scoredDates: string[]}>}
 */
function buildFolds(grid, { devEnd }) {
  const origins = isoDatesBetween(FOLD_ORIGIN_START, FOLD_ORIGIN_END);
  const folds = [];

  origins.forEach((origin, index) => {
    const originIndex = grid.indexByDate.get(origin);
    if (originIndex === undefined) {
      throw new Error(`origin ${origin} is outside the grid ${grid.dates[0]}..${grid.dates[grid.dates.length - 1]}`);
    }
    const trainDays = Math.min(MAX_HISTORY_DAYS, originIndex + 1);
    if (trainDays < MIN_TRAIN_DAYS) {
      throw new Error(
        `fold ${index + 1}: origin ${origin} leaves only ${trainDays} training days ` +
        `(the protocol needs >= ${MIN_TRAIN_DAYS})`,
      );
    }
    const lastScored = shiftIsoDate(origin, HORIZON_DAYS) < devEnd
      ? shiftIsoDate(origin, HORIZON_DAYS)
      : devEnd;
    if (lastScored <= origin) {
      throw new Error(`fold ${index + 1} has no scored day: origin ${origin}, dev end ${devEnd}`);
    }
    if (lastScored > devEnd) {
      throw new Error(`fold ${index + 1} would score ${lastScored}, outside the dev window ending ${devEnd}`);
    }
    folds.push({
      fold: index + 1,
      origin,
      trainDays,
      trainingFrom: grid.dates[originIndex - trainDays + 1],
      scoredDates: isoDatesBetween(shiftIsoDate(origin, 1), lastScored),
    });
  });

  return folds;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running the folds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs every method on every fold and returns one observation per fold x SKU x
 * scored day, plus the parameters M4 picked.
 *
 * Nothing here reads a day after the fold's scored window, so a method cannot see
 * the future it is being judged on — the whole point of the exercise.
 *
 * @param {ReturnType<typeof buildGrid>} grid
 * @param {Float64Array} storeDaily Store-wide units per grid day (M6's shape).
 * @param {ReturnType<typeof buildFolds>} folds
 * @returns {{
 *   observations: Array<{fold: number, sku: string, date: string, horizon: number,
 *     actual: number, predictions: Record<string, number>}>,
 *   params: Array<{fold: number, sku: string, alpha: number, beta: number,
 *     gamma: number, sse: number, steps: number}>,
 *   hwFallbacks: number,
 * }}
 */
function runFolds(grid, storeDaily, folds) {
  const observations = [];
  const params = [];
  let hwFallbacks = 0;

  for (const { fold, origin, trainDays, scoredDates } of folds) {
    const originIndex = grid.indexByDate.get(origin);
    const trainingFrom = originIndex - trainDays + 1;
    if (trainingFrom < 0) {
      throw new Error(`fold ${fold}: origin ${origin} leaves fewer than ${trainDays} training days`);
    }
    const trainingDates = grid.dates.slice(trainingFrom, originIndex + 1);

    for (const sku of grid.skus) {
      const series = grid.values.get(sku);
      // The fold's training days, oldest first. A zero inside this slice is a day
      // the product did not sell, which is exactly what the models must learn from.
      const values = Array.from(series.subarray(trainingFrom, originIndex + 1));

      const m1 = seasonalNaiveForecast(values, trainDays - 1, HORIZON_DAYS);
      const m2 = movingAverageForecast(values, trainDays - 1, SEASON_LENGTH, HORIZON_DAYS);
      const m3 = flatForecast(
        velocityAverage({ dates: trainingDates, values }, origin, VELOCITY_DAYS),
        HORIZON_DAYS,
      );

      const gridFit = forecastHoltWinters(values, HORIZON_DAYS, { selection: 'grid' });
      let m4 = m3;
      if (gridFit) {
        m4 = gridFit.forecast;
        params.push({
          fold,
          sku,
          alpha: gridFit.params.alpha,
          beta: gridFit.params.beta,
          gamma: gridFit.params.gamma,
          sse: gridFit.sse,
          steps: trainDays - SEASON_LENGTH,
        });
      } else {
        hwFallbacks += 1;
      }

      const m5 = M5_PRESETS.map((preset) => (
        forecastHoltWinters(values, HORIZON_DAYS, { selection: 'fixed', params: preset })?.forecast ?? m3
      ));

      const m6 = weekdayProfileForecast(
        values, storeDaily, grid.dates, originIndex, trainDays, HORIZON_DAYS,
      );

      scoredDates.forEach((date, offset) => {
        const actual = series[grid.indexByDate.get(date)];
        const predictions = {
          M1_seasonal_naive: m1[offset],
          M2_ma7: m2[offset],
          M3_velocity14: m3[offset],
          M4_hw_grid: m4[offset],
          M6_weekday_profile: m6[offset],
        };
        M5_KEYS.forEach((key, i) => { predictions[key] = m5[i][offset]; });
        observations.push({ fold, sku, date, horizon: offset + 1, actual, predictions });
      });
    }
  }

  return { observations, params, hwFallbacks };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The selection rule, fixed before any number in this file was produced.
 * It is written into the JSON output so the rule and the result travel together.
 */
const SELECTION_RULE = [
  'Pick the method with the lowest pooled WAPE over the 7 expanding-window dev folds.',
  'Accept it only if its paired per-SKU-day absolute error minus M1 seasonal naive',
  'has a 95% block-bootstrap interval (calendar-day blocks) entirely below 0, i.e.',
  'it is reliably better. Otherwise record "no reliable improvement" and keep',
  'FORECAST_ENGINE = velocity. No preset, window or parameter is changed after these',
  'numbers are seen.',
].join(' ');

/** @returns {number} `value` rounded to `digits` decimals (null-safe). */
function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * WAPE (headline), MAE and signed bias for one method over one set of observations.
 *
 * WAPE is the sum of absolute errors over the sum of actuals: unlike MAPE it does
 * not explode on a zero-demand day, and this data has days where a product does
 * not sell at all.
 *
 * @param {Array<{actual: number, predictions: Record<string, number>}>} observations
 * @param {string} methodKey
 * @returns {{n: number, wapePct: number|null, mae: number|null,
 *   biasPct: number|null, meanActual: number|null}}
 */
function metricsFor(observations, methodKey) {
  let absError = 0;
  let actualSum = 0;
  let forecastSum = 0;
  for (const observation of observations) {
    const forecast = observation.predictions[methodKey];
    absError += Math.abs(forecast - observation.actual);
    actualSum += observation.actual;
    forecastSum += forecast;
  }
  const n = observations.length;
  return {
    n,
    wapePct: actualSum > 0 ? (100 * absError) / actualSum : null,
    mae: n > 0 ? absError / n : null,
    biasPct: actualSum > 0 ? (100 * (forecastSum - actualSum)) / actualSum : null,
    meanActual: n > 0 ? actualSum / n : null,
  };
}

/** @returns {() => number} A seeded PRNG (mulberry32) — same draws on every run. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Paired comparison against M1: for every SKU-day, the difference in ABSOLUTE
 * error (method minus baseline), averaged, with a seeded 95% interval.
 *
 * The interval is a BLOCK bootstrap over calendar days, not over SKU-days. Within
 * a fold the seven horizons are projections of one fit, and every SKU is observed
 * on the same day, so SKU-days are far from independent; the calendar day is the
 * unit that carries the shared shock. Each draw resamples the scored days with
 * replacement and pools every observation on the selected days, which keeps the
 * estimator identical to the point estimate (observation-weighted).
 *
 * Negative mean = the method is closer to the truth than the baseline. If the
 * interval straddles 0, the two are indistinguishable on this data and the honest
 * reading is "no reliable improvement".
 *
 * @param {Array<{date: string, actual: number, predictions: Record<string, number>}>} observations
 * @param {string} methodKey
 * @param {string} baselineKey
 * @returns {{meanDiffUnits: number, ci95: [number, number], includesZero: boolean,
 *   observations: number, blocks: number, blockUnit: string, blockSizes: number[],
 *   draws: number, seed: number, wins: number, losses: number, coarse: boolean}}
 */
function pairedBlockBootstrap(observations, methodKey, baselineKey) {
  const byDate = new Map();
  let totalDiff = 0;
  let wins = 0;
  let losses = 0;

  for (const observation of observations) {
    const diff = Math.abs(observation.predictions[methodKey] - observation.actual)
      - Math.abs(observation.predictions[baselineKey] - observation.actual);
    totalDiff += diff;
    if (diff < 0) wins += 1;
    else if (diff > 0) losses += 1;
    const block = byDate.get(observation.date) ?? { date: observation.date, sum: 0, count: 0 };
    block.sum += diff;
    block.count += 1;
    byDate.set(observation.date, block);
  }

  const blocks = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  const n = observations.length;
  const meanDiff = n > 0 ? totalDiff / n : 0;

  const rng = mulberry32(BOOTSTRAP_SEED);
  const draws = new Float64Array(BOOTSTRAP_DRAWS);
  for (let d = 0; d < BOOTSTRAP_DRAWS; d += 1) {
    let sum = 0;
    let count = 0;
    for (let b = 0; b < blocks.length; b += 1) {
      const block = blocks[Math.floor(rng() * blocks.length)];
      sum += block.sum;
      count += block.count;
    }
    draws[d] = count > 0 ? sum / count : 0;
  }
  draws.sort();
  const lower = draws[Math.floor(0.025 * (BOOTSTRAP_DRAWS - 1))];
  const upper = draws[Math.floor(0.975 * (BOOTSTRAP_DRAWS - 1))];

  return {
    meanDiffUnits: meanDiff,
    ci95: [lower, upper],
    includesZero: lower <= 0 && upper >= 0,
    observations: n,
    blocks: blocks.length,
    blockUnit: 'calendar day',
    blockSizes: blocks.map((block) => block.count),
    draws: BOOTSTRAP_DRAWS,
    seed: BOOTSTRAP_SEED,
    wins,
    losses,
    coarse: blocks.length < 10,
  };
}

/**
 * The Poisson noise floor: with independent Poisson demand around mean μ, even a
 * perfect forecast of μ has E|X - μ| = sqrt(2μ/π), so no method can push WAPE
 * below 100 * sqrt(2 / (π μ)). It is the yardstick the WAPE column is read against.
 * @param {number} meanUnits Mean actual units per SKU-day.
 * @returns {{meanUnitsPerSkuDay: number, wapeFloorPct: number|null}}
 */
function poissonNoiseFloor(meanUnits) {
  if (!Number.isFinite(meanUnits) || meanUnits <= 0) {
    return { meanUnitsPerSkuDay: meanUnits ?? null, wapeFloorPct: null };
  }
  return {
    meanUnitsPerSkuDay: meanUnits,
    wapeFloorPct: 100 * Math.sqrt(2 / (Math.PI * meanUnits)),
  };
}

/**
 * The store's weekday pattern, from SUM(units) per day — context for whether a
 * seasonal method has anything stable to learn.
 *
 * Five weeks is 5 observations per weekday at best (4 inside the dev window), so
 * the spread column matters as much as the index: a weekday whose four days range
 * from 537 to 691 units is not a seasonal signal you can bank.
 *
 * @param {Float64Array} storeDaily Store-wide units per grid day.
 * @param {string[]} dates Grid dates.
 * @returns {{
 *   days: number, overallMeanUnitsPerDay: number,
 *   perWeekday: Array<{weekday: string, weekdayIndex: number, days: number,
 *     meanUnitsPerDay: number|null, indexVsOverall: number|null,
 *     minUnits: number|null, maxUnits: number|null, cvPct: number|null}>,
 *   strongest: string|null, weakest: string|null,
 * }}
 */
function storeWeekdayPattern(storeDaily, dates) {
  const sums = new Array(SEASON_LENGTH).fill(0);
  const counts = new Array(SEASON_LENGTH).fill(0);
  const samples = Array.from({ length: SEASON_LENGTH }, () => []);
  let total = 0;

  dates.forEach((date, index) => {
    const weekday = isoWeekday(date);
    sums[weekday] += storeDaily[index];
    counts[weekday] += 1;
    samples[weekday].push(storeDaily[index]);
    total += storeDaily[index];
  });

  const overallMean = dates.length > 0 ? total / dates.length : 0;
  const perWeekday = WEEKDAY_NAMES.map((weekday, index) => {
    const values = samples[index];
    const weekdayMean = counts[index] > 0 ? sums[index] / counts[index] : null;
    let cvPct = null;
    if (values.length > 1 && weekdayMean > 0) {
      const variance = values.reduce((acc, value) => acc + (value - weekdayMean) ** 2, 0)
        / (values.length - 1);
      cvPct = (100 * Math.sqrt(variance)) / weekdayMean;
    }
    return {
      weekday,
      weekdayIndex: index,
      days: counts[index],
      meanUnitsPerDay: weekdayMean,
      indexVsOverall: overallMean > 0 && weekdayMean !== null ? weekdayMean / overallMean : null,
      minUnits: values.length > 0 ? Math.min(...values) : null,
      maxUnits: values.length > 0 ? Math.max(...values) : null,
      cvPct,
    };
  });

  const ranked = perWeekday
    .filter((row) => row.meanUnitsPerDay !== null)
    .sort((a, b) => b.meanUnitsPerDay - a.meanUnitsPerDay);

  return {
    days: dates.length,
    overallMeanUnitsPerDay: overallMean,
    perWeekday,
    strongest: ranked[0]?.weekday ?? null,
    weakest: ranked[ranked.length - 1]?.weekday ?? null,
  };
}

/** @returns {string} One CSV field, quoted only when it has to be. */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** @returns {string} A CSV document from a header list and row arrays. */
function toCsv(header, rows) {
  return [header, ...rows].map((row) => row.map(csvField).join(',')).join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// The backtest itself
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the folds, scores every method and decides what the numbers say.
 * @param {{parsed: ReturnType<typeof readPosSheet>, dataKind: string,
 *   devStart: string, devEnd: string, startDate: string, endDate: string,
 *   shiftDays: number}} input
 * @returns {object} Everything writeReports() and printSummary() need.
 */
function runBacktest({ parsed, dataKind, devStart, devEnd, startDate, endDate, shiftDays }) {
  const grid = buildGrid(parsed, { startDate, endDate, shiftDays });
  console.log('\n── Grid ───────────────────────────────────────────────────────');
  console.log(
    `  date shift     : ${grid.shiftDays === 0
      ? 'none (real data, never shifted)'
      : `+${grid.shiftDays} days (last source day → ${endDate})`}`,
  );
  console.log(
    `  aligned range  : ${grid.dates[0]} .. ${grid.dates[grid.dates.length - 1]} ` +
    `(${grid.calendarDays} days)`,
  );
  console.log(
    `  cells          : ${grid.filledCells} with units, ${grid.zeroCells} zero of ` +
    `${grid.skus.length * grid.calendarDays}`,
  );
  if (grid.dates[0] > devStart) {
    throw new Error(`the series starts at ${grid.dates[0]}, after the dev window ${devStart}`);
  }

  // Store-wide units per day: M6's shared weekday shape, and the weekday context table.
  const storeDaily = new Float64Array(grid.calendarDays);
  for (const sku of grid.skus) {
    const series = grid.values.get(sku);
    for (let index = 0; index < series.length; index += 1) storeDaily[index] += series[index];
  }
  const weekdayPattern = storeWeekdayPattern(storeDaily, grid.dates);

  const folds = buildFolds(grid, { devEnd });
  console.log('\n── Folds (expanding training windows) ─────────────────────────');
  for (const fold of folds) {
    const last = fold.scoredDates[fold.scoredDates.length - 1];
    console.log(
      `  fold ${fold.fold}: train ${fold.trainingFrom}..${fold.origin} (${fold.trainDays} days, ` +
      `HW updates ${fold.trainDays - SEASON_LENGTH}) → scored ${fold.scoredDates[0]}..${last} ` +
      `(${fold.scoredDates.length} days, h1..h${fold.scoredDates.length})`,
    );
  }

  const runStartedAt = Date.now();
  const { observations, params, hwFallbacks } = runFolds(grid, storeDaily, folds);
  console.log(
    `\n  scored SKU-days: ${observations.length} ` +
    `(${((Date.now() - runStartedAt) / 1000).toFixed(1)} s)`,
  );
  console.log(`  Holt-Winters fallbacks to velocity: ${hwFallbacks}`);

  const methods = METHOD_KEYS.map((key) => ({
    key, label: METHOD_LABELS[key], ...metricsFor(observations, key),
  }));
  const buckets = BUCKETS.map((bucket) => ({
    bucket: bucket.label,
    rows: methods.map(({ key }) => ({
      key,
      ...metricsFor(
        observations.filter((o) => o.horizon >= bucket.from && o.horizon <= bucket.to),
        key,
      ),
    })),
  }));
  const byFold = folds.map((fold) => ({
    fold: fold.fold,
    origin: fold.origin,
    trainDays: fold.trainDays,
    scoredFrom: fold.scoredDates[0],
    scoredTo: fold.scoredDates[fold.scoredDates.length - 1],
    scoredDays: fold.scoredDates.length,
    rows: methods.map(({ key }) => ({
      key, ...metricsFor(observations.filter((o) => o.fold === fold.fold), key),
    })),
  }));

  const skuTotals = new Map(grid.skus.map((sku) => [sku, 0]));
  for (const observation of observations) {
    skuTotals.set(observation.sku, skuTotals.get(observation.sku) + observation.actual);
  }
  const topSkus = [...skuTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SKU_COUNT)
    .map(([sku, actualUnits]) => ({
      sku,
      productName: parsed.productNames.get(sku) ?? '',
      actualUnits,
      rows: methods.map(({ key }) => ({
        key, ...metricsFor(observations.filter((o) => o.sku === sku), key),
      })),
    }));

  const bootstrap = METHOD_KEYS
    .filter((key) => key !== BASELINE_KEY)
    .map((key) => ({ key, ...pairedBlockBootstrap(observations, key, BASELINE_KEY) }));

  // The same paired test against the engine that is actually shipped today. The
  // selection rule above picks a METHOD; deciding whether to change an ENGINE also
  // needs to know whether the new engine beats the incumbent on the same SKU-days.
  const bootstrapVsIncumbent = METHOD_KEYS
    .filter((key) => key !== INCUMBENT_KEY)
    .map((key) => ({ key, ...pairedBlockBootstrap(observations, key, INCUMBENT_KEY) }));

  const noise = poissonNoiseFloor(mean(observations.map((o) => o.actual)));
  const ranked = [...methods].sort((a, b) => (a.wapePct ?? Infinity) - (b.wapePct ?? Infinity));
  const winner = ranked[0];
  const baseline = methods.find((entry) => entry.key === BASELINE_KEY);
  const incumbent = methods.find((entry) => entry.key === INCUMBENT_KEY);
  const holtWinters = methods.find((entry) => entry.key === HOLT_WINTERS_KEY);
  const winnerPaired = winner.key === BASELINE_KEY
    ? null
    : bootstrap.find((entry) => entry.key === winner.key);
  const reliable = Boolean(winnerPaired && winnerPaired.ci95[1] < 0);

  // An engine change needs two things: the winning METHOD must be the engine in
  // question, and that engine must reliably beat the one that ships today.
  const hwVsIncumbent = bootstrapVsIncumbent.find((entry) => entry.key === HOLT_WINTERS_KEY);
  const winnerIsHwEngine = winner.key === HOLT_WINTERS_KEY || M5_KEYS.includes(winner.key);
  const switchEngine = winnerIsHwEngine && Boolean(hwVsIncumbent && hwVsIncumbent.ci95[1] < 0);
  const selection = {
    rule: SELECTION_RULE,
    winnerKey: winner.key,
    winnerLabel: winner.label,
    winnerWapePct: round(winner.wapePct),
    baselineKey: BASELINE_KEY,
    baselineWapePct: round(baseline?.wapePct ?? null),
    relativeImprovementPct: baseline && baseline.wapePct > 0
      ? round((100 * (baseline.wapePct - winner.wapePct)) / baseline.wapePct)
      : null,
    pairedVsBaseline: winnerPaired,
    reliable,
    verdict: reliable
      ? `${winner.key} beats ${BASELINE_KEY} with a 95% interval below zero`
      : 'no reliable improvement over the seasonal-naive baseline',
    engineRecommendation: switchEngine ? 'holt_winters' : 'velocity',
    engineDecision: {
      incumbentKey: INCUMBENT_KEY,
      incumbentWapePct: round(incumbent?.wapePct ?? null),
      holtWintersKey: HOLT_WINTERS_KEY,
      holtWintersWapePct: round(holtWinters?.wapePct ?? null),
      winnerIsHwEngine,
      holtWintersVsIncumbent: hwVsIncumbent,
      switchEngine,
      reason: winnerIsHwEngine
        ? (switchEngine
          ? 'the Holt-Winters engine has the lowest dev WAPE and beats velocity with a 95% interval below zero'
          : 'Holt-Winters has the lowest dev WAPE but does not reliably beat the incumbent velocity baseline')
        : `the lowest-WAPE method (${winner.key}) is not a shipped engine; ` +
          `Holt-Winters ${hwVsIncumbent && hwVsIncumbent.ci95[1] < 0 ? 'does' : 'does not'} ` +
          'beat the incumbent velocity baseline, so FORECAST_ENGINE stays velocity',
    },
  };

  return {
    dataKind,
    accuracyEvidence: dataKind === 'real',
    banner: dataKind === 'real'
      ? 'REAL point-of-sale data — accuracy evidence for the dev window only'
      : 'NOT ACCURACY EVIDENCE — synthetic/extrapolated series',
    config: {
      workbookSheet: SHEET_NAME,
      dataKind,
      dateShiftDays: grid.shiftDays,
      endpointDate: endDate,
      devWindow: { start: devStart, end: devEnd },
      holdOut: { start: HOLD_OUT_START, end: HOLD_OUT_END, sealed: true, evaluated: false },
      folds: {
        count: folds.length,
        mode: 'expanding',
        origins: folds.map((fold) => fold.origin),
        trainDays: folds.map((fold) => fold.trainDays),
        minTrainDays: MIN_TRAIN_DAYS,
        maxHistoryDays: MAX_HISTORY_DAYS,
        horizonDays: HORIZON_DAYS,
        scoredDays: folds.reduce((acc, fold) => acc + fold.scoredDates.length, 0),
      },
      historyDays: MAX_HISTORY_DAYS,
      velocityDays: VELOCITY_DAYS,
      m5Presets: M5_PRESETS,
      bootstrap: {
        method: 'block bootstrap by calendar day (blocks resampled with replacement, '
          + 'observations pooled per draw)',
        draws: BOOTSTRAP_DRAWS,
        seed: BOOTSTRAP_SEED,
        baseline: BASELINE_KEY,
        incumbent: INCUMBENT_KEY,
      },
      generatedAt: new Date().toISOString(),
    },
    dataset: {
      rowsInSheet: parsed.rowsInSheet,
      rowsValid: parsed.rowsValid,
      rowsAggregated: parsed.rowsAggregated,
      rowsOutsideWindow: parsed.outsideWindow,
      excluded: parsed.excluded,
      hasStatusColumn: parsed.hasStatusColumn,
      pairCount: parsed.pairCount,
      skus: grid.skus.length,
      calendarDays: grid.calendarDays,
      fileRange: parsed.fileFacts,
      usedRange: parsed.windowFacts,
      shiftDays: grid.shiftDays,
      cellsWithUnits: grid.filledCells,
      zeroCells: grid.zeroCells,
    },
    weekdayPattern,
    folds: byFold,
    scoredObservations: observations.length,
    hwFallbacks,
    noiseFloor: noise,
    methods,
    buckets,
    topSkus,
    bootstrap,
    bootstrapVsIncumbent,
    selection,
    // Consumed by writeReports() for the raw CSVs; omitted from the JSON dump.
    observations,
    params,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Hold-out — scored ONCE, under the committed frozen config
// ─────────────────────────────────────────────────────────────────────────────

/** The config this mode obeys. Nothing in it may be changed by this script. */
const FROZEN_CONFIG_PATH = path.join(REPO_ROOT, 'docs/validation/frozen_config.json');

/** The methods the task freezes; the M5 presets are not scored here. */
const HOLDOUT_METHOD_KEYS = Object.freeze([
  'M1_seasonal_naive',
  'M2_ma7',
  'M3_velocity14',
  'M4_hw_grid',
  'M6_weekday_profile',
]);

/** The knobs that must equal the committed values, or the run is refused. */
const FROZEN_PROTOCOL_CHECKS = Object.freeze([
  ['status', (config) => config.status, 'dev-folds-complete-holdout-sealed'],
  ['protocol.holdOut.sealed', (config) => config.protocol?.holdOut?.sealed, true],
  ['protocol.holdOut.evaluated', (config) => config.protocol?.holdOut?.evaluated, false],
  ['protocol.holdOut.start', (config) => config.protocol?.holdOut?.start, HOLD_OUT_START],
  ['protocol.holdOut.end', (config) => config.protocol?.holdOut?.end, HOLD_OUT_END],
  ['protocol.foldMode', (config) => config.protocol?.foldMode, 'expanding'],
  ['protocol.maxHistoryDays', (config) => config.protocol?.maxHistoryDays, MAX_HISTORY_DAYS],
  ['protocol.velocityDays', (config) => config.protocol?.velocityDays, VELOCITY_DAYS],
  ['protocol.horizonDays', (config) => config.protocol?.horizonDays, HORIZON_DAYS],
  ['protocol.bootstrap.draws', (config) => config.protocol?.bootstrap?.draws, BOOTSTRAP_DRAWS],
  ['protocol.bootstrap.seed', (config) => config.protocol?.bootstrap?.seed, BOOTSTRAP_SEED],
  ['productionEngine.envVar', (config) => config.productionEngine?.envVar, 'FORECAST_ENGINE'],
]);

/**
 * Reads the committed frozen config.
 * @returns {object} Parsed config.
 * @throws {Error} When the file is missing or not JSON.
 */
function readFrozenConfig() {
  let raw;
  try {
    raw = readFileSync(FROZEN_CONFIG_PATH, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${path.relative(REPO_ROOT, FROZEN_CONFIG_PATH)}: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`frozen_config.json is not valid JSON: ${error.message}`);
  }
}

/**
 * Refuses to score the hold-out unless the config is still the one that was
 * committed before the sealed week was read.
 *
 * This is the point of the hold-out: its numbers are evidence only if nothing was
 * chosen after seeing them. The check is mechanical, so "we did not tune anything"
 * is a verifiable fact rather than a promise.
 *
 * @param {object} config Parsed frozen_config.json.
 * @returns {{checked: Array<{key: string, value: unknown, pass: boolean}>, winnerKey: string,
 *   scoredMethods: string[]}} What was verified.
 * @throws {Error} Listing every mismatch.
 */
function assertFrozenProtocol(config) {
  const checks = FROZEN_PROTOCOL_CHECKS.map(([key, read, expected]) => {
    const value = read(config);
    return { key, value, expected, pass: value === expected };
  });

  const problems = checks
    .filter((check) => !check.pass)
    .map((check) => (
      `  - ${check.key}: expected ${JSON.stringify(check.expected)}, found ${JSON.stringify(check.value)}`
    ));

  const frozenWinner = config.winner?.method;
  if (!HOLDOUT_METHOD_KEYS.includes(frozenWinner)) {
    problems.push(`  - winner.method: ${JSON.stringify(frozenWinner)} is not one of the scored methods`);
  }
  const devMethods = new Set(config.protocol?.methods ?? []);
  for (const key of HOLDOUT_METHOD_KEYS) {
    if (!devMethods.has(key)) problems.push(`  - protocol.methods: ${key} is missing from the frozen list`);
  }
  if (!config.protocol?.selectionRule) problems.push('  - protocol.selectionRule: missing');

  if (problems.length > 0) {
    throw new Error(
      'refusing to score the hold-out — the frozen config is not the committed one:\n'
      + `${problems.join('\n')}\n`
      + 'The hold-out is a one-shot confirmatory run. Restore the committed '
      + 'docs/validation/frozen_config.json (git show HEAD:docs/validation/frozen_config.json) '
      + 'or stop and investigate.',
    );
  }

  return { checked: checks, winnerKey: frozenWinner, scoredMethods: HOLDOUT_METHOD_KEYS };
}

/**
 * Merges the dev-window read and the hold-out read into one parsed shape.
 *
 * Only the hold-out grid needs both halves (fit on the first 28 days, score the
 * last 7), and the fold machinery slices the arrays itself, so nothing downstream
 * can look forward: runFolds receives `values.subarray(trainingFrom, originIndex + 1)`.
 *
 * @param {ReturnType<typeof readPosSheet>} parsedFit Dev-window read.
 * @param {ReturnType<typeof readPosSheet>} parsedHoldout Hold-out-window read.
 * @returns {ReturnType<typeof readPosSheet>} Union of the two.
 */
function mergeParsedWindows(parsedFit, parsedHoldout) {
  const units = new Map();
  for (const parsed of [parsedFit, parsedHoldout]) {
    for (const [sku, byDate] of parsed.units) {
      const target = units.get(sku) ?? new Map();
      for (const [date, quantity] of byDate) target.set(date, (target.get(date) ?? 0) + quantity);
      units.set(sku, target);
    }
  }
  let pairCount = 0;
  for (const byDate of units.values()) pairCount += byDate.size;

  return {
    ...parsedFit,
    units,
    productNames: new Map([...parsedFit.productNames, ...parsedHoldout.productNames]),
    categories: new Map([...parsedFit.categories, ...parsedHoldout.categories]),
    pairCount,
    windowFacts: {
      firstDate: [parsedFit.windowFacts.firstDate, parsedHoldout.windowFacts.firstDate]
        .filter(Boolean).sort()[0] ?? null,
      lastDate: [parsedFit.windowFacts.lastDate, parsedHoldout.windowFacts.lastDate]
        .filter(Boolean).sort().slice(-1)[0] ?? null,
      distinctDays: parsedFit.windowFacts.distinctDays + parsedHoldout.windowFacts.distinctDays,
    },
  };
}

/**
 * The single hold-out fold: all 28 dev days are training, the origin is the last
 * dev day, and the scored days are the sealed week.
 * @param {ReturnType<typeof buildGrid>} grid Grid spanning dev window + hold-out.
 * @returns {{fold: number, origin: string, trainDays: number, trainingFrom: string,
 *   scoredDates: string[]}}
 */
function buildHoldoutFold(grid) {
  const origin = shiftIsoDate(HOLD_OUT_START, -1);
  const trainingFrom = grid.dates[0];
  const trainDays = daysBetween(trainingFrom, origin) + 1;
  if (trainDays !== MAX_HISTORY_DAYS) {
    throw new Error(
      `the hold-out fold would train on ${trainDays} days, `
      + `but the frozen protocol says ${MAX_HISTORY_DAYS}`,
    );
  }
  const scoredDates = isoDatesBetween(HOLD_OUT_START, HOLD_OUT_END);
  for (const date of scoredDates) {
    if (!grid.indexByDate.has(date)) {
      throw new Error(`hold-out date ${date} is not on the grid — the workbook does not cover the sealed week`);
    }
  }
  return { fold: 1, origin, trainDays, trainingFrom, scoredDates };
}

/**
 * Scores the frozen methods on the sealed week.
 *
 * Nothing is selected here: the method list, the windows and the selection rule
 * come from the committed config, and the only new information is how the frozen
 * methods performed on seven days none of them was fitted on.
 *
 * @param {{parsed: ReturnType<typeof readPosSheet>, config: object, frozen: object}} input
 * @returns {object} Hold-out report.
 */
function runHoldout({ parsed, config, frozen }) {
  const grid = buildGrid(parsed, {
    startDate: config.protocol.devWindow.start,
    endDate: HOLD_OUT_END,
    shiftDays: 0,
  });
  const storeDaily = new Float64Array(grid.calendarDays);
  for (const sku of grid.skus) {
    const series = grid.values.get(sku);
    for (let index = 0; index < series.length; index += 1) storeDaily[index] += series[index];
  }

  const fold = buildHoldoutFold(grid);
  console.log('\n── Hold-out ───────────────────────────────────────────────────');
  console.log(`  fit           : ${fold.trainingFrom} .. ${fold.origin} (${fold.trainDays} days, all of them)`);
  console.log(
    `  scored        : ${fold.scoredDates[0]} .. ${fold.scoredDates[fold.scoredDates.length - 1]} ` +
    `(${fold.scoredDates.length} days, h1..h${fold.scoredDates.length})`,
  );
  const { observations, params, hwFallbacks } = runFolds(grid, storeDaily, [fold]);
  console.log(`  scored SKU-days: ${observations.length}`);
  console.log(`  HW update steps after initialisation: ${fold.trainDays - SEASON_LENGTH}`);

  const methods = HOLDOUT_METHOD_KEYS.map((key) => ({
    key, label: METHOD_LABELS[key], ...metricsFor(observations, key),
  }));
  const buckets = BUCKETS.map((bucket) => ({
    bucket: bucket.label,
    rows: HOLDOUT_METHOD_KEYS.map((key) => ({
      key,
      ...metricsFor(
        observations.filter((o) => o.horizon >= bucket.from && o.horizon <= bucket.to),
        key,
      ),
    })),
  }));

  const skuTotals = new Map(grid.skus.map((sku) => [sku, 0]));
  for (const observation of observations) {
    skuTotals.set(observation.sku, skuTotals.get(observation.sku) + observation.actual);
  }
  const topSkus = [...skuTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SKU_COUNT)
    .map(([sku, actualUnits]) => ({
      sku,
      productName: parsed.productNames.get(sku) ?? '',
      actualUnits,
      rows: HOLDOUT_METHOD_KEYS.map((key) => ({
        key, ...metricsFor(observations.filter((o) => o.sku === sku), key),
      })),
    }));

  const vsBaseline = HOLDOUT_METHOD_KEYS
    .filter((key) => key !== BASELINE_KEY)
    .map((key) => ({ key, ...pairedBlockBootstrap(observations, key, BASELINE_KEY) }));
  const vsIncumbent = HOLDOUT_METHOD_KEYS
    .filter((key) => key !== INCUMBENT_KEY)
    .map((key) => ({ key, ...pairedBlockBootstrap(observations, key, INCUMBENT_KEY) }));

  const ranked = [...methods].sort((a, b) => (a.wapePct ?? Infinity) - (b.wapePct ?? Infinity));
  const winner = ranked[0];
  const winnerPaired = winner.key === BASELINE_KEY
    ? null
    : vsBaseline.find((entry) => entry.key === winner.key);
  const reliable = Boolean(winnerPaired && winnerPaired.ci95[1] < 0);

  // Does the sealed week agree with the dev window? Reported, never acted on.
  const devWape = config.devResults?.pooledWapePct ?? {};
  const devVsHoldout = methods.map((method) => ({
    key: method.key,
    devWapePct: round(devWape[method.key] ?? null),
    holdoutWapePct: round(method.wapePct),
    deltaPctPoints: devWape[method.key] === undefined || method.wapePct === null
      ? null
      : round(method.wapePct - devWape[method.key]),
  }));

  return {
    mode: 'holdout',
    accuracyEvidence: true,
    banner: 'REAL point-of-sale data — the sealed week, scored once under the committed frozen config',
    frozenConfig: {
      path: path.relative(REPO_ROOT, FROZEN_CONFIG_PATH),
      frozenAt: config.frozenAt,
      winnerKey: frozen.winnerKey,
      productionEngine: config.productionEngine?.envVar,
      checks: frozen.checked,
    },
    protocol: config.protocol,
    dataset: parsed.holdoutFacts,
    fold: {
      origin: fold.origin,
      trainDays: fold.trainDays,
      trainingFrom: fold.trainingFrom,
      scoredFrom: fold.scoredDates[0],
      scoredTo: fold.scoredDates[fold.scoredDates.length - 1],
      scoredDays: fold.scoredDates.length,
    },
    hwFallbacks,
    hwUpdateSteps: fold.trainDays - SEASON_LENGTH,
    methods,
    buckets,
    topSkus,
    bootstrapVsBaseline: vsBaseline,
    bootstrapVsIncumbent: vsIncumbent,
    devVsHoldout,
    holdoutSelection: {
      rule: 'the frozen rule, applied for reporting only — nothing is selected or changed here',
      winnerKey: winner.key,
      winnerWapePct: round(winner.wapePct),
      devWinnerKey: frozen.winnerKey,
      agreesWithDev: winner.key === frozen.winnerKey,
      winnerVsBaseline: winnerPaired,
      reliable,
      verdict: reliable
        ? `${winner.key} beats ${BASELINE_KEY} on the hold-out with a 95% interval below zero`
        : `no reliable improvement over ${BASELINE_KEY} on the hold-out`,
    },
    observations,
    params,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Writes the hold-out artifacts. Deliberately separate filenames: the dev outputs
 * stay byte-identical, and a `_holdout` file can never be mistaken for dev evidence.
 * @param {{report: object, inputPath: string, outDir: string}} input
 * @returns {string[]} Absolute paths written.
 */
function writeHoldoutReports({ report, inputPath, outDir }) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, contents) => {
    const target = path.join(outDir, name);
    writeFileSync(target, contents, 'utf8');
    written.push(target);
  };

  const metricRows = [];
  for (const method of report.methods) {
    metricRows.push(['pooled', method.key, method.label, method.n, round(method.wapePct),
      round(method.mae), round(method.biasPct), round(method.meanActual)]);
  }
  for (const bucket of report.buckets) {
    for (const row of bucket.rows) {
      metricRows.push([bucket.bucket, row.key, METHOD_LABELS[row.key], row.n, round(row.wapePct),
        round(row.mae), round(row.biasPct), round(row.meanActual)]);
    }
  }
  write(
    'forecast_holdout_metrics.csv',
    toCsv(['scope', 'method', 'label', 'n', 'wape_pct', 'mae', 'bias_pct', 'mean_actual'], metricRows),
  );

  const skuRows = [];
  for (const sku of report.topSkus) {
    for (const row of sku.rows) {
      skuRows.push([sku.sku, sku.productName, round(sku.actualUnits), row.key, row.n,
        round(row.wapePct), round(row.mae), round(row.biasPct)]);
    }
  }
  write(
    'forecast_holdout_top10_skus.csv',
    toCsv(['sku', 'product_name', 'actual_units', 'method', 'n', 'wape_pct', 'mae', 'bias_pct'], skuRows),
  );

  const observationRows = report.observations.map((observation) => [
    observation.fold, observation.sku, observation.date, observation.horizon,
    observation.actual, ...HOLDOUT_METHOD_KEYS.map((key) => round(observation.predictions[key], 3)),
  ]);
  write(
    'forecast_holdout_observations.csv',
    toCsv(['fold', 'sku', 'date', 'horizon', 'actual', ...HOLDOUT_METHOD_KEYS], observationRows),
  );

  const summary = { ...report };
  delete summary.observations;
  delete summary.params;
  write('forecast_holdout_raw.json', JSON.stringify({ ...summary, input: inputPath }, null, 2));

  console.log('\n── Written ────────────────────────────────────────────────────');
  for (const file of written) console.log(`  ${path.relative(REPO_ROOT, file)}`);
  return written;
}

/**
 * Prints the hold-out comparison: per-method error, then the two paired tests the
 * frozen protocol asks for.
 * @param {object} report Hold-out report from runHoldout().
 * @returns {void}
 */
function printHoldoutSummary(report) {
  console.log('\n── Hold-out results ───────────────────────────────────────────');
  console.log(`  ${cell('method', 24)}${cell('WAPE%', 9)}${cell('MAE', 8)}${cell('bias%', 8)}n`);
  for (const method of report.methods) {
    console.log(
      `  ${cell(method.key, 24)}${cell(num(method.wapePct), 9)}${cell(num(method.mae), 8)}`
      + `${cell(num(method.biasPct), 8)}${method.n}`,
    );
  }
  console.log(`\n  ${cell('method', 24)}${cell('vs M1: diff', 14)}${cell('95% CI', 22)}verdict`);
  for (const entry of report.bootstrapVsBaseline) {
    console.log(
      `  ${cell(entry.key, 24)}${cell(num(entry.meanDiffUnits, 4), 14)}`
      + `${cell(`[${num(entry.ci95[0], 4)}, ${num(entry.ci95[1], 4)}]`, 22)}`
      + `${entry.ci95[1] < 0 ? 'better' : entry.ci95[0] > 0 ? 'worse' : 'no difference'}`,
    );
  }
  console.log(`\n  ${cell('method', 24)}${cell('vs velocity: diff', 20)}${cell('95% CI', 22)}verdict`);
  for (const entry of report.bootstrapVsIncumbent) {
    console.log(
      `  ${cell(entry.key, 24)}${cell(num(entry.meanDiffUnits, 4), 20)}`
      + `${cell(`[${num(entry.ci95[0], 4)}, ${num(entry.ci95[1], 4)}]`, 22)}`
      + `${entry.ci95[1] < 0 ? 'better' : entry.ci95[0] > 0 ? 'worse' : 'no difference'}`,
    );
  }
  console.log(`\n  dev winner  : ${report.holdoutSelection.devWinnerKey}`);
  console.log(
    `  hold-out    : ${report.holdoutSelection.winnerKey} `
    + `(WAPE ${num(report.holdoutSelection.winnerWapePct)}%)`,
  );
  console.log(
    `  agrees      : ${report.holdoutSelection.agreesWithDev
      ? 'yes'
      : 'NO — reported as-is, nothing is retuned'}`,
  );
  console.log(`  verdict     : ${report.holdoutSelection.verdict}`);
  console.log('\n  The hold-out is now SPENT. No parameter, window or method may be changed against it.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes the raw results: six CSVs and one JSON, all suffixed `_synthetic` for a
 * synthetic run. The JSON deliberately omits the per-row observations (they live
 * in the CSV) so it stays readable.
 * @param {{report: object, inputPath: string, outDir: string, suffix: string}} input
 * @returns {string[]} Absolute paths written.
 */
function writeReports({ report, inputPath, outDir, suffix }) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  const write = (name, contents) => {
    const target = path.join(outDir, name);
    writeFileSync(target, contents, 'utf8');
    written.push(target);
  };

  const metricCols = ['scope', 'method', 'label', 'n', 'wape_pct', 'mae', 'bias_pct', 'mean_actual'];
  const metricRows = [];
  for (const method of report.methods) {
    metricRows.push(['pooled', method.key, method.label, method.n, round(method.wapePct),
      round(method.mae), round(method.biasPct), round(method.meanActual)]);
  }
  for (const bucket of report.buckets) {
    for (const row of bucket.rows) {
      metricRows.push([bucket.bucket, row.key, METHOD_LABELS[row.key], row.n, round(row.wapePct),
        round(row.mae), round(row.biasPct), round(row.meanActual)]);
    }
  }
  write(`forecast_backtest_metrics${suffix}.csv`, toCsv(metricCols, metricRows));

  const foldRows = [];
  for (const fold of report.folds) {
    for (const row of fold.rows) {
      foldRows.push([fold.fold, fold.origin, fold.trainDays, fold.scoredFrom, fold.scoredTo,
        fold.scoredDays, row.key, row.n, round(row.wapePct), round(row.mae), round(row.biasPct)]);
    }
  }
  write(
    `forecast_backtest_by_fold${suffix}.csv`,
    toCsv(['fold', 'origin', 'train_days', 'scored_from', 'scored_to', 'scored_days', 'method',
      'n', 'wape_pct', 'mae', 'bias_pct'], foldRows),
  );

  const skuRows = [];
  for (const sku of report.topSkus) {
    for (const row of sku.rows) {
      skuRows.push([sku.sku, sku.productName, round(sku.actualUnits), row.key, row.n,
        round(row.wapePct), round(row.mae), round(row.biasPct)]);
    }
  }
  write(
    `forecast_backtest_top10_skus${suffix}.csv`,
    toCsv(['sku', 'product_name', 'actual_units', 'method', 'n', 'wape_pct', 'mae',
      'bias_pct'], skuRows),
  );

  const weekdayRows = report.weekdayPattern.perWeekday.map((row) => [
    row.weekday, row.weekdayIndex, row.days, round(row.meanUnitsPerDay, 2),
    round(row.indexVsOverall, 4), round(row.minUnits, 0), round(row.maxUnits, 0),
    round(row.cvPct, 2),
  ]);
  write(
    `forecast_backtest_weekday_pattern${suffix}.csv`,
    toCsv(['weekday', 'weekday_index', 'days', 'mean_units_per_day', 'index_vs_overall',
      'min_units', 'max_units', 'cv_pct'], weekdayRows),
  );

  const observationRows = report.observations.map((observation) => [
    observation.fold, observation.sku, observation.date, observation.horizon,
    observation.actual, ...METHOD_KEYS.map((key) => round(observation.predictions[key], 3)),
  ]);
  write(
    `forecast_backtest_observations${suffix}.csv`,
    toCsv(['fold', 'sku', 'date', 'horizon', 'actual', ...METHOD_KEYS], observationRows),
  );

  const paramRows = report.params.map((entry) => [
    entry.fold, entry.sku, entry.alpha, entry.beta, entry.gamma, entry.steps, round(entry.sse, 4),
  ]);
  write(
    `forecast_backtest_params${suffix}.csv`,
    toCsv(['fold', 'sku', 'alpha', 'beta', 'gamma', 'hw_update_steps', 'sse'], paramRows),
  );

  const pickedCounts = new Map();
  for (const entry of report.params) {
    const triple = `a${entry.alpha}_b${entry.beta}_g${entry.gamma}`;
    pickedCounts.set(triple, (pickedCounts.get(triple) ?? 0) + 1);
  }
  const summary = { ...report };
  delete summary.observations;
  delete summary.params;
  write(
    `forecast_backtest_raw${suffix}.json`,
    JSON.stringify({
      ...summary,
      input: inputPath,
      outputSuffix: suffix,
      parametersPicked: [...pickedCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([triple, count]) => ({ triple, count })),
    }, null, 2),
  );

  console.log('\n── Written ────────────────────────────────────────────────────');
  for (const file of written) console.log(`  ${path.relative(REPO_ROOT, file)}`);
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console report
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {string} `text` padded or trimmed to `width` characters. */
function cell(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? `${value.slice(0, width - 1)} ` : value.padEnd(width, ' ');
}

/** @returns {string} A number to `digits` decimals, or '-' when not finite. */
function num(value, digits = 2) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '-'
    : value.toFixed(digits);
}

/**
 * Prints the tables a reader needs to judge the result without opening a file.
 * @param {object} report Result of runBacktest().
 * @returns {void}
 */
function printSummary(report) {
  if (!report.accuracyEvidence) {
    console.log('\n!! NOT ACCURACY EVIDENCE — these numbers come from a synthetic series\n');
  }

  const pattern = report.weekdayPattern;
  console.log(
    `\n── Store weekday pattern (SUM of units per day, ${pattern.days} dev days) ──`,
  );
  console.log(
    `  ${cell('weekday', 12)}${cell('mean units/day', 16)}${cell('index', 8)}${cell('days', 6)}` +
    `${cell('min..max', 14)}cv%`,
  );
  for (const row of pattern.perWeekday) {
    console.log(
      `  ${cell(row.weekday, 12)}${cell(num(row.meanUnitsPerDay, 1), 16)}` +
      `${cell(num(row.indexVsOverall, 3), 8)}${cell(row.days, 6)}` +
      `${cell(`${num(row.minUnits, 0)}..${num(row.maxUnits, 0)}`, 14)}${num(row.cvPct, 1)}`,
    );
  }
  console.log(
    `  strongest ${pattern.strongest} · weakest ${pattern.weakest} · ` +
    `${(pattern.days / SEASON_LENGTH).toFixed(1)} observations per weekday → wide uncertainty`,
  );

  console.log('\n── Pooled dev results ─────────────────────────────────────────');
  console.log(`  ${cell('method', 30)}${cell('WAPE%', 9)}${cell('MAE', 9)}${cell('bias%', 9)}n`);
  for (const method of report.methods) {
    console.log(
      `  ${cell(method.key, 30)}${cell(num(method.wapePct), 9)}${cell(num(method.mae), 9)}` +
      `${cell(num(method.biasPct), 9)}${method.n}`,
    );
  }
  const floor = report.noiseFloor;
  console.log(
    `\n  Poisson noise floor: mean ${num(floor.meanUnitsPerSkuDay, 3)} units/SKU-day → ` +
    `WAPE cannot go below ${num(floor.wapeFloorPct)}%`,
  );

  console.log('\n── By horizon bucket ──────────────────────────────────────────');
  console.log(`  ${cell('method', 30)}${cell('h1-3', 9)}${cell('h4-7', 9)}`);
  for (const method of report.methods) {
    const parts = report.buckets.map((bucket) => (
      bucket.rows.find((row) => row.key === method.key)?.wapePct
    ));
    console.log(`  ${cell(method.key, 30)}${parts.map((value) => cell(num(value), 9)).join('')}`);
  }

  console.log('\n── Paired vs M1 (block bootstrap over calendar days) ──────────');
  console.log(
    `  ${cell('method', 30)}${cell('mean diff', 12)}${cell('95% CI', 22)}verdict`,
  );
  for (const entry of report.bootstrap) {
    const ci = `[${num(entry.ci95[0], 3)}, ${num(entry.ci95[1], 3)}]`;
    const verdict = entry.ci95[1] < 0 ? 'better' : (entry.ci95[0] > 0 ? 'worse' : 'no difference');
    console.log(`  ${cell(entry.key, 30)}${cell(num(entry.meanDiffUnits, 3), 12)}${cell(ci, 22)}${verdict}`);
  }
  const first = report.bootstrap[0];
  console.log(
    `  interval method: ${first.blocks} calendar-day blocks ` +
    `(${Math.min(...first.blockSizes)}..${Math.max(...first.blockSizes)} obs each), ` +
    `${first.draws} draws, seed ${first.seed}`,
  );
  if (first.coarse) {
    console.log('  note: fewer than 10 resampling units — the interval is coarse, read it as indicative');
  }

  const selection = report.selection;
  console.log('\n── Selection ──────────────────────────────────────────────────');
  console.log(`  rule      : ${selection.rule}`);
  console.log(`  winner    : ${selection.winnerKey} (WAPE ${num(selection.winnerWapePct)}%)`);
  console.log(`  baseline  : ${selection.baselineKey} (WAPE ${num(selection.baselineWapePct)}%)`);
  console.log(`  vs M1     : ${num(selection.relativeImprovementPct)}% relative, ` +
    `${selection.pairedVsBaseline ? `CI [${num(selection.pairedVsBaseline.ci95[0], 3)}, ` +
      `${num(selection.pairedVsBaseline.ci95[1], 3)}]` : 'winner IS the baseline'}`);
  console.log(`  VERDICT   : ${selection.verdict.toUpperCase()}`);

  const decision = selection.engineDecision;
  console.log('\n── Engine decision ────────────────────────────────────────────');
  console.log(`  incumbent : ${decision.incumbentKey} (WAPE ${num(decision.incumbentWapePct)}%)`);
  console.log(`  candidate : ${decision.holtWintersKey} (WAPE ${num(decision.holtWintersWapePct)}%)`);
  console.log(`  paired    : mean diff ${num(decision.holtWintersVsIncumbent?.meanDiffUnits, 3)} ` +
    `CI [${num(decision.holtWintersVsIncumbent?.ci95[0], 3)}, ` +
    `${num(decision.holtWintersVsIncumbent?.ci95[1], 3)}] vs velocity`);
  console.log(`  reason    : ${decision.reason}`);
  console.log(`  engine    : FORECAST_ENGINE=${selection.engineRecommendation}`);
  console.log(`  hold-out  : ${HOLD_OUT_START} .. ${HOLD_OUT_END} was NOT scored\n`);
}


/**
 * Runs the one-shot hold-out: read the config, verify it is still the committed
 * one, read the dev window for fitting and the sealed week for scoring, and stop.
 * @param {{inputPath: string, outDir: string, devStart: string, devEnd: string}} input
 * @returns {Promise<void>}
 */
async function runHoldoutMode({ inputPath, outDir, devStart, devEnd }) {
  const config = readFrozenConfig();
  const frozen = assertFrozenProtocol(config);
  const frozenDev = config.protocol.devWindow;
  if (devStart !== frozenDev.start || devEnd !== frozenDev.end) {
    throw new Error(
      `refusing to score the hold-out: the frozen config fits on ${frozenDev.start}..${frozenDev.end}, `
      + `but --dev-start/--dev-end say ${devStart}..${devEnd}`,
    );
  }

  console.log('\n── Hold-out scoring (one shot) ────────────────────────────────');
  console.log('  question      : how did the FROZEN methods do on a week they never saw?');
  console.log(`  frozen config : ${path.relative(REPO_ROOT, FROZEN_CONFIG_PATH)} (${config.frozenAt})`);
  console.log(`  dev winner    : ${frozen.winnerKey}; FORECAST_ENGINE stays ${config.productionEngine?.default}`);
  for (const check of frozen.checked) console.log(`  config ${check.pass ? 'PASS' : 'FAIL'}   : ${check.key} = ${JSON.stringify(check.value)}`);

  // ── Read the two windows separately so the fit can never see the hold-out ──
  const parsedFit = readPosSheet(inputPath, { windowStart: devStart, windowEnd: devEnd });
  const checks = realDataChecks({ parsed: parsedFit, devStart, devEnd });
  printDataBanner({ parsed: parsedFit, dataKind: 'real', inputPath, devStart, devEnd, checks });
  assertRealData(checks);

  const parsedHoldout = readPosSheet(inputPath, { windowStart: HOLD_OUT_START, windowEnd: HOLD_OUT_END });
  const problems = [];
  if (parsedHoldout.rowsAggregated === 0) {
    problems.push(`no sale rows inside ${HOLD_OUT_START}..${HOLD_OUT_END}`);
  }
  if (parsedHoldout.windowFacts.distinctDays !== daysBetween(HOLD_OUT_START, HOLD_OUT_END) + 1) {
    problems.push(
      `the sealed week has ${parsedHoldout.windowFacts.distinctDays} distinct days, expected 7`,
    );
  }
  if (parsedHoldout.windowFacts.firstDate !== HOLD_OUT_START
    || parsedHoldout.windowFacts.lastDate !== HOLD_OUT_END) {
    problems.push(
      `the sealed week spans ${parsedHoldout.windowFacts.firstDate}..${parsedHoldout.windowFacts.lastDate}, `
      + `expected ${HOLD_OUT_START}..${HOLD_OUT_END}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`refusing to score the hold-out:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  console.log(
    `\n  hold-out rows : ${grouped(parsedHoldout.rowsAggregated)} inside ` +
    `${parsedHoldout.windowFacts.firstDate}..${parsedHoldout.windowFacts.lastDate} ` +
    `(${parsedHoldout.units.size} SKUs, ${parsedHoldout.windowFacts.distinctDays} days)`,
  );

  const parsed = mergeParsedWindows(parsedFit, parsedHoldout);
  parsed.holdoutFacts = {
    rowsInSheet: parsedFit.rowsInSheet,
    rowsValidInSheet: parsedFit.rowsValid,
    rowsUsedForFitting: parsedFit.rowsAggregated,
    rowsUsedForScoring: parsedHoldout.rowsAggregated,
    rowsOutsideBothWindows: parsedFit.outsideWindow - parsedHoldout.rowsAggregated,
    skusFitted: parsedFit.units.size,
    skusScored: parsedHoldout.units.size,
    holdoutDays: parsedHoldout.windowFacts.distinctDays,
    holdoutRange: {
      first: parsedHoldout.windowFacts.firstDate,
      last: parsedHoldout.windowFacts.lastDate,
    },
  };

  const report = runHoldout({ parsed, config, frozen });
  report.dataset = parsed.holdoutFacts;
  writeHoldoutReports({ report, inputPath, outDir });
  printHoldoutSummary(report);
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reads the workbook, runs the folds and writes the result files.
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || args.input === true) {
    throw new Error('--input "<path to the real London Bakers workbook>" is required');
  }
  const inputPath = path.resolve(REPO_ROOT, String(args.input));

  const dataKind = String(args['data-kind'] ?? 'real').toLowerCase();
  if (!DATA_KINDS.includes(dataKind)) {
    throw new Error(`--data-kind must be one of ${DATA_KINDS.join(' | ')} (got "${args['data-kind']}")`);
  }
  const isReal = dataKind === 'real';
  if (isReal && args['end-date'] !== undefined) {
    throw new Error(
      '--end-date is for --data-kind synthetic only: the real export is never date-shifted '
      + '(2026-09-01 .. 2026-10-05 as recorded).',
    );
  }

  const devStart = requireIsoDate('dev-start', args['dev-start'] ?? DEFAULT_DEV_START);
  const devEnd = requireIsoDate('dev-end', args['dev-end'] ?? DEFAULT_DEV_END);
  const endDate = isReal
    ? devEnd
    : requireIsoDate('end-date', args['end-date'] ?? SYNTHETIC_END_DATE);
  const outDir = path.resolve(REPO_ROOT, String(args.out ?? 'docs/validation'));
  const suffix = isReal ? '' : '_synthetic';

  // ── One-shot hold-out mode: score the sealed week, then stop ──────────────
  if (args['score-holdout'] === true) {
    if (!isReal) {
      throw new Error('--score-holdout applies to the real workbook only (--data-kind real)');
    }
    await runHoldoutMode({ inputPath, outDir, devStart, devEnd });
    return;
  }

  // ── The protocol bounds are not configurable in a way that matters ────────
  if (devEnd < devStart) {
    throw new Error(`--dev-end ${devEnd} is before --dev-start ${devStart}`);
  }
  if (devEnd >= HOLD_OUT_START && devStart <= HOLD_OUT_END) {
    throw new Error(
      `refusing to run: dev window ${devStart}..${devEnd} touches the sealed hold-out ` +
      `${HOLD_OUT_START}..${HOLD_OUT_END}`,
    );
  }
  if (isReal && (devStart < REAL_COVERAGE.start || devEnd > REAL_COVERAGE.end)) {
    throw new Error(
      `refusing to run: dev window ${devStart}..${devEnd} is outside the real export ` +
      `${REAL_COVERAGE.start}..${REAL_COVERAGE.end}`,
    );
  }
  if (FOLD_ORIGIN_START < devStart || FOLD_ORIGIN_END > devEnd) {
    throw new Error(
      `fold origins ${FOLD_ORIGIN_START}..${FOLD_ORIGIN_END} must lie inside the dev window ` +
      `${devStart}..${devEnd}`,
    );
  }

  console.log('\n── Forecast backtest ──────────────────────────────────────────');
  console.log('  question      : does Holt-Winters beat the shipping velocity baseline?');
  console.log(`  dev window    : ${devStart} .. ${devEnd} (folds only, scored here)`);
  console.log(`  hold-out      : ${HOLD_OUT_START} .. ${HOLD_OUT_END} (SEALED — rows dropped at read time)`);
  console.log(`  origins       : ${FOLD_ORIGIN_START} .. ${FOLD_ORIGIN_END}, expanding training from ${devStart}`);
  console.log(`  history       : ${MIN_TRAIN_DAYS}..${MAX_HISTORY_DAYS} days per fold · velocity ${VELOCITY_DAYS} · horizon ${HORIZON_DAYS}`);

  // ── 1/2 read, guard, aggregate ────────────────────────────────────────────
  const readStartedAt = Date.now();
  const parsed = readPosSheet(
    inputPath,
    isReal ? { windowStart: devStart, windowEnd: devEnd } : {},
  );
  const checks = isReal
    ? realDataChecks({ parsed, devStart, devEnd })
    : [{ label: 'data kind', detail: 'synthetic — coverage guards skipped', pass: true }];
  printDataBanner({ parsed, dataKind, inputPath, devStart, devEnd, checks });
  if (isReal) assertRealData(checks);
  console.log(`  read in       : ${((Date.now() - readStartedAt) / 1000).toFixed(1)} s`);
  for (const [reason, count] of Object.entries(parsed.excluded)) {
    if (count > 0) console.log(`      excluded ${reason.padEnd(22)} ${count}`);
  }

  const shiftDays = isReal ? 0 : daysBetween(parsed.fileFacts.lastDate, endDate);
  const startDate = isReal
    ? devStart
    : shiftIsoDate(parsed.fileFacts.firstDate, shiftDays);

  const report = runBacktest({
    parsed, dataKind, devStart, devEnd, startDate, endDate, shiftDays,
  });
  writeReports({ report, inputPath, outDir, suffix });
  printSummary(report);
}

main().catch((err) => {
  console.error(`\n[forecastBacktest] ${err.message}\n`);
  process.exit(1);
});












