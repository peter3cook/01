import type { RiskLimits } from "../types";

/**
 * Phase 1 default limits for a £50 simulated account. These are FIXED £ amounts:
 * they never scale up automatically as the balance grows or to chase a target.
 */
export const DEFAULT_LIMITS: Readonly<RiskLimits> = Object.freeze({
  maxRiskPerTradeGBP: 0.5,
  maxPositionValueGBP: 12.5,
  maxOpenPositions: 3,
  maxTradesPerDay: 3,
  maxDailyLossGBP: 1.5,
  equityFloorGBP: 45,
  minOrderValueGBP: 1,
  maxCostToRiskRatio: 0.25,
  maxDataAgeMs: 60_000,
  maxPriceDriftBps: 30,
  proposalTtlMs: 10 * 60_000,
  maxCapitalGBP: 50,
});

/**
 * Hard ceilings enforced in code. Neither config, the UI, nor any automated
 * process can set a limit beyond these. Raising them is a deliberate code change.
 */
export const HARD_CEILINGS: Readonly<RiskLimits> = Object.freeze({
  maxRiskPerTradeGBP: 0.5,
  maxPositionValueGBP: 25,
  maxOpenPositions: 5,
  maxTradesPerDay: 5,
  maxDailyLossGBP: 2.5,
  equityFloorGBP: 0, // a floor can only be raised (that is tighter)
  minOrderValueGBP: 1, // the minimum can only be raised
  maxCostToRiskRatio: 0.5,
  maxDataAgeMs: 120_000,
  maxPriceDriftBps: 50,
  proposalTtlMs: 30 * 60_000,
  maxCapitalGBP: 100,
});

/** For these keys a HIGHER value is tighter; for all others LOWER is tighter. */
const HIGHER_IS_TIGHTER: ReadonlySet<keyof RiskLimits> = new Set(["equityFloorGBP", "minOrderValueGBP"]);

export function isTightening(key: keyof RiskLimits, from: number, to: number): boolean {
  return HIGHER_IS_TIGHTER.has(key) ? to >= from : to <= from;
}

export function withinCeiling(key: keyof RiskLimits, value: number): boolean {
  const c = HARD_CEILINGS[key];
  return HIGHER_IS_TIGHTER.has(key) ? value >= c : value <= c;
}

/** Clamp a configured limit set so it can never exceed the hard ceilings. */
export function clampToCeilings(limits: RiskLimits): RiskLimits {
  const out = { ...limits };
  for (const k of Object.keys(HARD_CEILINGS) as (keyof RiskLimits)[]) {
    if (!Number.isFinite(out[k])) out[k] = DEFAULT_LIMITS[k];
    if (!withinCeiling(k, out[k])) out[k] = HARD_CEILINGS[k];
  }
  return out;
}

/**
 * Apply a user change from the app. Only tightening is allowed at runtime;
 * any attempt to loosen a limit throws.
 */
export function tightenLimits(current: RiskLimits, patch: Partial<RiskLimits>): RiskLimits {
  const next = { ...current };
  for (const [k, v] of Object.entries(patch) as [keyof RiskLimits, number][]) {
    if (!(k in current)) throw new Error(`Unknown limit: ${String(k)}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`Invalid value for ${k}`);
    if (!isTightening(k, current[k], v)) {
      throw new Error(`${k} can only be tightened from the app. Loosening requires a reviewed config change.`);
    }
    next[k] = v;
  }
  return clampToCeilings(next);
}
