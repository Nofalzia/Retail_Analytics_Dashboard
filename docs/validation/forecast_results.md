# Forecast backtest on the REAL London Bakers data — dev folds only (Phase 2)

**Verdict: Holt-Winters does not beat the shipping velocity baseline, and `FORECAST_ENGINE` stays
`velocity`.** On the real five-week point-of-sale export it scored **44.55 % WAPE against velocity's
31.48 %** and was worse in **7 of 7 folds**; the paired difference is **+1.554 units per SKU-day,
95 % block-bootstrap CI [1.259, 1.756]** — reliably worse. No parameter, window or preset was changed
after the numbers were seen.

> **Data provenance.** This report is computed from
> `Real London Bakers 5 Week Performance.xlsx`, sheet `POS Sales Log`: **13,544 line items, 35 calendar
> days (2026-09-01 … 2026-10-05), 50 SKUs, no status column, no date shift.** The sealed week
> (2026-09-29 … 2026-10-05, 2,710 rows) is **dropped at read time** and was never scored. The earlier
> report in this folder, `forecast_results_synthetic.md`, was built on an extrapolated 731-day series
> and is **not** accuracy evidence.

| | |
|---|---|
| Branch | `feature/hisaabiq-ml` |
| Data | `Real London Bakers 5 Week Performance.xlsx` → sheet `POS Sales Log` (passed by path, never committed) |
| Script | `backend/scripts/validation/forecastBacktest.js` (`--data-kind real`, the default) |
| Raw output | `forecast_backtest_metrics.csv`, `forecast_backtest_by_fold.csv`, `forecast_backtest_top10_skus.csv`, `forecast_backtest_weekday_pattern.csv`, `forecast_backtest_observations.csv`, `forecast_backtest_params.csv`, `forecast_backtest_raw.json` |
| Frozen decision | `docs/validation/frozen_config.json` |
| Superseded first pass | `forecast_results_synthetic.md`, `frozen_config_synthetic_superseded.json` |

---

## 1. What changed after the wrong-data run

The first Phase 2 pass read `London_Bakers_Dataset.xlsx` — an extrapolated 731-day series
(304,614 rows, 2023-10-01 … 2025-09-30) that had been shifted +377 days and filtered on a
`Status` column. It answered a question about a synthetic series, not about this store. Everything
below is recomputed on the real export, with the original agreed design:

* dev window **2026-09-01 … 2026-09-28**, hold-out **2026-09-29 … 2026-10-05** sealed;
* **expanding** training windows, origins **2026-09-21 … 2026-09-27** (7 origins, min 21 training days);
* scored **only inside the dev window**;
* same methods, metrics, horizon buckets, top-10 table, Poisson floor and selection rule;
* the SKU-day bootstrap replaced by a **block bootstrap over calendar days** (§7).

## 2. Input guards, and proof they fire

`--data-kind real` (default) prints a banner with rows, distinct days, min/max date and the data kind,
then **aborts** unless the workbook spans 2026-09-01 … 2026-10-05, has fewer than 50,000 rows and at
most 35 distinct days. `--end-date` is refused on real data: the real export is never date-shifted.
Rows outside the dev window are discarded before aggregation, so the sealed week cannot reach the grid.

Run on the real workbook (this report):

```
  DATA KIND     : REAL — real point-of-sale export (accuracy evidence)
  rows in sheet : 13,544 (13,544 valid lines)
  rows used     : 10,834 inside 2026-09-01 .. 2026-09-28
  rows dropped  : 2,710 outside the dev window (never enter the grid)
  distinct days : 35 in file · 28 used
  date range    : 2026-09-01 .. 2026-10-05 in file · 2026-09-01 .. 2026-09-28 used
  guard PASS   : rows in sheet — 13,544 must be < 50,000
  guard PASS   : first date — 2026-09-01 must be >= 2026-09-01
  guard PASS   : last date — 2026-10-05 must be <= 2026-10-05
  guard PASS   : distinct days — 35 must be <= 35
  guard PASS   : covers dev window — file must start on or before 2026-09-01 and reach 2026-09-28
  status column : none (no status filter applied)
```

Run on the extrapolated series, which is exactly the mistake being guarded against:

```
[forecastBacktest] the workbook does not look like the real London Bakers export
(2026-09-01 .. 2026-10-05, < 50,000 rows, <= 35 days):
  - rows in sheet: 304,614 must be < 50,000
  - first date: 2023-10-01 must be >= 2026-09-01
  - distinct days: 731 must be <= 35
  - covers dev window: file must start on or before 2026-09-01 and reach 2026-09-28
An extrapolated 731-day series (London_Bakers_Dataset.xlsx) is NOT accuracy evidence.
Re-run with --data-kind synthetic if that is genuinely what you mean to measure.
```

A `--data-kind synthetic` run skips those coverage checks, may shift dates onto `--end-date`, and
writes every artifact with a `_synthetic` suffix plus a "NOT ACCURACY EVIDENCE" banner in the console,
the JSON and this document's sibling.

## 3. Data actually read

| | |
|---|---|
| Line items in `POS Sales Log` | 13,544 |
| Valid lines (ISO date, SKU, `Quantity > 0`) | 13,544 (no rejections: no blank SKU, no zero/negative quantity, no bad date) |
| Lines inside the dev window (used) | 10,834 |
| Lines dropped as sealed/out-of-window | 2,710 (2026-09-29 … 2026-10-05) |
| `(SKU, day)` pairs after `SUM(Quantity)` | 1,399 |
| SKUs / calendar days used | 50 / 28 |
| Grid cells (SKU × day) | 1,400 — **1,399 with units, exactly 1 day with no sale** |
| Scored SKU-days | 1,400 (28 scored days × 50 SKUs) |
| Actual units in the scored window | 16,660 (11.90 units per SKU-day) |

The single zero cell is a real no-sale day for one product, zero-filled exactly as production's
`buildContiguousSeries` does. There is no missing calendar day: 28 of the file's 35 days are used and
the other 7 are the sealed week.

## 4. Protocol (fixed before the run)

**Folds — expanding training windows.** Each origin trains on every day from 2026-09-01 up to the
origin and projects 7 days; only days inside the dev window are scored.

| Fold | Training window | Train days | HW update steps | Scored days | Scored range |
|---|---|---|---|---|---|
| 1 | 2026-09-01 … 2026-09-21 | 21 | 14 | 7 | 2026-09-22 … 2026-09-28 |
| 2 | 2026-09-01 … 2026-09-22 | 22 | 15 | 6 | 2026-09-23 … 2026-09-28 |
| 3 | 2026-09-01 … 2026-09-23 | 23 | 16 | 5 | 2026-09-24 … 2026-09-28 |
| 4 | 2026-09-01 … 2026-09-24 | 24 | 17 | 4 | 2026-09-25 … 2026-09-28 |
| 5 | 2026-09-01 … 2026-09-25 | 25 | 18 | 3 | 2026-09-26 … 2026-09-28 |
| 6 | 2026-09-01 … 2026-09-26 | 26 | 19 | 2 | 2026-09-27 … 2026-09-28 |
| 7 | 2026-09-01 … 2026-09-27 | 27 | 20 | 1 | 2026-09-28 |

28 scored days in total. The service's `historyDays = 28` is never reached — a fold uses the 21–27
days it has. **Holt-Winters still runs** (it needs ≥ 14), but its initialisation consumes two full
seasons (14 days) and its parameter grid is fitted on only **14–20 one-step-ahead errors**, i.e. one
pass over the data after initialisation. That is a real handicap and it is stated as such in §11.

**Methods.** M1 seasonal naive (same weekday last week) · M2 7-day moving average, flat · M3 velocity
(production baseline: mean of the 14 days before the origin, `velocityAverage()` from
`src/services/forecastService.js`) · M4 Holt-Winters with the in-service grid search, i.e. exactly what
the API would serve · M5 Holt-Winters with `beta = 0` and 9 fixed (alpha, gamma) presets · M6 store
weekday profile × SKU level.

**Metrics.** WAPE (Σ|error| / Σactual, headline), MAE, signed bias; pooled, per fold, per horizon
bucket (h1-3 / h4-7) and per top-10 SKU. Read against the Poisson noise floor: with mean demand
11.90 units/SKU-day, even a perfect forecast of the mean has WAPE ≈ **23.13 %**, so no method can
approach zero.

**Selection rule (verbatim from the script).** Pick the method with the lowest pooled WAPE over the 7
expanding-window dev folds. Accept it only if its paired per-SKU-day absolute error minus M1 seasonal
naive has a 95 % block-bootstrap interval (calendar-day blocks) entirely below 0. Otherwise record "no
reliable improvement" and keep `FORECAST_ENGINE = velocity`. No preset, window or parameter is changed
after these numbers are seen.

**Disclosed addition.** The rule selects a *method*; changing an *engine* additionally requires that
the winner be one of the two implemented engines (`velocity`, `holt_winters`) **and** reliably beat the
engine shipping today. That second test does not alter any number in §5–§8.

## 5. Dev results — pooled over 1,400 scored SKU-days

| Method | WAPE % | MAE (units) | Bias % | n |
|---|---|---|---|---|
| **M6 weekday profile** | **30.82** | **3.67** | +3.01 | 1400 |
| M3 velocity (shipped) | 31.48 | 3.75 | +2.71 | 1400 |
| M2 7-day moving average | 32.35 | 3.85 | +3.96 | 1400 |
| M5 HW a=0.3 g=0.5 | 42.06 | 5.01 | +6.19 | 1400 |
| M5 HW a=0.2 g=0.5 | 42.19 | 5.02 | +6.74 | 1400 |
| M5 HW a=0.2 g=0.3 | 42.59 | 5.07 | +6.30 | 1400 |
| M5 HW a=0.3 g=0.3 | 42.64 | 5.07 | +5.80 | 1400 |
| M5 HW a=0.2 g=0.2 | 43.59 | 5.19 | +6.11 | 1400 |
| M5 HW a=0.3 g=0.2 | 43.61 | 5.19 | +5.63 | 1400 |
| M5 HW a=0.5 g=0.5 | 43.62 | 5.19 | +4.81 | 1400 |
| **M4 HW grid (the candidate engine)** | **44.55** | 5.30 | +6.50 | 1400 |
| M5 HW a=0.5 g=0.3 | 44.64 | 5.31 | +4.64 | 1400 |
| M1 seasonal naive | 45.71 | 5.44 | +5.84 | 1400 |
| M5 HW a=0.5 g=0.2 | 45.73 | 5.44 | +4.58 | 1400 |

Poisson noise floor **23.13 %**. M3 velocity sits 8.35 points above the floor; M6 7.69 points above;
M4 Holt-Winters 21.42 points above — it is not measuring demand, it is adding error to it.

## 6. Horizon buckets

| Method | h1-3 WAPE % | h4-7 WAPE % | Growth |
|---|---|---|---|
| M6 weekday profile | 30.18 | 32.00 | +1.82 |
| M3 velocity | 30.95 | 32.47 | +1.52 |
| M2 7-day MA | 31.65 | 33.62 | +1.97 |
| M5 HW best (a=0.3 g=0.5) | 40.29 | 45.32 | +5.03 |
| M4 HW grid | 43.52 | 46.44 | +2.92 |
| M1 seasonal naive | 44.49 | 47.93 | +3.44 |

A method whose seasonal component is working should degrade *less* than a flat baseline as the horizon
extends. Holt-Winters degrades more (+2.92 vs +1.52 points): its seasonality is not paying for itself.

## 7. Paired comparisons — block bootstrap over calendar days

**Interval method.** Every method is paired with M1 on the *same* SKU-day, using the difference in
absolute error (method − M1). The 95 % interval is a **block bootstrap over calendar days**, seeded
(2,000 draws, seed `20260917`): within a fold the seven horizons are projections of one fit and all
SKUs are observed on the same day, so SKU-days are not independent and the calendar day is the unit
that carries the shared shock. Each draw resamples the 7 scored days with replacement and pools every
observation on the selected days, so the bootstrap estimator matches the point estimate
(observation-weighted).

**Coarse by construction.** The dev window yields only **7 blocks** (50, 100, 150, 200, 250, 300, 350
observations each — blocks grow because later dates are scored by more folds). Seven resampling units
is very few; the intervals are indicative, not exact. That limitation cuts both ways: they cannot
certify a small win *or* a small loss.

| Method | Mean diff (units/SKU-day) | 95 % CI | Verdict |
|---|---|---|---|
| M6 weekday profile | −1.771 | [−2.085, −1.398] | reliably better than M1 |
| M3 velocity | −1.693 | [−2.069, −1.304] | reliably better than M1 |
| M2 7-day MA | −1.590 | [−1.967, −1.219] | reliably better than M1 |
| M5 HW a=0.3 g=0.5 | −0.434 | [−0.808, −0.133] | reliably better than M1 |
| M5 HW a=0.2 g=0.5 | −0.418 | [−0.841, −0.126] | reliably better than M1 |
| M4 HW grid | −0.138 | [−0.544, 0.223] | no difference from M1 |
| other 7 M5 presets | −0.371 … +0.003 | all straddle 0 | no difference from M1 |

**Against the engine that ships today** (same block bootstrap, baseline M3):

| Method | Mean diff (units/SKU-day) | 95 % CI | Wins / losses (SKU-days) | Verdict |
|---|---|---|---|---|
| **M4 Holt-Winters** | **+1.554** | **[1.259, 1.756]** | 494 / 906 | **reliably worse than velocity** |
| M6 weekday profile | −0.079 | [−0.222, 0.046] | 724 / 676 | no reliable difference |
| M2 7-day MA | +0.103 | [0.066, 0.141] | — | reliably worse than velocity |

Reading: M6 is the best method on pooled WAPE but its advantage over velocity is ~0.08 units per
SKU-day and **not distinguishable from zero** on seven day-blocks. Holt-Winters is worse than velocity
by a factor of twenty, and that difference is unambiguous.

## 8. Per fold

| Fold | Train days | M6 | M3 | M2 | M4 | M1 |
|---|---|---|---|---|---|---|
| 1 | 21 | 30.24 | 31.04 | 31.93 | 43.90 | 43.98 |
| 2 | 22 | 30.45 | 31.06 | 32.09 | 43.37 | 45.07 |
| 3 | 23 | 29.83 | 29.98 | 31.37 | 43.31 | 44.52 |
| 4 | 24 | 30.49 | 30.77 | 31.54 | 43.56 | 45.96 |
| 5 | 25 | 33.06 | 33.71 | 34.00 | 46.40 | 48.18 |
| 6 | 26 | 33.59 | 35.34 | 35.13 | 51.59 | 51.83 |
| 7 | 27 | 31.56 | 33.66 | 34.86 | 47.48 | 47.58 |

WAPE % per fold. **Holt-Winters is worse than velocity in 7 of 7 folds** (by 12.4 to 17.9 points) and
never beats it. M6 is below velocity in 7 of 7 folds, but by 0.15–1.75 points only. Folds 5–7 are scored
on 3, 2 and 1 days, so their WAPE is noisier than fold 1's.

## 9. Per-SKU — top 10 by actual units in the scored window

| SKU | Product | Units | M6 | M3 | M4 |
|---|---|---|---|---|---|
| SKU-111 | Sugar-Free Jalebi (250g) | 461 | 21.3 | 16.6 | 25.9 |
| SKU-149 | Almond Milk | 445 | 35.9 | 39.2 | 53.5 |
| SKU-102 | Multigrain Bread | 425 | 31.2 | 34.6 | 25.2 |
| SKU-110 | Jalebi (250g) | 417 | 16.5 | 19.1 | 38.6 |
| SKU-115 | Chicken Cheese Shawarma | 402 | 28.0 | 38.4 | 46.2 |
| SKU-108 | Namak Paray (250g) | 394 | 17.1 | 20.0 | 32.7 |
| SKU-123 | Pizza (Large) | 392 | 23.0 | 28.4 | 35.5 |
| SKU-106 | Halwa | 389 | 33.6 | 32.9 | 31.2 |
| SKU-131 | Fried Round Sandwich | 389 | 27.0 | 27.4 | 21.8 |
| SKU-109 | Shakar Paray (250g) | 379 | 37.3 | 42.0 | 52.7 |

WAPE %. M6 beats velocity on 8 of the 10; M4 beats velocity on 3 of 10 (Multigrain Bread, Halwa,
Fried Round Sandwich) and loses badly on the rest. The SKUs where HW wins are the high-volume,
high-regularity ones — the shape of evidence a longer history would need.

## 10. Store weekday pattern (context, from SUM of units per day)

Computed on the **28 dev days only** — SUM of units per day, then mean per weekday. The sealed week's
totals were not used (its rows are dropped before any aggregation), so this table cannot leak the
hold-out.

| Weekday | Mean units/day | Index vs overall | Days | Min … max | CV % |
|---|---|---|---|---|---|
| Saturday | 653.0 | 1.083 | 4 | 627 … 691 | 4.3 |
| Sunday | 641.8 | 1.064 | 4 | 589 … 680 | 6.1 |
| Wednesday | 596.5 | 0.989 | 4 | 560 … 616 | 4.4 |
| Thursday | 593.5 | 0.984 | 4 | 541 … 629 | 6.3 |
| Friday | 592.5 | 0.983 | 4 | 565 … 610 | 3.5 |
| Monday | 572.3 | 0.949 | 4 | 557 … 590 | 2.5 |
| Tuesday | 571.0 | 0.947 | 4 | 537 … 590 | 4.4 |

Overall mean **603.7 units/day**. The pattern is real but modest: the weekend runs about 8 % above the
overall mean and Tuesday/Monday about 5 % below. **35 days is 5 observations per weekday (4 in the dev
window), so the uncertainty is wide** — a coefficient of variation of 2.5–6.3 % between the four
observations of a single weekday means an "8 % weekend effect" is only a couple of multiples of the
per-weekday noise, measured on one store in one five-week window. It is context for why M6 helps a
little and Holt-Winters's full seasonal decomposition helps not at all; it is not a seasonal estimate
anyone should hard-code.

## 11. Why Holt-Winters lost

The grid searched 224 parameter triples per fit (350 fits: 7 folds × 50 SKUs, no fallbacks):

* **`alpha = 0.1`, the lowest value on the grid, was chosen in 232 of 350 fits (66 %).** The selector is
  sitting on its own boundary: given 14–20 observations it prefers an almost-constant level, i.e. it
  declines to learn.
* **`beta = 0` in 260 of 350 fits (74 %)** — no trend, as expected on three to four weeks of data.
* `gamma` spread across 0.1–0.7 with 0.7 most common (48 fits under `alpha = 0.1`), so the seasonal
  update takes almost all of the weight — which on this little data is mostly fitting noise.
* The fit minimises SSE over **14–20 one-step-ahead errors** (21–27 training days minus the 14-day
  two-season initialisation). That is one pass after initialisation: too few to settle level, trend and
  seven seasonal factors at once.
* Consequences in the metrics: **bias +6.50 %** (it over-forecasts) versus velocity's +2.71 %;
  **h4-7 degrades by 2.92 points versus velocity's 1.52**; and the whole method lands within **1.16
  points of seasonal naive** (44.55 vs 45.71) — it behaves like a noisy "repeat last week", not like a
  seasonal model.

None of this is a verdict on Holt-Winters as a method given a year of data. It is a verdict on
Holt-Winters on this evidence: three to four weeks, 50 SKUs, one store, 14–20 update steps.

## 12. Decision

1. **`FORECAST_ENGINE` stays `velocity`.** Holt-Winters is reliably worse than velocity
   (+1.554 units/SKU-day, CI [1.259, 1.756]), 13.07 WAPE points worse, and worse in 7 of 7 folds. No
   config, service or route change was made for it.
2. **The selection rule picked M6** (lowest pooled WAPE 30.82, reliably better than M1), and M6 is
   recorded as a **Phase 5 candidate** — but it is not a shipped engine, and its edge over velocity
   (−0.079, CI [−0.222, 0.046]) is **not reliable**, so nothing is switched on.
3. **Nothing was tuned after seeing these numbers.** No preset, window, fold or bucket was changed.
4. **M7 (ridge regression) was not run**: its precondition was Holt-Winters beating velocity. It does
   not.

## 13. Limitations

* **Short data.** 35 days total, 28 scored days; 1,400 SKU-days; one store; 50 SKUs. Scoring effectively
  covers 2026-09-22 … 2026-09-28 (the origins sit in the week before it).
* **Fold geometry.** Fold 1 carries 350 observations and fold 7 carries 50; pooled WAPE is
  observation-weighted, so early folds dominate. h7 is scored once, h1 is scored seven times.
* **Bootstrap resolution.** 7 calendar-day blocks → coarse 95 % intervals. Read every CI as indicative.
* **Training length.** Expanding windows of 21–27 days are *shorter* than production's
  `historyDays = 28`, so this is a slightly pessimistic test of both engines — and a much more
  pessimistic test of Holt-Winters, which is why §4 and §11 state it explicitly.
* **No covariates.** No promotions, holidays, price changes, weather or stockouts; a day with no sale is
  zero demand (exactly 1 such cell in the dev window).
* **Single sample.** One backtest, one seed; no re-runs across other stores or periods.
* **Seal integrity.** The workbook physically contains the hold-out week; this run proves it excluded it
  (2,710 rows dropped at read time, all scoring bounded by 2026-09-28, `holdOut.evaluated: false` in
  `frozen_config.json`).

## 14. Reproduce

From `backend/` (CMD on Windows):

```
node scripts/validation/forecastBacktest.js --input "C:\Users\Nofal Zia\Desktop\FYP Test files\Real London Bakers 5 Week Performance.xlsx"
```

or

```
npm run validate:forecast -- --input "C:\Users\Nofal Zia\Desktop\FYP Test files\Real London Bakers 5 Week Performance.xlsx"
```

Both regenerate the seven artifacts in `docs/validation/` identically (the only RNG in the script is the
seeded bootstrap). To watch the guard refuse the extrapolated series:

```
node scripts/validation/forecastBacktest.js --input "C:\Users\Nofal Zia\Desktop\London Bakers Data\London_Bakers_Dataset.xlsx"
```

Expected: banner with `DATA KIND: REAL`, four failing guard lines, the abort message quoted in §2, exit
code 1.

## 15. Side effects — database state left behind

The backtest itself touches **no database**: it reads the workbook from disk and writes files. What this
line of work (Phase 1–2) has changed in the dev database is listed here for the record. Nothing below was
written after this commit; no DDL, migration or delete was run.

| Tenant | Change | Volume |
|---|---|---|
| `london-bakers-i10` | `sale_transactions` + `products` + `stores` seeded from the earlier (extrapolated) workbook via `bakery:prepare` / `bakery:seed` — **Phase 0/1, before this task** | 36,051 sale rows, 50 products, 1 store |
| `london-bakers-i10` | One inventory upload (`POST /api/upload`, `inventory_snapshot.csv`) → 1 completed `ingestion_jobs` row + `inventory_logs` | 50 `inventory_logs` rows |
| `london-bakers-i10` | Analysis pass triggered by that upload | 40 `anomaly_alerts` + 40 `recommendations` |
| `demo-kiryana` | Read only (`GET /api/stockout`, `GET /api/forecast`) for the default-path proof | 0 writes — 2,891 sales / 24 inventory_logs / 53 alerts / 53 recommendations unchanged |
| `validation-sandbox` | Not touched | 100,000 sales / 320 products / 11 alerts unchanged |

The mismatch this exposes: `london-bakers-i10` still holds the **synthetic** 731-day series, so its live
`/api/stockout` output is not a real-data demo. Re-seeding it from the real workbook is a data operation,
not part of this task, and needs your go-ahead.

## 16. Next steps (nothing runs without your go-ahead)

1. **Hold-out** (2026-09-29 … 2026-10-05): score it **once**, frozen methods only (M1, M3, M4, M6), append
   as §17 and update `frozen_config.json` `holdOut.evaluated` / `evaluatedAt` / `results`. No method,
   window or preset may change after that point.
2. **M6 as an engine** (optional, separate phase): it needs its own validation, and on this evidence it
   needs more data before claiming a reliable edge over velocity.
3. **`/api/stockout` caching** (optional): its own SQL still costs ~450–500 ms on that tenant; caching it
   changes default-path freshness semantics, so it needs explicit sign-off.
4. **Re-seed `london-bakers-i10` with the real 35-day workbook** (optional) so the live demo reflects real
   data.




