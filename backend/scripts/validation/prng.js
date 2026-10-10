/**
 * backend/scripts/validation/prng.js
 * ──────────────────────────────────────────────────────────────────────────────
 * Seeded pseudo-random number generator for the detection-validation harness
 * (T7a). Every random value consumed by the synthetic data generator and by the
 * anomaly injector comes from here, so a given seed always produces identical
 * data — a hard requirement for reproducible research results.
 *
 * Algorithm: mulberry32 (Tommy Ettinger's 32-bit PRNG). It is not
 * cryptographic; it is used because it is ~10 lines, dependency-free and
 * deterministic across Node versions and platforms.
 * ──────────────────────────────────────────────────────────────────────────────
 */

/**
 * Creates a mulberry32 generator function.
 * @param {number} seed Any integer (coerced to uint32).
 * @returns {() => number} Function returning uniform values in [0, 1).
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Standard normal variate from any uniform source (Box–Muller transform).
 * @param {() => number} rand Uniform generator in [0, 1).
 * @returns {number} A value drawn from N(0, 1).
 */
export function normal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();   // avoid log(0)
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Uniform integer in [min, max] — both bounds inclusive.
 * @param {() => number} rand Uniform generator in [0, 1).
 * @param {number} min Inclusive lower bound.
 * @param {number} max Inclusive upper bound.
 * @returns {number} Integer between min and max.
 */
export function randInt(rand, min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

/**
 * Convenience bundle: one seed → all the samplers used by the generator.
 * @param {number} seed Any integer seed.
 * @returns {{rand: () => number, uniform: (min: number, max: number) => number,
 *            normal: () => number, randInt: (min: number, max: number) => number}}
 *   Sampler object backed by a single mulberry32 stream.
 */
export function createPrng(seed) {
  const rand = mulberry32(seed);
  return {
    rand,
    uniform: (min, max) => min + rand() * (max - min),
    normal: () => normal(rand),
    randInt: (min, max) => randInt(rand, min, max),
  };
}
