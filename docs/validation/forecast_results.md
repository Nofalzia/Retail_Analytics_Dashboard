# Forecast backtest — dev folds only (Phase 2)

**What this is.** The evidence for or against switching Stockout Watch's demand basis from the
production velocity baseline to the Holt-Winters engine added in Phase 1. It is measured on real
point-of-sale data, on the seven **dev** folds only. The final week
(**2026-09-29 … 2026-10-05**) is sealed and was not read by this run; the script refuses a dev window
that touches it.

| | |
|---|---|
| Branch | `feature/hisaabiq-ml` |
| Data | `London_Bakers_Dataset.xlsx`, sheet `POS Sales Log` (supplied by path, never committed) |
| Script | `backend/scripts/validation/forecastBacktest.js` |
| Raw output | `forecast_backtest_metrics.csv`, `forecast_backtest_by_fold.csv`, `forecast_backtest_top10_skus.csv`, `forecast_backtest_observations.csv`, `forecast_backtest_params.csv`, `forecast_backtest_raw.json` |
| Frozen decision | `docs/validation/frozen_config.json` |

---

## 1. Selection rule (fixed before the run, reproduced from the script)

> Pick the method with the lowest pooled WAPE over the 7 dev folds. Accept it only if its paired
> per-SKU-day absolute error minus M1 seasonal naive has a 95% bootstrap interval entirely below 0
> (i.e. it is reliably better). Otherwise record "no reliable improvement" and keep
> `FORECAST_ENGINE = velocity`. No preset, window or parameter is changed after these numbers are
> seen.

One addition, disclosed: the rule selects a **method**; deciding whether to change an **engine**
also requires that the method be one of the two engines actually implemented (`velocity`,
`holt_winters`) and that it reliably beat the engine shipping today. That second condition is
reported separately in §7 and does not alter any number in §5-§6.

---

## 2. Data actually read

| | |
|---|---|
| Line items read | 304,614 |
| Kept (`Status = COMPLETED`, `Quantity > 0`, ISO date, non-empty SKU) | 299,687 |
| Excluded — status not completed | 4,310 |
| Excluded — quantity not positive | 617 |
| `(SKU, date)` pairs after `SUM(Quantity)` | 36,051 |
| SKUs / distinct source dates | 50 / 731 |
| Source range | 2023-10-01 … 2025-09-30 |
| Constant date shift | **+377 days** (last source day → 2026-10-12, the anchor `london-bakers-i10` was seeded with) |
| Aligned range | 2024-10-12 … 2026-10-12 (731 days) |
| Grid cells | 36,550 total = 36,051 with units + **499 zero-filled** |

The read reproduced the import pipeline's numbers exactly (4,310 + 617 exclusions, 36,051 pairs), and
the aligned range is identical to `sale_transactions` for `london-bakers-i10` — so the folds are
scored on the same calendar the dashboard shows.

**On the "single missing cell".** There is no missing *calendar day*: all 731 days are present, and
every one of the 36,051 `(SKU, date)` pairs the pipeline would insert exists in the sheet. What the
grid also has is **499 SKU-days with no sale at all** (a slow mover skipping a day). Those are real
zero-demand days and are zero-filled, exactly as `buildContiguousSeries` does in production — they are
not missing data and are not imputed from a neighbour.

---

## 3. Protocol

Seven rolling origins, four days apart, starting the day before the dev window. Each fold fits on
**its own 28 training days** and projects 7 days; only days inside the dev window are scored, which is
why fold 7 stops at h4.

| Fold | Origin (last training day) | Scored days | Horizon scored | SKU-days |
|---|---|---|---|---|
| 1 | 2026-08-31 | 2026-09-01 … 2026-09-07 | h1-h7 | 350 |
| 2 | 2026-09-04 | 2026-09-05 … 2026-09-11 | h1-h7 | 350 |
| 3 | 2026-09-08 | 2026-09-09 … 2026-09-15 | h1-h7 | 350 |
| 4 | 2026-09-12 | 2026-09-13 … 2026-09-19 | h1-h7 | 350 |
| 5 | 2026-09-16 | 2026-09-17 … 2026-09-23 | h1-h7 | 350 |
| 6 | 2026-09-20 | 2026-09-21 … 2026-09-27 | h1-h7 | 350 |
| 7 | 2026-09-24 | 2026-09-25 … 2026-09-28 | h1-h4 | 200 |
| | | | **total** | **2,300** |

Origins closer than 7 days means a date can be scored twice (at different horizons) — that is the
standard rolling-origin trade-off, applied identically to every method, and it is why the pooled
figures are reported per fold-SKU-day rather than per calendar day.

| Method | What it is |
|---|---|
| M1 `seasonal_naive` | same weekday one week earlier |
| M2 `ma7` | mean of the last 7 training days, flat |
| M3 `velocity14` | **the production baseline**: `SUM(units) / 14` over the 14 days before the origin (`forecastService.velocityAverage`) |
| M4 `hw_grid` | `holtWinters.js` with the in-service grid search — exactly what `FORECAST_ENGINE=holt_winters` serves |
| M5 (9 presets) | the same estimator, `beta = 0`, `alpha, gamma ∈ {0.2, 0.3, 0.5}`, fixed before the run |
| M6 `weekday_profile` | store-level weekday index (from the store's total units per day) × the SKU's own 28-day mean |
| M7 ridge core | **not run.** Its stated precondition — "only if M4/M5 do not beat M1" — is not met (§5), and it could not have changed the engine decision: the incumbent already beats Holt-Winters by 7.3 WAPE points |

Metrics: **WAPE** (headline) = `Σ|F − A| / ΣA`; **MAE** = mean `|F − A|`; **bias** = signed
`(mean F − mean A) / mean A`. Pooled over all 2,300 fold-SKU-days, and bucketed h1-3 / h4-7.

**Noise floor.** Mean actual = **13.80 units per SKU-day**; for Poisson demand
`E|X − μ| = √(2μ/π)`, so a *perfect* forecast of the mean would still score
**WAPE ≈ 21.48%**. Every number below is read against that floor, not against zero.


---

## 4. Pooled dev results

| Method | WAPE % | MAE (units) | bias % |
|---|---|---|---|
| M6 weekday profile | **28.87** | **3.98** | −1.27 |
| M3 velocity 14-day (production) | 29.62 | 4.09 | −0.06 |
| M2 7-day moving average | 30.67 | 4.23 | −0.23 |
| M5 HW a0.2 b0 g0.5 | 35.97 | 4.96 | −2.60 |
| M5 HW a0.2 b0 g0.3 | 36.08 | 4.98 | −2.95 |
| M5 HW a0.3 b0 g0.5 | 36.09 | 4.98 | −2.99 |
| M5 HW a0.3 b0 g0.3 | 36.26 | 5.00 | −3.37 |
| M4 **Holt-Winters grid (the engine)** | 36.91 | 5.09 | −1.01 |
| M5 HW a0.2 b0 g0.2 | 37.09 | 5.12 | −3.09 |
| M5 HW a0.3 b0 g0.2 | 37.22 | 5.14 | −3.51 |
| M5 HW a0.5 b0 g0.5 | 37.59 | 5.19 | −4.68 |
| M1 seasonal naive | 38.20 | 5.27 | −0.26 |
| M5 HW a0.5 b0 g0.3 | 38.37 | 5.30 | −5.02 |
| M5 HW a0.5 b0 g0.2 | 39.42 | 5.44 | −5.12 |

Read against the 21.48% Poisson floor: velocity sits 8.1 points above it, the best method 7.4, and
the shipped Holt-Winters engine 15.4. No method is close to the floor, so the gap between methods is
real signal, not an artefact of noise.

### By horizon bucket (WAPE %)

| Method | h1-3 | h4-7 |
|---|---|---|
| M6 weekday profile | 28.52 | 29.17 |
| M3 velocity 14-day | 28.96 | 30.17 |
| M2 7-day moving average | 30.43 | 30.87 |
| M5 HW a0.2 b0 g0.5 (best preset) | 34.09 | 37.59 |
| M4 Holt-Winters grid | 35.60 | 38.03 |
| M1 seasonal naive | 37.82 | 38.52 |

Every method degrades with horizon, but Holt-Winters degrades fastest (M4 +2.4 points from h1-3 to
h4-7, against +1.2 for velocity). Its seasonal component is not buying anything at any horizon.

### Per fold (WAPE %)

| Fold | Origin | Scored | M3 velocity | M4 Holt-Winters | M6 weekday profile |
|---|---|---|---|---|---|
| 1 | 2026-08-31 | 09-01…09-07 | 27.48 | 35.58 | 27.67 |
| 2 | 2026-09-04 | 09-05…09-11 | 29.03 | 35.16 | 28.51 |
| 3 | 2026-09-08 | 09-09…09-15 | 28.58 | 33.09 | 27.25 |
| 4 | 2026-09-12 | 09-13…09-19 | 30.08 | 41.92 | 29.53 |
| 5 | 2026-09-16 | 09-17…09-23 | 28.45 | 34.96 | 28.05 |
| 6 | 2026-09-20 | 09-21…09-27 | 31.01 | 39.26 | 29.91 |
| 7 | 2026-09-24 | 09-25…09-28 | 35.14 | 39.63 | 33.01 |

Holt-Winters loses to velocity in **7 of 7 folds**, by 2.8 to 11.8 WAPE points. This is not one fold
that went wrong; it is every fold.

---

## 5. Paired comparisons (seeded bootstrap, 2,000 draws, seed 20260917)

Difference in **absolute error per SKU-day**, method minus reference. Negative = closer to the truth.

### vs M1 seasonal naive (the selection rule's baseline)

| Method | Mean diff | 95% CI | Reading |
|---|---|---|---|
| M6 weekday profile | −1.287 | [−1.453, −1.127] | better |
| M3 velocity 14-day | −1.184 | [−1.352, −1.020] | better |
| M2 7-day moving average | −1.040 | [−1.203, −0.877] | better |
| M5 HW a0.2 b0 g0.5 | −0.307 | [−0.446, −0.163] | better |
| M5 HW a0.2 b0 g0.3 | −0.293 | [−0.458, −0.115] | better |
| M5 HW a0.3 b0 g0.5 | −0.290 | [−0.439, −0.141] | better |
| M5 HW a0.3 b0 g0.3 | −0.268 | [−0.437, −0.089] | better |
| M4 Holt-Winters grid | −0.178 | [−0.324, −0.025] | better, barely |
| M5 HW a0.2 b0 g0.2 | −0.153 | [−0.337, 0.037] | no difference (includes 0) |
| M5 HW a0.3 b0 g0.2 | −0.136 | [−0.325, 0.056] | no difference |
| M5 HW a0.5 b0 g0.5 | −0.084 | [−0.258, 0.091] | no difference |
| M5 HW a0.5 b0 g0.3 | +0.024 | [−0.166, 0.221] | no difference |
| M5 HW a0.5 b0 g0.2 | +0.168 | [−0.036, 0.379] | no difference |

So M4/M5 **do** beat M1 — but by 0.18 units per SKU-day, an order of magnitude less than the 1.18
velocity already buys. Beating the weakest baseline was never the bar that matters here.

### vs M3 velocity, the engine shipping today

| Method | Mean diff | 95% CI | Reading |
|---|---|---|---|
| M6 weekday profile | −0.103 | [−0.179, −0.024] | better (small, but excludes 0) |
| M4 Holt-Winters grid | **+1.007** | [0.851, 1.167] | **worse** |
| M2 7-day moving average | +0.145 | [0.083, 0.208] | worse |

Holt-Winters is reliably **one unit per SKU-day further from the truth** than the flat baseline it
would replace: better on 906 SKU-days, worse on 1,394.

---

## 6. Top-10 SKUs by volume (WAPE %, secondary table)

| SKU | Product | Actual units | M1 | M3 velocity | M4 Holt-Winters | M6 weekday profile |
|---|---|---|---|---|---|---|
| SKU-144 | Fruit Chaat | 2,981 | 22.0 | 17.9 | 22.7 | 17.1 |
| SKU-150 | Lemon Soda | 1,943 | 22.9 | 17.6 | 26.4 | 18.4 |
| SKU-134 | Cheese Paratha | 1,556 | 19.5 | 21.3 | 21.4 | 18.4 |
| SKU-131 | Fried Round Sandwich | 1,282 | 29.3 | 22.1 | 27.7 | 21.3 |
| SKU-124 | Pizza Slice | 1,151 | 36.0 | 26.5 | 29.0 | 24.3 |
| SKU-108 | Namak Paray (250g) | 1,149 | 49.7 | 28.6 | 38.1 | 29.8 |
| SKU-145 | Dahi Bhallay | 1,083 | 20.0 | 18.4 | 19.0 | 17.4 |
| SKU-114 | Chicken Roll | 990 | 31.1 | 27.3 | 32.9 | 23.4 |
| SKU-127 | Plain Sandwich | 943 | 42.5 | 26.8 | 36.6 | 27.9 |
| SKU-135 | Shashlik Stick | 846 | 48.1 | 32.7 | 45.6 | 30.1 |

The volume leaders are where business impact lives, and Holt-Winters loses to velocity on 9 of these
10. Its closest result (SKU-144) is still 4.8 points behind.

---

## 7. Why Holt-Winters lost (diagnosis — no re-tuning was done)

Three observations from the raw files, none of which changed a setting:

1. **The grid search sits on the edge of its own range.** Over 350 fold-SKU fits (7 folds × 50 SKUs)
   the in-service grid chose `alpha = 0.1` — the lowest value offered — **238 times (68%)**, and
   `beta = 0` every time. A selector that walks to the boundary is telling you the criterion
   (one-step in-sample SSE) is minimising noise, not structure: a slower level always fits a lumpy
   daily count better in-sample.
2. **The error grows with horizon** (+2.4 points from h1-3 to h4-7, against +1.2 for velocity), which
   is the signature of a seasonal component adding variance rather than removing it.
3. **The bias is one-sided and grows with `alpha`**: −1.01% for the grid pick, −5.12% for
   `a0.5 g0.2`. The additive seasonals are initialised from a single week and then damped, so the
   model systematically under-forecasts.

Against that, the data itself is low-count: **13.8 units per SKU-day** on average, 50 SKUs, and
36,051 sales cells over 36,550 possible. A seven-day seasonal vector learned from 28 observations is a
lot of parameters for a series that often reads 0, 3, or 8. The flat 14-day mean is a hard baseline to
beat here — and M6 shows the weekday shape that *does* exist can be captured with one shape shared
across the store instead of one per SKU.

## 8. Decision

| Question | Answer |
|---|---|
| Lowest dev WAPE | **M6 weekday profile — 28.87%** |
| Does it beat M1 reliably? | Yes: paired diff −1.287 units, 95% CI [−1.453, −1.127] — excludes 0 |
| Is the winner a shipped engine? | **No.** M6 exists only in the validation script |
| Holt-Winters vs the engine shipping today | **Worse: 36.91% vs 29.62% WAPE**, paired +1.007 units, CI [0.851, 1.167] |
| Engine change? | **None. `FORECAST_ENGINE` default stays `velocity`** (Phase 1 behaviour, untouched) |
| What M6 is worth | 0.75 WAPE points (2.5% relative) better than velocity — recorded as a candidate, not implemented |

The honest summary: **the new engine is not ready to ship, and nothing was tuned to make it look
better.** Holt-Winters beats the naive seasonal baseline but loses decisively to the flat baseline the
product already uses, in every fold and on 9 of the 10 highest-volume SKUs. The one genuinely useful
finding is that a store-level weekday shape beats velocity by a small but statistically visible margin
— that is a Phase 5 candidate, not a Phase 2 result.

## 9. Limitations

- One tenant, one store, 50 SKUs, a 28-day dev window. This is a go/no-go gate for the engine, not a
  general claim about Holt-Winters on retail data.
- Origins are 4 days apart with a 7-day horizon, so a date can be scored twice at different horizons
  (§3). Every method gets the identical treatment, so the comparisons stand, but the pooled WAPE is
  "per fold-SKU-day", not "per calendar day".
- Fold 7 contributes only h1-h4 (the dev window ends 2026-09-28), which weights the pooled numbers
  slightly toward short horizons.
- The 9 M5 presets are reported individually. Choosing the best of them *after* seeing the results is
  a selection over 9 candidates; it is disclosed, and none of them beats velocity either.
- M4's parameters are selected by in-sample SSE because that is what ships. A time-CV selector might
  produce a better M4 — that would be a Phase 1 design change to re-validate, not a re-tune of this
  backtest.
- Observations for one SKU across horizons are dependent, so the bootstrap interval is mildly
  optimistic. The 7-of-7 fold consistency is the stronger evidence than any single interval.

## 10. Reproduce

```cmd
cd backend
npm run validate:forecast -- --input "C:\Users\Nofal Zia\Desktop\London Bakers Data\London_Bakers_Dataset.xlsx"
```

- Deterministic: fixed folds, fixed presets, fixed bootstrap seed (20260917), no RNG elsewhere. A
  re-run reproduces every metric; the only value that changes is `generatedAt` in the JSON.
- The workbook read dominates the runtime (~43 s); the folds and metrics take under a second.
- The script **refuses** `--dev-start`/`--dev-end` values that touch 2026-09-29 … 2026-10-05, so the
  hold-out cannot be opened by accident.

## 11. What happens next (on your go-ahead only)

`docs/validation/frozen_config.json` is committed with this document and fixes the winning method, the
protocol and the seed *before* the hold-out is read. When you open 2026-09-29 … 2026-10-05, that week
is scored once, for the frozen methods only, and appended here as §12 — no method, window or preset
may change after that point.

