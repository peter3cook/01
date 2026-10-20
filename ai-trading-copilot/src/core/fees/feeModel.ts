import type { FeeBreakdown, Instrument } from "../types";
import { round } from "../util/math";

export interface FeeModel {
  /** Cost of one side of a trade (buy or sell) for `notional` GBP. */
  oneSide(instrument: Instrument, notional: number, side: "BUY" | "SELL"): FeeBreakdown;
  /** Estimated buy + sell costs. */
  roundTrip(instrument: Instrument, notional: number): FeeBreakdown;
}

/**
 * Trading 212 Invest cost assumptions (check the current fee schedule before
 * going live): no commission, 0.15% FX fee only when the instrument currency
 * differs from the GBP account, no UK stamp duty on ETFs. The bid/ask spread is
 * an implicit cost that is already in the fill price; it is estimated here so
 * it can be shown and counted against the risk budget.
 */
export class Trading212FeeModel implements FeeModel {
  constructor(private readonly accountCurrency = "GBP", private readonly fxRate = 0.0015) {}

  oneSide(instrument: Instrument, notional: number, _side: "BUY" | "SELL"): FeeBreakdown {
    const commission = 0;
    const fxFee = instrument.currency !== this.accountCurrency ? round(notional * this.fxRate) : 0;
    const stampDuty = 0; // ETFs are exempt from UK stamp duty
    const spreadCost = round((notional * instrument.spreadBps) / 2 / 10_000);
    return { commission, fxFee, stampDuty, explicitTotal: round(commission + fxFee + stampDuty), spreadCost };
  }

  roundTrip(instrument: Instrument, notional: number): FeeBreakdown {
    const a = this.oneSide(instrument, notional, "BUY");
    const b = this.oneSide(instrument, notional, "SELL");
    return addFees(a, b);
  }
}

export function addFees(a: FeeBreakdown, b: FeeBreakdown): FeeBreakdown {
  return {
    commission: round(a.commission + b.commission),
    fxFee: round(a.fxFee + b.fxFee),
    stampDuty: round(a.stampDuty + b.stampDuty),
    explicitTotal: round(a.explicitTotal + b.explicitTotal),
    spreadCost: round(a.spreadCost + b.spreadCost),
  };
}

export const ZERO_FEES: FeeBreakdown = { commission: 0, fxFee: 0, stampDuty: 0, explicitTotal: 0, spreadCost: 0 };
