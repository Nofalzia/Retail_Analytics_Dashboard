# Detection validation results (T7a) — rule-based z-score engine vs naive baselines

Generated: 2026-10-08T15:26:58.643Z
Harness: `backend/scripts/validation/runDetectionValidation.js` — run with `npm run validate:detection` from `backend/`.
Sandbox tenant: `validation-sandbox` (`81ae0d97-3252-4209-9799-a440d51cd62d`) — isolated; no other tenant is read, written or deleted.

## Method

**Data generation.** For each of 20 generic products (`Test Product 01`..`Test Product 20`, SKUs
`VAL-001`..`VAL-020`) the generator draws a baseline daily mean uniformly from [6, 40] units/day and produces 90
daily values ending the day before the run:
`units = round(dailyMean × weekendMultiplier + N(0, 1.2·√dailyMean))`, `weekendMultiplier = 1.2` on
Saturday/Sunday, rounded and clamped to >= 0. A day whose value rounds to 0 produces no `sale_transactions` row
(`quantity_sold` has `CHECK (> 0)`) and is therefore absent from the `product_daily_velocity` view; the harness
counts and reports those days instead of masking them. All randomness comes from one seeded mulberry32 stream, so a
given seed reproduces byte-identical data.

**Ground truth.** 36 anomalies are injected per dataset — 18 spikes (multipliers 1.5, 2.0, 3.0; six each) and 18 drops
(multipliers 0.6, 0.4, 0.2; six each). Injection is restricted to days 21..90, at least 12 days apart within the same
product and never twice on the same product-day. Each ground-truth entry is
`{productSku, dayIndex, date, type, multiplier}`.

**Matching rule.** A flagged product-day counts as a true positive only when it matches a ground-truth anomaly on the
exact same `(SKU, date)` pair — no tolerance window, no date fuzziness, no per-product aggregation.
Precision = TP/(TP+FP), Recall = TP/(TP+FN), F1 = 2PR/(P+R); a zero denominator yields 0 (never NaN).

**Methods compared.** `runZScoreDetection` is called for real against the sandbox and its persisted
`anomaly_alerts` rows are scored at three severity cut-offs; then two naive fixed-percentage baselines are evaluated
on the same in-memory series — flag a day when `|units − mean(previous 14 days)| / mean(previous 14 days) > T` for
T = 0.30 and T = 0.50, skipping the first 14 days and any day whose 14-day mean is 0.

**Seeds.** 1, 2, 3, 4, 5 — five independent datasets. Reported figures are mean ± population standard deviation
(σ, divide by N) over those seeds. The engine writes severity with strict inequalities (`|z| > 2.5` critical,
`|z| > 2.0` warning, else info), so "warning+" means `severity IN ('warning','critical')`.

## Aggregate metrics (mean ± population sd over seeds 1–5)

| Method | Precision (mean ± sd) | Recall (mean ± sd) | F1 (mean ± sd) | TP / FP / FN (mean) |
|---|---|---|---|---|
| engine: all alerts (\|z\| > 1.5) | 0.130 ± 0.035 | 0.133 ± 0.032 | 0.131 ± 0.034 | 4.800 / 32.600 / 31.200 |
| engine: warning+ (\|z\| >= 2.0) | 0.365 ± 0.094 | 0.117 ± 0.021 | 0.175 ± 0.029 | 4.200 / 7.800 / 31.800 |
| engine: critical (\|z\| >= 2.5) | 0.500 ± 0.105 | 0.044 ± 0.014 | 0.081 ± 0.023 | 1.600 / 1.800 / 34.400 |
| baseline: \|dev\| > 30% (prev 14d mean) | 0.067 ± 0.006 | 0.856 ± 0.044 | 0.124 ± 0.011 | 30.800 / 433.800 / 5.200 |
| baseline: \|dev\| > 50% (prev 14d mean) | 0.171 ± 0.030 | 0.695 ± 0.043 | 0.272 ± 0.040 | 25.000 / 126.400 / 11.000 |

## Per-seed metrics (precision / recall / F1)

| Seed | engine: all alerts (\|z\| > 1.5) | engine: warning+ (\|z\| >= 2.0) | engine: critical (\|z\| >= 2.5) | baseline: \|dev\| > 30% (prev 14d mean) | baseline: \|dev\| > 50% (prev 14d mean) |
|---|---|---|---|---|---|
| 1 | 0.167 / 0.167 / 0.167 | 0.455 / 0.139 / 0.213 | 0.667 / 0.056 / 0.103 | 0.061 / 0.861 / 0.114 | 0.148 / 0.667 / 0.242 |
| 2 | 0.162 / 0.167 / 0.164 | 0.286 / 0.111 / 0.160 | 0.500 / 0.056 / 0.100 | 0.068 / 0.806 / 0.126 | 0.207 / 0.667 / 0.316 |
| 3 | 0.111 / 0.111 / 0.111 | 0.500 / 0.111 / 0.182 | 0.500 / 0.028 / 0.053 | 0.070 / 0.917 / 0.129 | 0.192 / 0.778 / 0.308 |
| 4 | 0.135 / 0.139 / 0.137 | 0.313 / 0.139 / 0.192 | 0.333 / 0.056 / 0.095 | 0.058 / 0.806 / 0.109 | 0.125 / 0.694 / 0.212 |
| 5 | 0.073 / 0.083 / 0.078 | 0.273 / 0.083 / 0.128 | 0.500 / 0.028 / 0.053 | 0.077 / 0.889 / 0.141 | 0.180 / 0.667 / 0.284 |

## Engine recall at the all-alerts cut-off, by anomaly type

| Anomaly type | Ground-truth days (pooled) | Detected (pooled) | Mean recall ± sd |
|---|---|---|---|
| drop | 90 | 11 | 0.122 ± 0.065 |
| spike | 90 | 13 | 0.144 ± 0.044 |

## Engine recall at the all-alerts cut-off, by injected multiplier

| Injected multiplier | Ground-truth days (pooled) | Detected (pooled) | Mean recall ± sd |
|---|---|---|---|
| ×0.2 | 30 | 5 | 0.167 ± 0.105 |
| ×0.4 | 30 | 4 | 0.133 ± 0.125 |
| ×0.6 | 30 | 2 | 0.067 ± 0.133 |
| ×1.5 | 30 | 5 | 0.167 ± 0.183 |
| ×2 | 30 | 5 | 0.167 ± 0.149 |
| ×3 | 30 | 3 | 0.100 ± 0.133 |

## Diagnostics

- Sale rows inserted per seed: 1799, 1800, 1795, 1797, 1798 (mean 1797.800, in chunks of 500).
- Product-days with zero sales per seed: 1, 0, 5, 3, 2 (mean 2.200). Each of those
  product-days has no `sale_transactions` row and is missing from `product_daily_velocity` — it is invisible to the
  engine. Reported, not fixed.
- Injected anomalies inside the engine's data window per seed: 9, 6, 6, 8, 6 of 36
  (window is `sale_date >= CURRENT_DATE - 14`; DB `CURRENT_DATE` = 2026-10-08, so the window
  starts 2026-09-24).
- `sales_spike` + `sales_drop` alerts persisted per seed: 36, 37, 36, 37, 41.
- Determinism check: seed 1 was executed twice in-process and both result hashes are
  `f8a2115dc4ba0e57463879f66187e641ea6888c9200f99733d5c3f604b0a9458` (sha256 over metrics + type/multiplier breakdowns; run-state counters are excluded
  because they legitimately differ between the first run of a seed and a repeat).
- Isolation check: sale rows owned by tenants other than the sandbox = 1080 before the run and
  1080 after the run — unchanged.
- Engine `runZScoreDetection` summary (seed 1):
  `{"created":36,"skipped_insufficient_data":0,"products_scanned":20}`.

## Observations — where the engine's real behaviour differed from the intended design

1. **Not a rolling window per day.** `runZScoreDetection` selects only
   `sale_date >= CURRENT_DATE - ROLLING_WINDOW_DAYS` (14 days) from `product_daily_velocity`, computes a **single**
   mean μ and population σ over that whole window, then tests every day of that same window against those numbers.
   In seed 1 only 9 of the 36 injected anomalies fall inside that window (per-seed counts
   are listed in Diagnostics), so recall is
   structurally capped and the engine columns describe *recent-window* behaviour, not *historical* detection.
2. **The tested day is inside its own baseline.** Because the anomaly contributes to μ and σ that it is compared
   against, a large spike inflates σ and shrinks its own |z|. The naive baselines look strictly backwards and do not
   have this self-masking effect.
3. **Zero-sales days are invisible.** `quantity_sold` must be > 0, so a day with no sales has no row and no velocity
   entry; a "drop to zero" cannot be detected at all by this engine.
4. **Alert identity and lag.** `alert_date` equals the sale date of the day tested (no detection delay), and
   `uq_anomaly_per_product_per_day` allows at most one row per `(tenant, store, product, alert_type, date)`.
5. **Severity boundaries are strict.** `zToSeverity` uses `>`, so a z-score of exactly 2.0 or 2.5 lands in the
   lower bucket (`info` / `warning` respectively). The three cut-offs above are read from the persisted
   `severity` column, not recomputed from `z_score`.
6. **Comparator caveat.** The baselines are scored over the full 90-day series (all 36 anomalies) while the engine can
   only reach the last 14 days, so the baseline rows are a reference point rather than a like-for-like competitor.
