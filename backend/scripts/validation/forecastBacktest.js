/**
 * scripts/validation/forecastBacktest.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 2 backtest for the demand forecaster: does Holt-Winters actually beat
 * the velocity baseline Stockout Watch ships with today?
 *
 * The question is asked on REAL data — the London Bakers point-of-sale workbook
 * — and answered on DEV FOLDS ONLY. The final week (2026-09-29 .. 2026-10-05) is
 * SEALED: this script refuses to run if a dev window touches it, so the number
 * that decides whether the engine ships is never seen while the method is being
 * chosen.
 *
 * Runs from backend/:
 *   node scripts/validation/forecastBacktest.js --input "<London_Bakers_Dataset.xlsx>"
 *   npm run validate:forecast -- --input "<London_Bakers_Dataset.xlsx>"
 *
 * What it does:
 *   1. reads sheet "POS Sales Log", keeps Status = COMPLETED and Quantity > 0,
 *      and aggregates SUM(Quantity) per (SKU, Date) — the shape sale_transactions
 *      stores;
 *   2. shifts every date by one constant number of days so the last source date
 *      lands on --end-date (2026-10-12, the anchor london-bakers-i10 was seeded
 *      with), then lays the result on a dense (SKU x calendar day) grid, zero for
 *      a day with no sale;
 *   3. runs 7 rolling-origin folds inside the dev window. Each fold fits every
 *      method on ITS OWN 28 training days and forecasts the 7 days after them;
 *      only days inside the dev window are scored, so the hold-out is untouched;
 *   4. scores WAPE (headline), MAE and signed bias, pooled, per fold, per horizon
 *      bucket (h1-3 / h4-7) and per top-10 SKU, against the Poisson noise floor
 *      of the data itself;
 *   5. pairs every method against the seasonal-naive baseline (M1) on the same
 *      SKU-day and reports a seeded bootstrap 95% interval for the difference.
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
 * Outputs (default: docs/validation/)
 *   forecast_backtest_metrics.csv       pooled + bucket metrics per method
 *   forecast_backtest_by_fold.csv       the same per fold
 *   forecast_backtest_top10_skus.csv    secondary per-SKU table
 *   forecast_backtest_observations.csv  one row per fold x SKU x scored day
 *   forecast_backtest_params.csv        the parameters M4 picked, per fold and SKU
 *   forecast_backtest_raw.json          everything above, machine-readable
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

/** Last calendar day of the aligned series (the anchor london-bakers-i10 was seeded with). */
const DEFAULT_END_DATE = '2026-10-12';

/** Dev folds span these days — four weeks, method selection happens here. */
const DEFAULT_DEV_START = '2026-09-01';
const DEFAULT_DEV_END = '2026-09-28';

/** SEALED. Any dev window touching these days is refused. */
const HOLD_OUT_START = '2026-09-29';
const HOLD_OUT_END = '2026-10-05';

/** 7 folds, origins 4 days apart, so the last fold still starts inside the dev window. */
const FOLD_COUNT = 7;
const FOLD_STEP_DAYS = 4;

/** Training days handed to every method: the production forecast window. */
const HISTORY_DAYS = 28;

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

/**
 * M5's preset list — fixed BEFORE the run, beta pinned to 0 because a 28-day
 * series carries too little evidence for a trend and the in-service grid kept
 * choosing beta = 0 on the live tenant.
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
// Arguments
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

/** @returns {number} Whole days from `fromIso` to `toIso` (positive when `toIso` is later). */
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
 * Cells are read one at a time rather than through sheet_to_json: the export is
 * 304,614 line items, and touching only the four columns this script needs keeps
 * peak memory flat (the whole-sheet object form costs several hundred MB more).
 *
 * The filter mirrors the import pipeline: Status = COMPLETED (case/space
 * insensitive), Quantity > 0, a parseable ISO date and a non-empty SKU.
 *
 * @param {string} filePath Absolute path to the workbook.
 * @returns {{
 *   rowsRead: number, rowsKept: number, excluded: Record<string, number>,
 *   units: Map<string, Map<string, number>>, productNames: Map<string, string>,
 *   categories: Map<string, string>, pairCount: number, distinctDates: number,
 *   firstDate: string, lastDate: string,
 * }}
 */
function readPosSheet(filePath) {
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

  // Header row → column indexes.
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
  for (const required of ['date', 'sku', 'quantity', 'status']) {
    if (columns[required] === undefined) {
      throw new Error(`sheet "${SHEET_NAME}" has no "${required}" column`);
    }
  }

  const units = new Map();
  const productNames = new Map();
  const categories = new Map();
  const excluded = { status_not_completed: 0, quantity_not_positive: 0, bad_date: 0, missing_sku: 0 };
  const distinctDates = new Set();
  let rowsRead = 0;
  let rowsKept = 0;
  let pairCount = 0;
  let firstDate = null;
  let lastDate = null;

  for (let row = headerRow + 1; row <= range.e.r; row += 1) {
    rowsRead += 1;
    const status = cellText(row, columns.status).toUpperCase();
    const quantity = Number(cellAt(row, columns.quantity)?.v);
    const date = cellText(row, columns.date);
    const sku = cellText(row, columns.sku);

    if (status !== 'COMPLETED') { excluded.status_not_completed += 1; continue; }
    if (!Number.isFinite(quantity) || quantity <= 0) { excluded.quantity_not_positive += 1; continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { excluded.bad_date += 1; continue; }
    if (!sku) { excluded.missing_sku += 1; continue; }

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
    distinctDates.add(date);
    if (firstDate === null || date < firstDate) firstDate = date;
    if (lastDate === null || date > lastDate) lastDate = date;
    rowsKept += 1;
  }

  return {
    rowsRead, rowsKept, excluded, units, productNames, categories, pairCount,
    firstDate, lastDate, distinctDates: distinctDates.size,
  };
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
 * @param {number} lastIndex Index of the fold's origin day inside the grid.
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
 * @param {number} historyDays Training length.
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

/**
 * Builds the rolling-origin folds of the dev window.
 *
 * Origins are FOLD_STEP_DAYS apart starting the day before `devStart`; each fold
 * projects HORIZON_DAYS and is scored only on days that fall inside the dev
 * window. The truncation is what keeps a 7-day horizon inside four weeks without
 * ever touching the sealed hold-out.
 *
 * @param {string} devStart First scored day.
 * @param {string} devEnd Last scored day.
 * @returns {Array<{fold: number, origin: string, scoredDates: string[], horizons: number}>}
 */
function buildFolds(devStart, devEnd) {
  const folds = [];
  const firstOrigin = shiftIsoDate(devStart, -1);
  for (let k = 1; k <= FOLD_COUNT; k += 1) {
    const origin = shiftIsoDate(firstOrigin, (k - 1) * FOLD_STEP_DAYS);
    const lastScored = shiftIsoDate(origin, HORIZON_DAYS) < devEnd
      ? shiftIsoDate(origin, HORIZON_DAYS)
      : devEnd;
    if (lastScored <= origin) {
      throw new Error(`fold ${k} has no scored day: origin ${origin}, dev end ${devEnd}`);
    }
    folds.push({ fold: k, origin, scoredDates: isoDatesBetween(shiftIsoDate(origin, 1), lastScored) });
  }
  return folds;
}


// ─────────────────────────────────────────────────────────────────────────────
// The dense grid every method reads from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lays the parsed export on a (SKU x calendar day) grid after one constant date
 * shift, so each fold can slice any window out of it without re-reading the file.
 *
 * The shift is the same construction the import pipeline uses: every date moves
 * by the same number of days, so weekday alignment — which is the whole point of
 * a seasonal method — is preserved.
 *
 * @param {ReturnType<typeof readPosSheet>} parsed
 * @param {string} endDate Last calendar day of the aligned series.
 * @returns {{
 *   skus: string[], dates: string[], indexByDate: Map<string, number>,
 *   values: Map<string, Float64Array>, shiftDays: number, calendarDays: number,
 *   sourceFirstDate: string, sourceLastDate: string, alignedFirstDate: string,
 *   zeroCells: number, filledCells: number,
 * }}
 */
function buildGrid(parsed, endDate) {
  const shiftDays = daysBetween(parsed.lastDate, endDate);
  const alignedFirstDate = shiftIsoDate(parsed.firstDate, shiftDays);
  const dates = isoDatesBetween(alignedFirstDate, endDate);
  const indexByDate = new Map(dates.map((date, index) => [date, index]));
  const skus = [...parsed.units.keys()].sort();
  const values = new Map();
  let zeroCells = 0;

  for (const sku of skus) {
    const series = new Float64Array(dates.length);
    for (const [sourceDate, units] of parsed.units.get(sku)) {
      const index = indexByDate.get(shiftIsoDate(sourceDate, shiftDays));
      if (index === undefined) {
        throw new Error(`aligned date ${sourceDate} fell outside the grid`);
      }
      series[index] = units;
    }
    // A (SKU, day) with no sale is a real zero-demand day, not missing data.
    // Counting the zeros makes the "one missing cell" claim checkable in the docs.
    for (let index = 0; index < series.length; index += 1) {
      if (series[index] === 0) zeroCells += 1;
    }
    values.set(sku, series);
  }

  return {
    skus, dates, indexByDate, values, shiftDays,
    calendarDays: dates.length,
    sourceFirstDate: parsed.firstDate,
    sourceLastDate: parsed.lastDate,
    alignedFirstDate,
    zeroCells,
    filledCells: skus.length * dates.length - zeroCells,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Running the folds
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Runs every method on every fold and returns one observation per fold x SKU x
 * scored day, plus the parameters M4 picked.
 *
 * Nothing here reads a day after the fold's scored window, so a method cannot
 * see the future it is being judged on — the whole point of the exercise.
 *
 * @param {ReturnType<typeof buildGrid>} grid
 * @param {Float64Array} storeDaily Store-wide units per grid day (M6's shape).
 * @param {ReturnType<typeof buildFolds>} folds
 * @returns {{
 *   observations: Array<{fold: number, sku: string, date: string, horizon: number,
 *     actual: number, predictions: Record<string, number>}>,
 *   params: Array<{fold: number, sku: string, alpha: number, beta: number,
 *     gamma: number, sse: number}>,
 *   hwFallbacks: number,
 * }}
 */
function runFolds(grid, storeDaily, folds) {
  const observations = [];
  const params = [];
  let hwFallbacks = 0;

  for (const { fold, origin, scoredDates } of folds) {
    const originIndex = grid.indexByDate.get(origin);
    const trainingFrom = originIndex - HISTORY_DAYS + 1;
    if (trainingFrom < 0) {
      throw new Error(`fold ${fold}: origin ${origin} leaves fewer than ${HISTORY_DAYS} training days`);
    }
    const trainingDates = grid.dates.slice(trainingFrom, originIndex + 1);

    for (const sku of grid.skus) {
      const series = grid.values.get(sku);
      // The 28 training days, oldest first. A zero inside this slice is a day the
      // product did not sell, which is exactly what the models must learn from.
      const values = Array.from(series.subarray(trainingFrom, originIndex + 1));

      const m1 = seasonalNaiveForecast(values, HISTORY_DAYS - 1, HORIZON_DAYS);
      const m2 = movingAverageForecast(values, HISTORY_DAYS - 1, SEASON_LENGTH, HORIZON_DAYS);
      const m3 = flatForecast(
        velocityAverage({ dates: trainingDates, values }, origin, VELOCITY_DAYS),
        HORIZON_DAYS,
      );

      const gridFit = forecastHoltWinters(values, HORIZON_DAYS, { selection: 'grid' });
      let m4 = m3;
      if (gridFit) {
        m4 = gridFit.forecast;
        params.push({
          fold, sku, alpha: gridFit.params.alpha, beta: gridFit.params.beta,
          gamma: gridFit.params.gamma, sse: gridFit.sse,
        });
      } else {
        hwFallbacks += 1;
      }

      const m5 = M5_PRESETS.map((preset) => (
        forecastHoltWinters(values, HORIZON_DAYS, { selection: 'fixed', params: preset })?.forecast ?? m3
      ));

      const m6 = weekdayProfileForecast(
        values, storeDaily, grid.dates, originIndex, HISTORY_DAYS, HORIZON_DAYS,
      );

      scoredDates.forEach((date, offset) => {
        const actual = series[grid.indexByDate.get(date)];
        const predictions = { M1_seasonal_naive: m1[offset], M2_ma7: m2[offset], M3_velocity14: m3[offset], M4_hw_grid: m4[offset], M6_weekday_profile: m6[offset] };
        M5_KEYS.forEach((key, i) => { predictions[key] = m5[i][offset]; });
        observations.push({ fold, sku, date, horizon: offset + 1, actual, predictions });
      });
    }
  }

  return { observations, params, hwFallbacks };
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

/** Baseline every paired comparison is made against. */
const BASELINE_KEY = 'M1_seasonal_naive';

/** The engine that ships today — the reference an engine change has to beat. */
const INCUMBENT_KEY = 'M3_velocity14';

/** The method that would be served if FORECAST_ENGINE=holt_winters. */
const HOLT_WINTERS_KEY = 'M4_hw_grid';

/**
 * Reads the workbook, runs the folds and writes the result files.
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input || args.input === true) {
    throw new Error('--input "<path to London_Bakers_Dataset.xlsx>" is required');
  }
  const inputPath = path.resolve(REPO_ROOT, String(args.input));
  const endDate = requireIsoDate('end-date', args['end-date'] ?? DEFAULT_END_DATE);
  const devStart = requireIsoDate('dev-start', args['dev-start'] ?? DEFAULT_DEV_START);
  const devEnd = requireIsoDate('dev-end', args['dev-end'] ?? DEFAULT_DEV_END);
  const outDir = path.resolve(REPO_ROOT, String(args.out ?? 'docs/validation'));

  // ── The hold-out stays sealed, by construction ────────────────────────────
  if (devEnd < devStart) throw new Error(`--dev-end ${devEnd} is before --dev-start ${devStart}`);
  if (devEnd >= HOLD_OUT_START && devStart <= HOLD_OUT_END) {
    throw new Error(
      `refusing to run: dev window ${devStart}..${devEnd} touches the sealed hold-out ` +
      `${HOLD_OUT_START}..${HOLD_OUT_END}`,
    );
  }

  console.log('\n── Forecast backtest ──────────────────────────────────────────');
  console.log(`  workbook      : ${inputPath}`);
  console.log(`  sheet         : "${SHEET_NAME}"`);
  console.log(`  dev folds     : ${devStart} .. ${devEnd}  (${FOLD_COUNT} folds, ${FOLD_STEP_DAYS}-day step)`);
  console.log(`  hold-out      : ${HOLD_OUT_START} .. ${HOLD_OUT_END}  (SEALED — not read, not scored)`);
  console.log(`  history       : ${HISTORY_DAYS} days per fold · velocity ${VELOCITY_DAYS} · horizon ${HORIZON_DAYS}`);

  // ── 1/2 read + aggregate ──────────────────────────────────────────────────
  const readStartedAt = Date.now();
  const parsed = readPosSheet(inputPath);
  console.log('\n── POS lines ──────────────────────────────────────────────────');
  console.log(`  read in        : ${parsed.rowsRead} rows (${((Date.now() - readStartedAt) / 1000).toFixed(1)} s)`);
  console.log(`  kept           : ${parsed.rowsKept} rows`);
  for (const [reason, count] of Object.entries(parsed.excluded)) {
    if (count > 0) console.log(`      excluded ${reason.padEnd(22)} ${count}`);
  }
  console.log(`  (SKU, date)    : ${parsed.pairCount} pairs`);
  console.log(`  SKUs / dates   : ${parsed.units.size} / ${parsed.distinctDates}`);
  console.log(`  source range   : ${parsed.firstDate} .. ${parsed.lastDate}`);

  const report = runBacktest({ parsed, endDate, devStart, devEnd });
  writeReports({ report, inputPath, outDir });
  printSummary(report);
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────


/**
 * The selection rule, fixed before any number in this file was produced.
 * It is written into the JSON output so the rule and the result travel together.
 */
const SELECTION_RULE = [
  'Pick the method with the lowest pooled WAPE over the 7 dev folds.',
  'Accept it only if its paired per-SKU-day absolute error minus M1 seasonal naive',
  'has a 95% bootstrap interval entirely below 0 (i.e. it is reliably better).',
  'Otherwise record "no reliable improvement" and keep FORECAST_ENGINE = velocity.',
  'No preset, window or parameter is changed after these numbers are seen.',
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
 * not explode on a zero-demand day, which this dataset is full of.
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
 * Paired comparison against M1: for every SKU-day the difference in ABSOLUTE
 * error (method minus baseline), averaged, with a seeded bootstrap 95% interval.
 *
 * Negative mean = the method is closer to the truth than the baseline. If the
 * interval straddles 0, the two are indistinguishable on this data and the
 * honest reading is "no reliable improvement".
 *
 * @param {Array<{actual: number, predictions: Record<string, number>}>} observations
 * @param {string} methodKey
 * @param {string} baselineKey
 * @returns {{meanDiffUnits: number, ci95: [number, number], includesZero: boolean,
 *   observations: number, draws: number, seed: number, wins: number, losses: number}}
 */
function pairedBootstrap(observations, methodKey, baselineKey) {
  const diffs = observations.map((observation) => (
    Math.abs(observation.predictions[methodKey] - observation.actual)
    - Math.abs(observation.predictions[baselineKey] - observation.actual)
  ));
  const meanDiff = mean(diffs);
  const rng = mulberry32(BOOTSTRAP_SEED);
  const draws = new Float64Array(BOOTSTRAP_DRAWS);
  for (let d = 0; d < BOOTSTRAP_DRAWS; d += 1) {
    let sum = 0;
    for (let i = 0; i < diffs.length; i += 1) {
      sum += diffs[Math.floor(rng() * diffs.length)];
    }
    draws[d] = sum / diffs.length;
  }
  draws.sort();
  const lower = draws[Math.floor(0.025 * (BOOTSTRAP_DRAWS - 1))];
  const upper = draws[Math.floor(0.975 * (BOOTSTRAP_DRAWS - 1))];
  return {
    meanDiffUnits: meanDiff,
    ci95: [lower, upper],
    includesZero: lower <= 0 && upper >= 0,
    observations: diffs.length,
    draws: BOOTSTRAP_DRAWS,
    seed: BOOTSTRAP_SEED,
    wins: diffs.filter((value) => value < 0).length,
    losses: diffs.filter((value) => value > 0).length,
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
 * @param {{parsed: ReturnType<typeof readPosSheet>, endDate: string,
 *   devStart: string, devEnd: string}} input
 * @returns {object} Everything writeReports() and printSummary() need.
 */
function runBacktest({ parsed, endDate, devStart, devEnd }) {
  const grid = buildGrid(parsed, endDate);
  console.log('\n── Grid ───────────────────────────────────────────────────────');
  console.log(`  date shift     : ${grid.shiftDays >= 0 ? '+' : ''}${grid.shiftDays} days (last source day → ${endDate})`);
  console.log(`  aligned range  : ${grid.alignedFirstDate} .. ${endDate} (${grid.calendarDays} days)`);
  console.log(
    `  cells          : ${grid.filledCells} with units, ${grid.zeroCells} zero of ` +
    `${grid.skus.length * grid.calendarDays}`,
  );
  if (grid.alignedFirstDate > devStart) {
    throw new Error(`the workbook starts at ${grid.alignedFirstDate}, after the dev window ${devStart}`);
  }

  // Store-wide units per day: M6's shared weekday shape, and nothing else.
  const storeDaily = new Float64Array(grid.calendarDays);
  for (const sku of grid.skus) {
    const series = grid.values.get(sku);
    for (let index = 0; index < series.length; index += 1) storeDaily[index] += series[index];
  }

  const folds = buildFolds(devStart, devEnd);
  console.log('\n── Folds ──────────────────────────────────────────────────────');
  for (const fold of folds) {
    const last = fold.scoredDates[fold.scoredDates.length - 1];
    console.log(
      `  fold ${fold.fold}: origin ${fold.origin} → scored ${fold.scoredDates[0]}..${last} ` +
      `(${fold.scoredDates.length} days, h1..h${fold.scoredDates.length})`,
    );
  }

  const runStartedAt = Date.now();
  const { observations, params, hwFallbacks } = runFolds(grid, storeDaily, folds);
  console.log(`\n  scored SKU-days: ${observations.length} (${((Date.now() - runStartedAt) / 1000).toFixed(1)} s)`);
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
    .map((key) => ({ key, ...pairedBootstrap(observations, key, BASELINE_KEY) }));

  // The same paired test against the engine that is actually shipped today. The
  // selection rule above picks a METHOD; deciding whether to change an ENGINE also
  // needs to know whether the new engine beats the incumbent on the same SKU-days.
  const bootstrapVsIncumbent = METHOD_KEYS
    .filter((key) => key !== INCUMBENT_KEY)
    .map((key) => ({ key, ...pairedBootstrap(observations, key, INCUMBENT_KEY) }));

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
    config: {
      workbookSheet: SHEET_NAME,
      endpointDate: endDate,
      devWindow: { start: devStart, end: devEnd },
      holdOut: { start: HOLD_OUT_START, end: HOLD_OUT_END, sealed: true },
      folds: { count: FOLD_COUNT, stepDays: FOLD_STEP_DAYS, horizonDays: HORIZON_DAYS },
      historyDays: HISTORY_DAYS,
      velocityDays: VELOCITY_DAYS,
      m5Presets: M5_PRESETS,
      bootstrap: { draws: BOOTSTRAP_DRAWS, seed: BOOTSTRAP_SEED, baseline: BASELINE_KEY },
      generatedAt: new Date().toISOString(),
    },
    dataset: {
      rowsRead: parsed.rowsRead,
      rowsKept: parsed.rowsKept,
      excluded: parsed.excluded,
      pairCount: parsed.pairCount,
      skus: grid.skus.length,
      calendarDays: grid.calendarDays,
      sourceRange: { first: parsed.firstDate, last: parsed.lastDate },
      alignedRange: { first: grid.alignedFirstDate, last: endDate },
      shiftDays: grid.shiftDays,
      cellsWithUnits: grid.filledCells,
      zeroCells: grid.zeroCells,
    },
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
// Output
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Writes the raw results: four CSVs and one JSON. The JSON deliberately omits
 * the per-row observations (they live in the CSV) so it stays readable.
 * @param {{report: object, inputPath: string, outDir: string}} input
 * @returns {string[]} Absolute paths written.
 */
function writeReports({ report, inputPath, outDir }) {
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
  write('forecast_backtest_metrics.csv', toCsv(metricCols, metricRows));

  const foldRows = [];
  for (const fold of report.folds) {
    for (const row of fold.rows) {
      foldRows.push([fold.fold, fold.origin, fold.scoredFrom, fold.scoredTo, fold.scoredDays,
        row.key, row.n, round(row.wapePct), round(row.mae), round(row.biasPct)]);
    }
  }
  write(
    'forecast_backtest_by_fold.csv',
    toCsv(['fold', 'origin', 'scored_from', 'scored_to', 'scored_days', 'method', 'n',
      'wape_pct', 'mae', 'bias_pct'], foldRows),
  );

  const skuRows = [];
  for (const sku of report.topSkus) {
    for (const row of sku.rows) {
      skuRows.push([sku.sku, sku.productName, round(sku.actualUnits), row.key, row.n,
        round(row.wapePct), round(row.mae), round(row.biasPct)]);
    }
  }
  write(
    'forecast_backtest_top10_skus.csv',
    toCsv(['sku', 'product_name', 'actual_units', 'method', 'n', 'wape_pct', 'mae',
      'bias_pct'], skuRows),
  );

  const observationRows = report.observations.map((observation) => [
    observation.fold, observation.sku, observation.date, observation.horizon,
    observation.actual, ...METHOD_KEYS.map((key) => round(observation.predictions[key], 3)),
  ]);
  write(
    'forecast_backtest_observations.csv',
    toCsv(['fold', 'sku', 'date', 'horizon', 'actual', ...METHOD_KEYS], observationRows),
  );

  const paramRows = report.params.map((entry) => [
    entry.fold, entry.sku, entry.alpha, entry.beta, entry.gamma, round(entry.sse, 4),
  ]);
  write(
    'forecast_backtest_params.csv',
    toCsv(['fold', 'sku', 'alpha', 'beta', 'gamma', 'sse'], paramRows),
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
    'forecast_backtest_raw.json',
    JSON.stringify({
      ...summary,
      input: inputPath,
      parametersPicked: [...pickedCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([triple, count]) => ({ triple, count })),
    }, null, 2),
  );

  console.log(`\n── Written ────────────────────────────────────────────────────`);
  for (const file of written) console.log(`  ${path.relative(path.resolve(HERE, '..', '..', '..'), file)}`);
  return written;
}

// ─────────────────────────────────────────────────────────────────────────────
// Console report
// ─────────────────────────────────────────────────────────────────────────────

/** @returns {string} `text` padded or trimmed to `width` characters. */
function cell(text, width) {
  const value = String(text ?? '');
  return value.length > width ? value.slice(0, width) : value.padEnd(width);
}

/** @returns {string} A number formatted to two decimals, or a dash. */
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

  console.log('\n── Paired vs M1 (per SKU-day absolute-error difference) ───────');
  console.log(`  ${cell('method', 30)}${cell('mean diff', 12)}${cell('95% CI', 24)}verdict`);
  for (const entry of report.bootstrap) {
    const ci = `[${num(entry.ci95[0], 3)}, ${num(entry.ci95[1], 3)}]`;
    const verdict = entry.ci95[1] < 0 ? 'better' : (entry.ci95[0] > 0 ? 'worse' : 'no difference');
    console.log(`  ${cell(entry.key, 30)}${cell(num(entry.meanDiffUnits, 3), 12)}${cell(ci, 24)}${verdict}`);
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
  console.log(`  hold-out  : ${HOLD_OUT_START} .. ${HOLD_OUT_END} was NOT read\n`);
}

main().catch((err) => {
  console.error(`\n[forecastBacktest] ${err.message}\n`);
  process.exit(1);
});




