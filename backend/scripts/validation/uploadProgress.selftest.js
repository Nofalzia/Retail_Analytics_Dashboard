/**
 * backend/scripts/validation/uploadProgress.selftest.js
 * ────────────────────────────────────────────────────────────────────────────
 * Tiny dependency-free self-test for utils/uploadProgress.js.
 *
 * Run from backend/:  npm run test:upload-progress
 * Exits 1 if any assertion fails.
 *
 * The cases are:
 *   1. the reported bug — a completed import that skipped rows is 100 %, not 69 %,
 *   2. a running import counts skipped + failed rows, not just written ones,
 *   3. a running import never reads 100 % before it is marked completed,
 *   4. a failed import is not shown as finished either,
 *   5. nothing counted yet is `null` (indeterminate), never 0 %,
 *   6. junk counters cannot make the bar go backwards or exceed its cap.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { computeProgressPct } from '../../src/utils/uploadProgress.js';

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

console.log('upload progress self-test');

// ── 1. The bug: skipped and rejected rows are part of the file ───────────────
{
  // The messy demo import: 3,599 data rows, 1,123 skipped by status, 5 rejected,
  // 2,471 written. The old arithmetic (rows_processed / total_rows) said 69 %.
  const messy = computeProgressPct({
    status: 'completed',
    totalRows: 3599,
    rowsProcessed: 2471,
    rowsFailed: 5,
    skippedByStatus: 1123,
  });
  check('a completed import that skipped rows reports 100 %, not 69 %', messy === 100);

  const settled = computeProgressPct({
    status: 'processing',
    totalRows: 3599,
    rowsProcessed: 2471,
    rowsFailed: 5,
    skippedByStatus: 1123,
  });
  check('the same counters on a running job read 99 % (not finished yet)', settled === 99);

  const writtenOnly = computeProgressPct({
    status: 'processing',
    totalRows: 3599,
    rowsProcessed: 2471,
    rowsFailed: 0,
    skippedByStatus: 0,
  });
  check('counting written rows only would have said 69 %', writtenOnly === 69);
}

// ── 2. Skipped rows move a partially finished bar ────────────────────────────
{
  // 60 written + 5 rejected + 25 skipped out of 100 = 90 % settled.
  const mixed = computeProgressPct({
    status: 'processing',
    totalRows: 100,
    rowsProcessed: 60,
    rowsFailed: 5,
    skippedByStatus: 25,
  });
  check('written + rejected + skipped rows all count towards progress', mixed === 90);

  // A stock-count import writes everything and skips nothing.
  const clean = computeProgressPct({
    status: 'processing',
    totalRows: 40,
    rowsProcessed: 40,
    rowsFailed: 0,
    skippedByStatus: 0,
  });
  check('a full mid-flight row set is capped at 99 %, never 100 %', clean === 99);
}

// ── 3. Terminal statuses ─────────────────────────────────────────────────────
{
  const failed = computeProgressPct({
    status: 'failed',
    totalRows: 10,
    rowsProcessed: 0,
    rowsFailed: 10,
    skippedByStatus: 0,
  });
  check('a failed import never reads 100 %', failed === 99);

  const emptyCompleted = computeProgressPct({
    status: 'completed',
    totalRows: 0,
    rowsProcessed: 0,
    rowsFailed: 0,
    skippedByStatus: 0,
  });
  check('a completed job with no rows still reports 100 %', emptyCompleted === 100);
}

// ── 4. Nothing counted yet ───────────────────────────────────────────────────
{
  check('no total rows yet is null (indeterminate), not 0 %',
    computeProgressPct({ status: 'processing' }) === null);
  check('a null total with real counters is still null',
    computeProgressPct({ status: 'processing', totalRows: null, rowsProcessed: 5 }) === null);
  check('an explicit zero total is null',
    computeProgressPct({ status: 'processing', totalRows: 0, rowsProcessed: 0 }) === null);
}

// ── 5. Junk counters are clamped, not trusted ────────────────────────────────
{
  const strings = computeProgressPct({
    status: 'processing',
    totalRows: '200',
    rowsProcessed: '50',
    rowsFailed: '0',
    skippedByStatus: '50',
  });
  check('numeric strings (pg text columns) are parsed', strings === 50);

  const junk = computeProgressPct({
    status: 'processing',
    totalRows: 100,
    rowsProcessed: 'many',
    rowsFailed: -4,
    skippedByStatus: undefined,
  });
  check('unparseable and negative counters count as zero', junk === 0);

  const over = computeProgressPct({
    status: 'processing',
    totalRows: 100,
    rowsProcessed: 120,
    rowsFailed: 10,
    skippedByStatus: 10,
  });
  check('a settled count above the total is clamped to 99 %', over === 99);
}

if (failures === 0) {
  console.log('\n✅ upload progress self-test passed');
} else {
  console.error(`\n❌ upload progress self-test failed (${failures} assertion(s))`);
  process.exitCode = 1;
}
