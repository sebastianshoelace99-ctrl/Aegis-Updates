/**
 * Seeded randomness for the local gallery generator.
 *
 * The gallery needs "random-looking but reproducible" data: the smoke test asserts against a
 * fixed grid, so the plate ids and colours cannot reshuffle between launches. `Math.random`
 * would make every run a different build.
 */

/** FNV-1a. Stable across runs and platforms, unlike `Math.random` or object key order. */
export function hashSeed(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

/** mulberry32: tiny, fast, and good enough for layout-shaped mock data. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Inclusive index pick, so callers never hand-roll `Math.floor(rand() * length)`. */
export function pickIndex(random: () => number, length: number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}
