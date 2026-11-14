/**
 * backend/scripts/validation/validators.selftest.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Tiny dependency-free self-test for utils/validators.js (T12a).
 *
 * Run from backend/:  npm run test:validators
 * Exits 1 if any assertion fails.
 *
 * The cases are:
 *   1. header aliases + normalisation (punctuation, bracketed units),
 *   2. a line total becomes the net unit price (total / quantity),
 *   3. cost and SKU are optional — and any estimate is reported, not hidden,
 *   4. a cancelled row is skipped rather than failed,
 *   5. a missing requirement is named once, with the headers we did find,
 *   6. flexible dates (T12b): ISO, Excel serials, day-first dates, month names.
 * ──────────────────────────────────────────────────────────────────────────────
 */

import {
  COST_RATIO_DEFAULT,
  DAY_FIRST_ASSUMPTION,
  NO_SKU_ASSUMPTION,
  buildColumnMap,
  describeCostAssumption,
  parseFlexibleDate,
  validateRow,
} from '../../src/utils/validators.js';

let failures = 0;

/** @throws never — records and prints the outcome of one assertion. */
function check(name, condition) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

/** @returns {number} `value` rounded to 2 dp, the same way validateRow does. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

console.log('validators self-test');

// ── 1. Aliases and normalisation ─────────────────────────────────────────────
{
  const { map, missing, warnings, assumptions } = buildColumnMap([
    'Sale Date',
    'Qty (Units)',
    'Unit Price (PKR)',
    'Item Code',
    'Cost Price',
  ]);
  check('aliases resolve to canonical columns',
    map.date === 'Sale Date'
    && map.quantity_sold === 'Qty (Units)'
    && map.unit_price === 'Unit Price (PKR)'
    && map.sku === 'Item Code'
    && map.unit_cost === 'Cost Price');
  check('a fully mapped file has no missing requirements', missing.length === 0);
  check('a fully supplied file assumes nothing', assumptions.length === 0);
  check('recognised aliases are not warned about', warnings.length === 0);
}

// ── 2. A line total becomes the net unit price ───────────────────────────────
{
  const { map } = buildColumnMap(['date', 'product', 'qty', 'Total Price']);
  const row = { date: '2026-10-01', product: 'Widget A', qty: '4', 'Total Price': '100.00' };
  const result = validateRow(row, map, 2);
  check('line total / quantity = net unit price',
    result.error === null && result.data?.unit_price === 25);
  check('a line-total file needs no unit_price column',
    !map.unit_price && map.total_revenue === 'Total Price');
}

// ── 3. Cost and SKU are optional, and estimates are reported ─────────────────
{
  const { map } = buildColumnMap(['date', 'product', 'qty', 'price']);
  const row = { date: '2026-10-02', product: 'Widget B', qty: '2', price: '50' };
  const result = validateRow(row, map, 3);
  check('missing unit_cost -> cost estimated at the default ratio',
    result.data?.unit_cost === round2(50 * COST_RATIO_DEFAULT));
  check('missing unit_cost -> assumption reported',
    result.assumptions.includes(describeCostAssumption()));
  check('missing SKU -> product name becomes the SKU',
    result.data?.sku === 'Widget B' && result.assumptions.includes(NO_SKU_ASSUMPTION));

  // The same row with both optional columns present makes no assumptions.
  const supplied = buildColumnMap(['date', 'sku', 'unit price', 'quantity', 'unit cost']);
  const suppliedRow = {
    date: '2026-10-02', sku: 'SKU-1', 'unit price': '50', quantity: '2', 'unit cost': '30',
  };
  const suppliedResult = validateRow(suppliedRow, supplied.map, 4);
  check('supplied cost and SKU are used verbatim with no assumptions',
    suppliedResult.data?.unit_cost === 30
    && suppliedResult.data?.sku === 'SKU-1'
    && suppliedResult.assumptions.length === 0);
}

// ── 4. Status filter skips, never fails ──────────────────────────────────────
{
  const { map } = buildColumnMap(['date', 'sku', 'qty', 'price', 'status']);
  const cancelled = validateRow(
    { date: '2026-10-03', sku: 'SKU-2', qty: '1', price: '10', status: 'Cancelled' },
    map,
    5,
  );
  check('a cancelled row is skipped, not failed',
    cancelled.skipped === 'status' && cancelled.data === null && cancelled.error === null);

  const completed = validateRow(
    { date: '2026-10-03', sku: 'SKU-2', qty: '1', price: '10', status: 'Completed' },
    map,
    6,
  );
  check('a completed row is imported normally',
    completed.skipped === null && completed.data?.quantity_sold === 1);
}

// ── 5. Missing requirements name what exists too ─────────────────────────────
{
  const { missing, detectedHeaders } = buildColumnMap(['Date', 'SKU', 'Qty']);
  check('no price column -> price requirement reported missing',
    missing.length === 1 && missing[0] === 'unit_price or total_revenue');
  check('detected headers are echoed for the UI',
    detectedHeaders.join('|') === 'Date|SKU|Qty');
}

// ── 6. Flexible dates: ISO, Excel serials, day-first, month names ────────────
{
  check('ISO date parses', parseFlexibleDate('2025-10-12') === '2025-10-12');
  check('ISO datetime keeps its calendar day',
    parseFlexibleDate('2025-10-12T08:30:00') === '2025-10-12');
  check('Excel serial 45658 is 2025-01-01, not 1970',
    parseFlexibleDate(45658) === '2025-01-01');
  check('DD/MM/YYYY parses when the day is over 12',
    parseFlexibleDate('31/12/2025') === '2025-12-31');

  const ambiguousAssumptions = [];
  const ambiguousDate = parseFlexibleDate('03/04/2025', ambiguousAssumptions);
  check('an ambiguous slash date is read day-first', ambiguousDate === '2025-04-03');
  check('an ambiguous slash date records the day-first assumption',
    ambiguousAssumptions.includes(DAY_FIRST_ASSUMPTION));

  check('an impossible date is rejected', parseFlexibleDate('13/25/2025') === null);
  check('a JS Date keeps its calendar day',
    parseFlexibleDate(new Date(2025, 9, 12)) === '2025-10-12');
  check('month names parse in both orders',
    parseFlexibleDate('12 Oct 2025') === '2025-10-12'
    && parseFlexibleDate('Oct 12, 2025') === '2025-10-12');
  check('a year before 2000 is rejected', parseFlexibleDate('12/10/1999') === null);

  // The row validator must use the same parser — and quote what it could not read.
  const { map } = buildColumnMap(['date', 'sku', 'qty', 'price']);
  const badDate = validateRow({ date: 'not a date', sku: 'SKU-3', qty: '1', price: '5' }, map, 7);
  check('an unparseable date is a row error quoting the raw value',
    badDate.error !== null && badDate.error.includes('"not a date"'));

  const serialRow = validateRow({ date: 45658, sku: 'SKU-4', qty: '1', price: '5' }, map, 8);
  check('a workbook serial becomes a real sale_date',
    serialRow.error === null && serialRow.data?.sale_date === '2025-01-01');

  const ambiguousRow = validateRow(
    { date: '03/04/2025', sku: 'SKU-5', qty: '1', price: '5' },
    map,
    9,
  );
  check('the day-first assumption reaches the row result too',
    ambiguousRow.data?.sale_date === '2025-04-03'
    && ambiguousRow.assumptions.includes(DAY_FIRST_ASSUMPTION));
}

if (failures === 0) {
  console.log('\n✅ validators self-test passed');
} else {
  console.error(`\n❌ validators self-test failed (${failures} assertion(s))`);
  process.exitCode = 1;
}
