# Isolation Forest — dev tuning (seeds 1-5)

Generated 2026-11-17T12:08:05.038Z by `backend/scripts/validation/runIsolationForestValidation.js`.

Frozen protocol: `docs/validation/frozen_config_iforest.json`. Tuning used **dev seeds 1-5 only**; held-out seeds 6-10 were not read.

## Series

- generator `backend/scripts/validation/generateSyntheticData.js`, 20 products × 90 days, last day 2026-10-09
- `endDate` pinned to 2026-10-10T07:00:00.000Z — the clock the v2 hold-out ran on
- 36 injected anomalies per seed
- detector `backend/src/services/isolationForest.js`, features units, revenue, residualVsWeekdayMean, ratioToPrevious14dMean

## Contamination grid

| contamination | flags/seed | precision | recall | F1 | F1 sd | TP | FP | FN |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0.01 | 16.0 | 0.688 | 0.306 | 0.423 | 0.081 | 11.0 | 5.0 | 25.0 |
| 0.015 | 23.0 | 0.565 | 0.361 | 0.441 | 0.074 | 13.0 | 10.0 | 23.0 |
| 0.02 | 31.0 | 0.471 | 0.406 | 0.436 | 0.070 | 14.6 | 16.4 | 21.4 |
| 0.025 | 39.0 | 0.431 | 0.467 | 0.448 | 0.057 | 16.8 | 22.2 | 19.2 |
| 0.03 | 46.0 | 0.396 | 0.506 | 0.444 | 0.063 | 18.2 | 27.8 | 17.8 |
| 0.035 | 54.0 | 0.352 | 0.528 | 0.422 | 0.047 | 19.0 | 35.0 | 17.0 |
| 0.04 | 61.0 | 0.318 | 0.539 | 0.400 | 0.046 | 19.4 | 41.6 | 16.6 |
| 0.05 | 77.0 | 0.278 | 0.594 | 0.379 | 0.043 | 21.4 | 55.6 | 14.6 |
| 0.06 | 92.0 | 0.241 | 0.617 | 0.347 | 0.041 | 22.2 | 69.8 | 13.8 |
| 0.08 | 122.0 | 0.189 | 0.639 | 0.291 | 0.035 | 23.0 | 99.0 | 13.0 |
| 0.1 | 153.0 | 0.157 | 0.667 | 0.254 | 0.020 | 24.0 | 129.0 | 12.0 |
| 0.12 | 183.0 | 0.137 | 0.694 | 0.228 | 0.022 | 25.0 | 158.0 | 11.0 |
| 0.15 | 229.0 | 0.114 | 0.728 | 0.198 | 0.018 | 26.2 | 202.8 | 9.8 |

Selection rule: Highest mean F1 over dev seeds 1-5 across CONTAMINATION_GRID; ties go to the smaller contamination (quieter detector). Rule fixed before the hold-out was run.

**Chosen: contamination 0.025** (mean F1 0.448, F1 sd across seeds 0.057).

## Per seed at the chosen threshold

| seed | IF flags | IF P | IF R | IF F1 | IF@v2-budget F1 | v2 flags | v2 P | v2 R | v2 F1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 39 | 0.385 | 0.417 | 0.400 | 0.381 | 48 | 0.375 | 0.500 | 0.429 |
| 2 | 39 | 0.436 | 0.472 | 0.453 | 0.400 | 54 | 0.389 | 0.583 | 0.467 |
| 3 | 39 | 0.462 | 0.500 | 0.480 | 0.452 | 57 | 0.386 | 0.611 | 0.473 |
| 4 | 39 | 0.359 | 0.389 | 0.373 | 0.370 | 45 | 0.378 | 0.472 | 0.420 |
| 5 | 39 | 0.513 | 0.556 | 0.533 | 0.537 | 46 | 0.413 | 0.528 | 0.463 |

`IF@v2-budget F1` scores the forest on its own top-k days, k = the number of flags v2 took on that same seed. It is a fairness arm, not a tuned setting.

## Dev reference points

| method | flags/seed | precision | recall | F1 |
| --- | --- | --- | --- | --- |
| IF @ 0.025 | 39.0 | 0.431 | 0.467 | 0.448 |
| IF @ matched budget | 50.0 | 0.369 | 0.511 | 0.428 |
| v2 rolling z-score | 50.0 | 0.388 | 0.539 | 0.450 |

The v2 row is recomputed in memory and asserted against the published dev means (0.388 / 0.539 / 0.450) before any IF number is read, so all three rows come from identical series and ground truth.
