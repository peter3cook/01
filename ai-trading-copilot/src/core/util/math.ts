/** Round to `dp` decimal places (default 4 – sub-penny precision for fractional shares). */
export function round(x: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round((x + Number.EPSILON) * f) / f;
}

/** Floor a quantity to the instrument's supported precision (never round up size). */
export function floorTo(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.floor(x * f + 1e-9) / f;
}

export function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Deterministic PRNG (mulberry32) so simulated data and tests are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal sample via Box–Muller. */
export function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
