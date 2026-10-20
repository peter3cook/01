import type { FeeModel } from "../fees/feeModel";
import type { FeeBreakdown, Instrument, RiskLimits } from "../types";
import { floorTo, round } from "../util/math";

export interface SizingInput {
  instrument: Instrument;
  entry: number;
  stop: number;
  target: number;
  cash: number;
  limits: RiskLimits;
  fees: FeeModel;
}

export type SizingResult =
  | { ok: true; quantity: number; notional: number; riskGBP: number; rewardGBP: number; estCosts: FeeBreakdown; cappedBy: string }
  | { ok: false; reason: string };

/**
 * Fixed-risk position sizing: the loss at the stop, plus estimated round-trip
 * costs, must not exceed maxRiskPerTradeGBP. The size is then capped by the
 * fixed max position value and by available cash (no leverage, ever).
 */
export function sizePosition(i: SizingInput): SizingResult {
  const { instrument, entry, stop, target, cash, limits, fees } = i;
  if (!(entry > 0) || !(stop > 0) || stop >= entry) return { ok: false, reason: "Invalid stop: must be below entry" };

  const perShareRisk = entry - stop;
  const costRate = fees.roundTrip(instrument, 1).explicitTotal + fees.roundTrip(instrument, 1).spreadCost; // per £1 notional
  const riskPerShareAllIn = perShareRisk + entry * costRate;

  const byRisk = limits.maxRiskPerTradeGBP / riskPerShareAllIn;
  const byPosition = limits.maxPositionValueGBP / entry;
  // Keep a small cash buffer for explicit fees.
  const byCash = Math.max(0, cash * 0.995) / entry;
  const raw = Math.min(byRisk, byPosition, byCash);
  const cappedBy = raw === byRisk ? "risk per trade" : raw === byPosition ? "max position size" : "available cash";

  const quantity = floorTo(raw, instrument.qtyDecimals);
  const notional = round(quantity * entry);
  if (quantity <= 0 || notional < limits.minOrderValueGBP) {
    return { ok: false, reason: `Order value £${notional.toFixed(2)} below minimum £${limits.minOrderValueGBP.toFixed(2)}` };
  }
  const estCosts = fees.roundTrip(instrument, notional);
  const riskGBP = round(quantity * perShareRisk + estCosts.explicitTotal + estCosts.spreadCost);
  const rewardGBP = round(quantity * (target - entry) - estCosts.explicitTotal - estCosts.spreadCost);
  return { ok: true, quantity, notional, riskGBP, rewardGBP, estCosts, cappedBy };
}
