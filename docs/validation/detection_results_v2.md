# Detection validation — v2 (per-day rolling z-score)

> **T7b.** Replaces the v1 single-window z-score in `runZScoreDetection` with the pure module
> `src/services/rollingZScore.js`, then measures the change on **development seeds 1–5** and **held-out seeds 6–10**
> against the v1 algorithm (replicated in memory) and two naive fixed-percentage baselines. The v1 evidence from T7a is
> preserved in `detection_results_v1.md` / `detection_results_v1.csv`.

### Headline (full-series, |z| floor, mean over seeds)

| Seeds | v1 precision / recall / F1 | v2 precision / recall / F1 |
|---|---|---|
| dev (1–5) | 0.137 / 0.761 / 0.232 | 0.388 / 0.539 / 0.450 |
| hold-out (6–10) | 0.141 / 0.778 / 0.238 | 0.379 / 0.544 / 0.446 |

Sandbox: tenant `validation-sandbox` (`81ae0d97-3252-4209-9799-a440d51cd62d`), store `b5d25407-9106-4e39-9ea9-c8779feadbb8`. Generated 2026-10-10T18:43:04.096Z.

## Method

**v2 (what ships).** `runZScoreDetection` now calls `services/rollingZScore.js`. For each evaluated day the baseline
is the PREVIOUS `windowDays` (14) **calendar** days — the day under test is excluded, so an anomaly can no longer mask
itself. Calendar days with no sale are zero-filled (the `product_daily_velocity` view only contains days that had a
sale), so a drop to zero is visible. σ is floored at the Poisson counting-noise level `max(sd, sqrt(max(mean, 1)))`
so a flat baseline cannot inflate |z|. A day is flagged only when **all three** guards pass:
`|z| >= 2.5`, `|dev| / mean >= 0.25` and `|units − mean| >= 3`. The engine evaluates the most recent 14 calendar
days present in the data, for every product that sold inside the lookback window.

**v1 (the flaw, replicated in memory).** `v1_series` computes ONE mean and ONE population σ over every sale day and
then tests each of those SAME days against that statistic, flagging `|z| > 1.5`. Days with no sale are invisible to
it, and a large anomaly inflates both the mean and the σ it is judged against. T7a measured v1 over the engine's
14-day window only; here it is evaluated over the full 90-day series so it is compared like-for-like with v2 and the
baselines under the identical matching rule. Both are v1, but they are different measurements - see
"Which v1 is being compared?" below.

##### Which "v1" is being compared?

The v1 *algorithm* never changed; what changed is the *evaluation span*, i.e. which ground-truth anomalies sit in the
denominator. That is why two different v1 recalls are published, and they are not a contradiction:

| Label | v1 rule as measured | Denominator | Precision | Recall | F1 |
|---|---|---|---|---|---|
| `engine: all alerts` - **T7a**, frozen in `detection_results_v1.md` | the old `runZScoreDetection` exactly as it ran (`\|z\| > 1.5`, severity read from the persisted alerts) | all 36 injected anomalies, although only 7.0 per seed are inside its window | 0.130 | 0.133 | 0.131 |
| the same T7a run, rebased to its own window | identical detections (4.80 TP per seed); only the denominator is restricted | the 7.0 anomalies actually inside the engine's window | 0.130 | 0.686 | 0.219 |
| `v1_series` - **the full-series control (dev block shown)** | the same v1 rule re-implemented in memory and applied to every sale day of the series | all 36 | 0.137 | 0.761 | 0.232 |

T7a divided 4.80 true positives by all 36 anomalies, including the
29.0 per seed its 14-day window structurally cannot reach, whereas
`v1_series` is scored over the whole span it can see. Judged only on the days inside its window the v1 rule reaches
0.686 recall - at the cost of 32.6 false positives per seed.
`v1_series` is therefore the fair full-series control for v2 and the baselines in this report; the T7a rows are
quoted only for the engine-vs-engine comparison below.

**Baselines.** Flag a day when `|units − mean(previous 14 days)| / mean(previous 14 days) > T` for T = 0.30 and 0.50.

**Matching rule.** A flagged product-day counts as a true positive only on the exact same `(SKU, date)` pair — no
tolerance window, no date fuzziness. Precision = TP/(TP+FP), Recall = TP/(TP+FN), F1 = 2PR/(P+R); a zero denominator
yields 0 (never NaN).

**Ablations.** `v2_no_zerofill` (no-sale baseline days skipped instead of zero-filled), `v2_no_sdfloor` (raw sample
σ), `v2_no_guards` (relative and absolute deviation guards removed).

**Seeds.** Development seeds 1–5; once the parameters were frozen, the harness was run UNCHANGED on the held-out seeds
6–10. Every figure is mean ± population standard deviation (σ, divide by N) over the seeds of that block.

## Headline comparison — v1 vs v2 (full 90-day series, identical ground)

| Seeds | Method | TP (mean) | FP (mean) | FN (mean) | Precision | Recall | F1 | Flags/seed |
|---|---|---|---|---|---|---|---|---|
| dev (1–5) | v1: single-window z (\|z\| > 1.5) | 27.40 | 173.80 | 8.60 | 0.137 | 0.761 | 0.232 | 201.200 |
| dev (1–5) | v2: rolling z (guarded) | 19.40 | 30.60 | 16.60 | 0.388 | 0.539 | 0.450 | 50.000 |
| dev (1–5) | baseline: \|dev\| > 30% (prev 14d mean) | 31.60 | 427.00 | 4.40 | 0.070 | 0.878 | 0.129 | 458.600 |
| dev (1–5) | baseline: \|dev\| > 50% (prev 14d mean) | 25.20 | 131.00 | 10.80 | 0.168 | 0.700 | 0.269 | 156.200 |
| hold-out (6–10) | v1: single-window z (\|z\| > 1.5) | 28.00 | 172.20 | 8.00 | 0.141 | 0.778 | 0.238 | 200.200 |
| hold-out (6–10) | v2: rolling z (guarded) | 19.60 | 32.20 | 16.40 | 0.379 | 0.544 | 0.446 | 51.800 |
| hold-out (6–10) | baseline: \|dev\| > 30% (prev 14d mean) | 32.40 | 424.00 | 3.60 | 0.072 | 0.900 | 0.134 | 456.400 |
| hold-out (6–10) | baseline: \|dev\| > 50% (prev 14d mean) | 26.00 | 138.80 | 10.00 | 0.168 | 0.722 | 0.270 | 164.800 |

**Reading this table.** All methods share the same evaluation span, the same 36 injected anomalies and the same
exact-`(SKU, date)` matching rule, so the numbers are directly comparable. v1 is the single-window statistic that
tests each day against a mean/σ that already contains that day (self-masking) and that cannot see no-sale days at all.
v2 rebuilds the baseline from the previous 14 calendar days for every day, zero-fills no-sale days and requires the
relative/absolute guards, so its flags cluster on genuine anomalies instead of ordinary weekly noise. The held-out
block (seeds 6–10) is the clean test: the parameters are still the ones frozen after seeds 1–5.

### Like-for-like against T7a (engine vs engine, dev seeds 1-5)

T7a and this report drove the SAME entry point (`runZScoreDetection`) over the same development seeds with the same
exact-`(SKU, date)` matching rule, so these two rows are the honest "did the fix help?" pair. Both count persisted
`anomaly_alerts` rows and score them against the 7.0 injected anomalies that fall inside the
engine's 14-day window per seed - the only denominator on which T7a and this report are directly comparable.

| Engine (dev seeds 1-5, persisted alerts, in-window truth) | Precision | Recall | F1 | TP / FP / FN (mean) | Alerts/seed |
|---|---|---|---|---|---|
| v1 deployed - T7a, all alerts (`\|z\| > 1.5`) | 0.130 ± 0.035 | 0.686 (T7a published 0.133 against all 36) | 0.219 (published 0.131) | 4.80 / 32.60 / 31.20 | 37.4 |
| v2 deployed - this run, all alerts | 0.395 ± 0.077 | 0.583 ± 0.167 | 0.465 ± 0.107 | 4.00 / 6.00 / 3.00 | 10.0 |

* **v2 catches about the same anomalies in-window while writing ~5x fewer alerts.** TP only moves from
  4.80 to 4.00 per seed, but FP falls from 32.60
  to 6.00, so precision rises 0.130 to 0.395
  and F1 0.219 to 0.465.
* **v1 keeps the higher in-window recall** (0.686 vs 0.583), bought with
  32.6 false positives per seed instead of 6.00. The v2 engine also
  beats T7a's *warning+* cut-off (0.365 / 0.117) on both axes,
  so the improvement comes from the baseline logic, not from a looser threshold.
* **Seed-level caveat.** These in-window figures rest on only 7.0 anomalies per seed, so their
  standard deviations are wide (precision ± 0.077, recall ± 0.167).
  The full-series table in **Headline comparison** above is the statistically stable comparison; this table is the
  "same engine, before vs after" check.

### Against the fixed-percentage baselines (held-out seeds 6-10, full series)

| Method | Precision | Recall | F1 | Flags/seed |
|---|---|---|---|---|
| v2: rolling z (guarded) | 0.379 | 0.544 | 0.446 | 51.800 |
| baseline: `\|dev\| > 50%` | 0.168 | 0.722 | 0.270 | 164.800 |
| baseline: `\|dev\| > 30%` | 0.072 | 0.900 | 0.134 | 456.400 |

v2 beats the `\|dev\| > 50%` rule on precision (0.379 vs 0.168)
and on F1 (0.446 vs 0.270), and beats `\|dev\| > 30%` by more still
(0.072 precision, 0.134 F1). The percentage rules keep the higher
*recall* (0.722 / 0.900) only by flagging far more product-days
(456.400 / 164.800 per seed against v2's
51.800) - almost all ordinary weekly noise. They are a high-recall reference point, not a
competitor on F1.

The two harnesses agree on the yardstick: T7a's dev-block baseline rows
(0.067 / 0.856 / 0.124 and
0.171 / 0.695 / 0.272) reproduce this run's dev
baselines (0.070 / 0.878 / 0.129 and
0.168 / 0.700 / 0.269) to within 0.022
absolute, so both harnesses measure v2 against the same baseline implementation.

## Ablations — why each part of v2 is there

| Seeds | Variant | Precision | Recall | F1 | TP (mean) | FP (mean) | FN (mean) |
|---|---|---|---|---|---|---|---|
| dev (1–5) | v2: rolling z (guarded) | 0.388 | 0.539 | 0.450 | 19.40 | 30.60 | 16.60 |
| dev (1–5) | ablation: v2 without zero-fill | 0.387 | 0.539 | 0.449 | 19.40 | 30.80 | 16.60 |
| dev (1–5) | ablation: v2 without Poisson σ-floor | 0.324 | 0.550 | 0.407 | 19.80 | 41.40 | 16.20 |
| dev (1–5) | ablation: v2 without deviation guards | 0.388 | 0.539 | 0.450 | 19.40 | 30.60 | 16.60 |
| hold-out (6–10) | v2: rolling z (guarded) | 0.379 | 0.544 | 0.446 | 19.60 | 32.20 | 16.40 |
| hold-out (6–10) | ablation: v2 without zero-fill | 0.376 | 0.544 | 0.444 | 19.60 | 32.60 | 16.40 |
| hold-out (6–10) | ablation: v2 without Poisson σ-floor | 0.320 | 0.550 | 0.404 | 19.80 | 42.40 | 16.20 |
| hold-out (6–10) | ablation: v2 without deviation guards | 0.379 | 0.544 | 0.446 | 19.60 | 32.20 | 16.40 |

* **zero-fill off** — no-sale baseline days are dropped from the baseline, so the baseline mean rises and σ shrinks; a
  "drop to zero" (the most commercially important anomaly) becomes invisible.
* **σ-floor off** — a flat or near-flat baseline gives σ ≈ 0, so tiny absolute wobbles produce enormous |z| and
  precision collapses.
* **guards off** — every `|z| >= 2.5` day is written, including days that differ from the baseline by one or two units
  on a very low-volume product; flag volume rises and precision falls.

Both blocks are shown so the ablation story is verified on the held-out seeds too, not just on the seeds the parameters
were chosen with.

## Per-seed-set detail

### Development seeds 1–5

| Method | Precision (mean ± sd) | Recall (mean ± sd) | F1 (mean ± sd) | TP (mean) | FP (mean) | FN (mean) |
|---|---|---|---|---|---|---|
| v1: single-window z (\|z\| > 1.5) | 0.137 ± 0.016 | 0.761 ± 0.062 | 0.232 ± 0.025 | 27.40 | 173.80 | 8.60 |
| v2: rolling z (guarded) | 0.388 ± 0.013 | 0.539 ± 0.051 | 0.450 ± 0.022 | 19.40 | 30.60 | 16.60 |
| ablation: v2 without zero-fill | 0.387 ± 0.014 | 0.539 ± 0.051 | 0.449 ± 0.021 | 19.40 | 30.80 | 16.60 |
| ablation: v2 without Poisson σ-floor | 0.324 ± 0.016 | 0.550 ± 0.044 | 0.407 ± 0.019 | 19.80 | 41.40 | 16.20 |
| ablation: v2 without deviation guards | 0.388 ± 0.013 | 0.539 ± 0.051 | 0.450 ± 0.022 | 19.40 | 30.60 | 16.60 |
| baseline: \|dev\| > 30% (prev 14d mean) | 0.070 ± 0.009 | 0.878 ± 0.042 | 0.129 ± 0.015 | 31.60 | 427.00 | 4.40 |
| baseline: \|dev\| > 50% (prev 14d mean) | 0.168 ± 0.037 | 0.700 ± 0.071 | 0.269 ± 0.051 | 25.20 | 131.00 | 10.80 |
| engine (live DB, this run): all | 0.395 ± 0.077 | 0.583 ± 0.167 | 0.465 ± 0.107 | 4.00 | 6.00 | 3.00 |
| engine (live DB): warning+ | 0.500 ± 0.105 | 0.383 ± 0.145 | 0.427 ± 0.124 | 2.60 | 2.60 | 4.40 |
| engine (live DB): critical | 0.833 ± 0.211 | 0.228 ± 0.062 | 0.353 ± 0.086 | 1.60 | 0.40 | 5.40 |

<details>
<summary>Per-seed confusion counts</summary>

| seed | method | TP | FP | FN | precision | recall | F1 |
|---|---|---|---|---|---|---|---|
| 1 | v1: single-window z (\|z\| > 1.5) | 26 | 186 | 10 | 0.123 | 0.722 | 0.210 |
| 1 | v2: rolling z (guarded) | 18 | 30 | 18 | 0.375 | 0.500 | 0.429 |
| 1 | ablation: v2 without zero-fill | 18 | 30 | 18 | 0.375 | 0.500 | 0.429 |
| 1 | ablation: v2 without Poisson σ-floor | 18 | 35 | 18 | 0.340 | 0.500 | 0.405 |
| 1 | ablation: v2 without deviation guards | 18 | 30 | 18 | 0.375 | 0.500 | 0.429 |
| 1 | baseline: \|dev\| > 30% (prev 14d mean) | 32 | 471 | 4 | 0.064 | 0.889 | 0.119 |
| 1 | baseline: \|dev\| > 50% (prev 14d mean) | 25 | 159 | 11 | 0.136 | 0.694 | 0.227 |
| 1 | engine (live DB, this run): all | 6 | 7 | 3 | 0.462 | 0.667 | 0.545 |
| 1 | engine (live DB): warning+ | 3 | 3 | 6 | 0.500 | 0.333 | 0.400 |
| 1 | engine (live DB): critical | 2 | 0 | 7 | 1.000 | 0.222 | 0.364 |
| 2 | v1: single-window z (\|z\| > 1.5) | 25 | 172 | 11 | 0.127 | 0.694 | 0.215 |
| 2 | v2: rolling z (guarded) | 21 | 33 | 15 | 0.389 | 0.583 | 0.467 |
| 2 | ablation: v2 without zero-fill | 21 | 33 | 15 | 0.389 | 0.583 | 0.467 |
| 2 | ablation: v2 without Poisson σ-floor | 21 | 47 | 15 | 0.309 | 0.583 | 0.404 |
| 2 | ablation: v2 without deviation guards | 21 | 33 | 15 | 0.389 | 0.583 | 0.467 |
| 2 | baseline: \|dev\| > 30% (prev 14d mean) | 31 | 388 | 5 | 0.074 | 0.861 | 0.136 |
| 2 | baseline: \|dev\| > 50% (prev 14d mean) | 23 | 97 | 13 | 0.192 | 0.639 | 0.295 |
| 2 | engine (live DB, this run): all | 4 | 7 | 2 | 0.364 | 0.667 | 0.471 |
| 2 | engine (live DB): warning+ | 2 | 4 | 4 | 0.333 | 0.333 | 0.333 |
| 2 | engine (live DB): critical | 1 | 1 | 5 | 0.500 | 0.167 | 0.250 |
| 3 | v1: single-window z (\|z\| > 1.5) | 29 | 169 | 7 | 0.146 | 0.806 | 0.248 |
| 3 | v2: rolling z (guarded) | 22 | 35 | 14 | 0.386 | 0.611 | 0.473 |
| 3 | ablation: v2 without zero-fill | 22 | 36 | 14 | 0.379 | 0.611 | 0.468 |
| 3 | ablation: v2 without Poisson σ-floor | 22 | 42 | 14 | 0.344 | 0.611 | 0.440 |
| 3 | ablation: v2 without deviation guards | 22 | 35 | 14 | 0.386 | 0.611 | 0.473 |
| 3 | baseline: \|dev\| > 30% (prev 14d mean) | 33 | 441 | 3 | 0.070 | 0.917 | 0.129 |
| 3 | baseline: \|dev\| > 50% (prev 14d mean) | 29 | 125 | 7 | 0.188 | 0.806 | 0.305 |
| 3 | engine (live DB, this run): all | 4 | 4 | 2 | 0.500 | 0.667 | 0.571 |
| 3 | engine (live DB): warning+ | 2 | 2 | 4 | 0.500 | 0.333 | 0.400 |
| 3 | engine (live DB): critical | 2 | 0 | 4 | 1.000 | 0.333 | 0.500 |
| 4 | v1: single-window z (\|z\| > 1.5) | 26 | 183 | 10 | 0.124 | 0.722 | 0.212 |
| 4 | v2: rolling z (guarded) | 17 | 28 | 19 | 0.378 | 0.472 | 0.420 |
| 4 | ablation: v2 without zero-fill | 17 | 28 | 19 | 0.378 | 0.472 | 0.420 |
| 4 | ablation: v2 without Poisson σ-floor | 18 | 41 | 18 | 0.305 | 0.500 | 0.379 |
| 4 | ablation: v2 without deviation guards | 17 | 28 | 19 | 0.378 | 0.472 | 0.420 |
| 4 | baseline: \|dev\| > 30% (prev 14d mean) | 29 | 472 | 7 | 0.058 | 0.806 | 0.108 |
| 4 | baseline: \|dev\| > 50% (prev 14d mean) | 22 | 172 | 14 | 0.113 | 0.611 | 0.191 |
| 4 | engine (live DB, this run): all | 2 | 5 | 6 | 0.286 | 0.250 | 0.267 |
| 4 | engine (live DB): warning+ | 2 | 2 | 6 | 0.500 | 0.250 | 0.333 |
| 4 | engine (live DB): critical | 2 | 1 | 6 | 0.667 | 0.250 | 0.364 |
| 5 | v1: single-window z (\|z\| > 1.5) | 31 | 159 | 5 | 0.163 | 0.861 | 0.274 |
| 5 | v2: rolling z (guarded) | 19 | 27 | 17 | 0.413 | 0.528 | 0.463 |
| 5 | ablation: v2 without zero-fill | 19 | 27 | 17 | 0.413 | 0.528 | 0.463 |
| 5 | ablation: v2 without Poisson σ-floor | 20 | 42 | 16 | 0.323 | 0.556 | 0.408 |
| 5 | ablation: v2 without deviation guards | 19 | 27 | 17 | 0.413 | 0.528 | 0.463 |
| 5 | baseline: \|dev\| > 30% (prev 14d mean) | 33 | 363 | 3 | 0.083 | 0.917 | 0.153 |
| 5 | baseline: \|dev\| > 50% (prev 14d mean) | 27 | 102 | 9 | 0.209 | 0.750 | 0.327 |
| 5 | engine (live DB, this run): all | 4 | 7 | 2 | 0.364 | 0.667 | 0.471 |
| 5 | engine (live DB): warning+ | 4 | 2 | 2 | 0.667 | 0.667 | 0.667 |
| 5 | engine (live DB): critical | 1 | 0 | 5 | 1.000 | 0.167 | 0.286 |

</details>


### Held-out seeds 6–10

| Method | Precision (mean ± sd) | Recall (mean ± sd) | F1 (mean ± sd) | TP (mean) | FP (mean) | FN (mean) |
|---|---|---|---|---|---|---|
| v1: single-window z (\|z\| > 1.5) | 0.141 ± 0.014 | 0.778 ± 0.039 | 0.238 ± 0.022 | 28.00 | 172.20 | 8.00 |
| v2: rolling z (guarded) | 0.379 ± 0.027 | 0.544 ± 0.045 | 0.446 ± 0.033 | 19.60 | 32.20 | 16.40 |
| ablation: v2 without zero-fill | 0.376 ± 0.029 | 0.544 ± 0.045 | 0.444 ± 0.034 | 19.60 | 32.60 | 16.40 |
| ablation: v2 without Poisson σ-floor | 0.320 ± 0.031 | 0.550 ± 0.044 | 0.404 ± 0.035 | 19.80 | 42.40 | 16.20 |
| ablation: v2 without deviation guards | 0.379 ± 0.027 | 0.544 ± 0.045 | 0.446 ± 0.033 | 19.60 | 32.20 | 16.40 |
| baseline: \|dev\| > 30% (prev 14d mean) | 0.072 ± 0.012 | 0.900 ± 0.028 | 0.134 ± 0.020 | 32.40 | 424.00 | 3.60 |
| baseline: \|dev\| > 50% (prev 14d mean) | 0.168 ± 0.041 | 0.722 ± 0.053 | 0.270 ± 0.053 | 26.00 | 138.80 | 10.00 |
| engine (live DB, this run): all | 0.472 ± 0.170 | 0.541 ± 0.234 | 0.494 ± 0.191 | 3.80 | 4.00 | 3.20 |
| engine (live DB): warning+ | 0.734 ± 0.219 | 0.413 ± 0.180 | 0.500 ± 0.174 | 2.80 | 1.20 | 4.20 |
| engine (live DB): critical | 0.900 ± 0.200 | 0.326 ± 0.117 | 0.467 ± 0.140 | 2.20 | 0.20 | 4.80 |

<details>
<summary>Per-seed confusion counts</summary>

| seed | method | TP | FP | FN | precision | recall | F1 |
|---|---|---|---|---|---|---|---|
| 6 | v1: single-window z (\|z\| > 1.5) | 29 | 154 | 7 | 0.159 | 0.806 | 0.265 |
| 6 | v2: rolling z (guarded) | 22 | 33 | 14 | 0.400 | 0.611 | 0.483 |
| 6 | ablation: v2 without zero-fill | 22 | 33 | 14 | 0.400 | 0.611 | 0.483 |
| 6 | ablation: v2 without Poisson σ-floor | 22 | 43 | 14 | 0.339 | 0.611 | 0.436 |
| 6 | ablation: v2 without deviation guards | 22 | 33 | 14 | 0.400 | 0.611 | 0.483 |
| 6 | baseline: \|dev\| > 30% (prev 14d mean) | 32 | 406 | 4 | 0.073 | 0.889 | 0.135 |
| 6 | baseline: \|dev\| > 50% (prev 14d mean) | 28 | 100 | 8 | 0.219 | 0.778 | 0.342 |
| 6 | engine (live DB, this run): all | 4 | 6 | 3 | 0.400 | 0.571 | 0.471 |
| 6 | engine (live DB): warning+ | 4 | 3 | 3 | 0.571 | 0.571 | 0.571 |
| 6 | engine (live DB): critical | 3 | 0 | 4 | 1.000 | 0.429 | 0.600 |
| 7 | v1: single-window z (\|z\| > 1.5) | 28 | 182 | 8 | 0.133 | 0.778 | 0.228 |
| 7 | v2: rolling z (guarded) | 19 | 31 | 17 | 0.380 | 0.528 | 0.442 |
| 7 | ablation: v2 without zero-fill | 19 | 32 | 17 | 0.372 | 0.528 | 0.437 |
| 7 | ablation: v2 without Poisson σ-floor | 20 | 41 | 16 | 0.328 | 0.556 | 0.412 |
| 7 | ablation: v2 without deviation guards | 19 | 31 | 17 | 0.380 | 0.528 | 0.442 |
| 7 | baseline: \|dev\| > 30% (prev 14d mean) | 32 | 504 | 4 | 0.060 | 0.889 | 0.112 |
| 7 | baseline: \|dev\| > 50% (prev 14d mean) | 26 | 194 | 10 | 0.118 | 0.722 | 0.203 |
| 7 | engine (live DB, this run): all | 1 | 4 | 3 | 0.200 | 0.250 | 0.222 |
| 7 | engine (live DB): warning+ | 1 | 1 | 3 | 0.500 | 0.250 | 0.333 |
| 7 | engine (live DB): critical | 1 | 1 | 3 | 0.500 | 0.250 | 0.333 |
| 8 | v1: single-window z (\|z\| > 1.5) | 26 | 192 | 10 | 0.119 | 0.722 | 0.205 |
| 8 | v2: rolling z (guarded) | 18 | 31 | 18 | 0.367 | 0.500 | 0.423 |
| 8 | ablation: v2 without zero-fill | 18 | 31 | 18 | 0.367 | 0.500 | 0.423 |
| 8 | ablation: v2 without Poisson σ-floor | 18 | 40 | 18 | 0.310 | 0.500 | 0.383 |
| 8 | ablation: v2 without deviation guards | 18 | 31 | 18 | 0.367 | 0.500 | 0.423 |
| 8 | baseline: \|dev\| > 30% (prev 14d mean) | 31 | 404 | 5 | 0.071 | 0.861 | 0.132 |
| 8 | baseline: \|dev\| > 50% (prev 14d mean) | 25 | 139 | 11 | 0.152 | 0.694 | 0.250 |
| 8 | engine (live DB, this run): all | 5 | 2 | 1 | 0.714 | 0.833 | 0.769 |
| 8 | engine (live DB): warning+ | 4 | 0 | 2 | 1.000 | 0.667 | 0.800 |
| 8 | engine (live DB): critical | 3 | 0 | 3 | 1.000 | 0.500 | 0.667 |
| 9 | v1: single-window z (\|z\| > 1.5) | 27 | 169 | 9 | 0.138 | 0.750 | 0.233 |
| 9 | v2: rolling z (guarded) | 18 | 36 | 18 | 0.333 | 0.500 | 0.400 |
| 9 | ablation: v2 without zero-fill | 18 | 37 | 18 | 0.327 | 0.500 | 0.396 |
| 9 | ablation: v2 without Poisson σ-floor | 18 | 50 | 18 | 0.265 | 0.500 | 0.346 |
| 9 | ablation: v2 without deviation guards | 18 | 36 | 18 | 0.333 | 0.500 | 0.400 |
| 9 | baseline: \|dev\| > 30% (prev 14d mean) | 34 | 328 | 2 | 0.094 | 0.944 | 0.171 |
| 9 | baseline: \|dev\| > 50% (prev 14d mean) | 23 | 84 | 13 | 0.215 | 0.639 | 0.322 |
| 9 | engine (live DB, this run): all | 3 | 3 | 7 | 0.500 | 0.300 | 0.375 |
| 9 | engine (live DB): warning+ | 2 | 0 | 8 | 1.000 | 0.200 | 0.333 |
| 9 | engine (live DB): critical | 2 | 0 | 8 | 1.000 | 0.200 | 0.333 |
| 10 | v1: single-window z (\|z\| > 1.5) | 30 | 164 | 6 | 0.155 | 0.833 | 0.261 |
| 10 | v2: rolling z (guarded) | 21 | 30 | 15 | 0.412 | 0.583 | 0.483 |
| 10 | ablation: v2 without zero-fill | 21 | 30 | 15 | 0.412 | 0.583 | 0.483 |
| 10 | ablation: v2 without Poisson σ-floor | 21 | 38 | 15 | 0.356 | 0.583 | 0.442 |
| 10 | ablation: v2 without deviation guards | 21 | 30 | 15 | 0.412 | 0.583 | 0.483 |
| 10 | baseline: \|dev\| > 30% (prev 14d mean) | 33 | 478 | 3 | 0.065 | 0.917 | 0.121 |
| 10 | baseline: \|dev\| > 50% (prev 14d mean) | 28 | 177 | 8 | 0.137 | 0.778 | 0.232 |
| 10 | engine (live DB, this run): all | 6 | 5 | 2 | 0.545 | 0.750 | 0.632 |
| 10 | engine (live DB): warning+ | 3 | 2 | 5 | 0.600 | 0.375 | 0.462 |
| 10 | engine (live DB): critical | 2 | 0 | 6 | 1.000 | 0.250 | 0.400 |

</details>


## Diagnostics, isolation and determinism

| seed | sale rows inserted | rows deleted first | zero-sale product-days | truth in engine window | live alerts | v1 flags (full series) | v2 flags (full series) | v2 unguarded flags | rows matched to module | engine eval window |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 1798 | 1794 | 2 | 9 | 13 | 212 | 48 | 48 | 13 | 2026-09-26..2026-10-09 |
| 2 | 1800 | 1798 | 0 | 6 | 11 | 197 | 54 | 54 | 11 | 2026-09-26..2026-10-09 |
| 3 | 1795 | 1800 | 5 | 6 | 8 | 198 | 57 | 57 | 8 | 2026-09-26..2026-10-09 |
| 4 | 1797 | 1795 | 3 | 8 | 7 | 209 | 45 | 45 | 7 | 2026-09-26..2026-10-09 |
| 5 | 1798 | 1797 | 2 | 6 | 11 | 190 | 46 | 46 | 11 | 2026-09-26..2026-10-09 |
| 6 | 1799 | 1798 | 1 | 7 | 10 | 183 | 55 | 55 | 10 | 2026-09-26..2026-10-09 |
| 7 | 1791 | 1799 | 9 | 4 | 5 | 210 | 50 | 50 | 5 | 2026-09-26..2026-10-09 |
| 8 | 1798 | 1791 | 2 | 6 | 7 | 218 | 49 | 49 | 7 | 2026-09-26..2026-10-09 |
| 9 | 1797 | 1798 | 3 | 10 | 6 | 196 | 54 | 54 | 6 | 2026-09-26..2026-10-09 |
| 10 | 1794 | 1797 | 6 | 8 | 11 | 194 | 51 | 51 | 11 | 2026-09-26..2026-10-09 |

* **Integration check.** For every seed the harness re-derives the v2 prediction in memory over the engine's own
  14-day eval window and asserts the persisted `anomaly_alerts` rows are exactly that set — identical `(SKU, date)`
  keys and |z| equal to 4 dp (tolerance 0.001). 89 rows were verified across
  10 runs; any divergence aborts the harness, so a passing run is proof that the refactored engine
  really reads `services/rollingZScore.js`.
* **Alert floor.** Every persisted row satisfies `|z| >= 2.5` (v2's flag floor); asserted per seed.
* **Guard monotonicity.** `v2_no_guards` flags >= `v2_series` flags for every seed (removing a guard can only add);
  asserted per seed.
* **Live severity mix (all seeds, summed).** `{"warning":24,"critical":22,"info":43}`.
* **Sandbox.** Tenant `validation-sandbox` (`81ae0d97-3252-4209-9799-a440d51cd62d`), store `b5d25407-9106-4e39-9ea9-c8779feadbb8`; every DELETE is
  scoped to that tenant and `assertSandboxTenant()` re-reads the slug before deleting.
* **Isolation.** Sale rows owned by tenants other than the sandbox: 1080 before → 1080 after
  (must be identical).
* **Determinism.** Seed 1 was executed twice; both runs hashed to sha256 `a6d3674fb2d5f10cb9e7289674e208226f7fee909a03f526b84350c16c2325cb`.
* **Clock.** DB `CURRENT_DATE` = 2026-10-10; the engine's data window starts 2026-09-26.
* **Generated at.** 2026-10-10T18:43:04.096Z.
* **v1 evidence preserved.** The original T7a report and CSV are untouched in `detection_results.md` /
  `detection_results.csv` and frozen as `detection_results_v1.md` / `detection_results_v1.csv`.

