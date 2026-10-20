import { describe, expect, it } from "vitest";
import { Trading212FeeModel } from "../src/core/fees/feeModel";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import { DEFAULT_LIMITS, HARD_CEILINGS, clampToCeilings, tightenLimits } from "../src/core/risk/limits";
import { validateEntry, type EntryRiskContext } from "../src/core/risk/riskEngine";
import { sizePosition } from "../src/core/risk/sizing";
import type { RiskLimits } from "../src/core/types";

const VUSA = ETF_UNIVERSE.find((i) => i.symbol === "VUSA")!;
const fees = new Trading212FeeModel();
const limits: RiskLimits = { ...DEFAULT_LIMITS };
const NOW = 1_000_000;

function ctx(over: Partial<EntryRiskContext> = {}, order: Partial<EntryRiskContext["order"]> = {}): EntryRiskContext {
  return {
    now: NOW,
    tradingMode: "demo",
    limits,
    emergencyStopActive: false,
    instrument: VUSA,
    allowedSymbols: new Set(["VUSA"]),
    quote: { symbol: "VUSA", bid: 99.98, ask: 100, mid: 99.99, asOf: NOW - 1000, source: "SIMULATED" },
    dataHealth: { source: "SIMULATED", ok: true, lastUpdate: NOW, detail: "ok" },
    order: { symbol: "VUSA", side: "BUY", quantity: 0.1, entryPrice: 100, stopPrice: 99, estCosts: fees.roundTrip(VUSA, 10), ...order },
    cash: 50,
    equity: 50,
    dayStartEquity: 50,
    entriesToday: 0,
    positions: [],
    openOrders: [],
    inFlightSymbols: new Set(),
    ...over,
  };
}
const failed = (c: EntryRiskContext) => validateEntry(c).checks.filter((x) => !x.passed).map((x) => x.id);

describe("position sizing", () => {
  it("never risks more than £0.50 including costs", () => {
    const r = sizePosition({ instrument: VUSA, entry: 100, stop: 90, target: 115, cash: 50, limits, fees });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.riskGBP).toBeLessThanOrEqual(0.5);
      expect(r.cappedBy).toBe("risk per trade");
    }
  });
  it("caps at the fixed max position size when the stop is tight", () => {
    const r = sizePosition({ instrument: VUSA, entry: 100, stop: 99.9, target: 100.3, cash: 50, limits, fees });
    expect(r.ok && r.notional <= limits.maxPositionValueGBP).toBe(true);
    if (r.ok) expect(r.cappedBy).toBe("max position size");
  });
  it("never sizes beyond available cash (no leverage)", () => {
    const r = sizePosition({ instrument: VUSA, entry: 100, stop: 99.9, target: 100.3, cash: 5, limits, fees });
    expect(r.ok && r.notional <= 5).toBe(true);
  });
  it("refuses orders below the minimum and invalid stops", () => {
    expect(sizePosition({ instrument: VUSA, entry: 100, stop: 99.9, target: 101, cash: 0.5, limits, fees }).ok).toBe(false);
    expect(sizePosition({ instrument: VUSA, entry: 100, stop: 101, target: 101, cash: 50, limits, fees }).ok).toBe(false);
  });
});

describe("risk engine", () => {
  it("approves a compliant order", () => {
    expect(validateEntry(ctx()).approved).toBe(true);
  });
  it("blocks anything outside demo mode", () => {
    expect(failed(ctx({ tradingMode: "live" }))).toContain("demo_mode");
  });
  it("blocks when the emergency stop is on", () => {
    expect(failed(ctx({ emergencyStopActive: true }))).toContain("emergency_stop");
  });
  it("blocks stale or missing data", () => {
    expect(failed(ctx({ quote: { symbol: "VUSA", bid: 99.98, ask: 100, mid: 99.99, asOf: NOW - 120_000, source: "SIMULATED" } }))).toContain("data_fresh");
    expect(failed(ctx({ dataHealth: { source: "SIMULATED", ok: false, lastUpdate: 0, detail: "down" } }))).toContain("data_fresh");
    expect(failed(ctx({ quote: undefined }))).toContain("data_fresh");
  });
  it("blocks risk above £0.50", () => {
    expect(failed(ctx({}, { quantity: 0.12, stopPrice: 95 }))).toContain("risk_per_trade");
  });
  it("blocks leverage, shorting, oversize and insufficient cash", () => {
    expect(failed(ctx({}, { leverage: 2 }))).toContain("no_leverage");
    expect(failed(ctx({}, { side: "SELL" }))).toContain("long_only");
    expect(failed(ctx({}, { quantity: 0.2, stopPrice: 99.9 }))).toContain("position_size");
    expect(failed(ctx({ cash: 5 }))).toContain("cash");
  });
  it("blocks duplicates: existing position, open order or in-flight approval", () => {
    const pos = { symbol: "VUSA", quantity: 1, avgPrice: 1, costBasis: 1, stopPrice: 0, targetPrice: 0, openedAt: 0, feesPaid: 0 };
    expect(failed(ctx({ positions: [pos] }))).toContain("duplicate");
    expect(failed(ctx({ inFlightSymbols: new Set(["VUSA"]) }))).toContain("duplicate");
    const order = { id: "o", request: { clientOrderId: "x", symbol: "VUSA", t212Ticker: "", side: "BUY" as const, quantity: 1, type: "MARKET" as const, reason: "ENTRY" as const }, status: "ACCEPTED" as const, broker: "b", submittedAt: 0, simulated: true };
    expect(failed(ctx({ openOrders: [order] }))).toContain("duplicate");
  });
  it("blocks after the daily loss limit, trade count or equity floor", () => {
    expect(failed(ctx({ equity: 48.4 }))).toContain("daily_loss");
    expect(failed(ctx({ entriesToday: 3 }))).toContain("daily_trades");
    expect(failed(ctx({ equity: 44, dayStartEquity: 44 }))).toContain("equity_floor");
  });
  it("blocks if price drifted too far since the proposal", () => {
    expect(failed(ctx({}, { proposedPrice: 99 }))).toContain("price_drift");
  });
  it("blocks non-allow-listed instruments", () => {
    expect(failed(ctx({ allowedSymbols: new Set() }))).toContain("instrument");
  });
  it("blocks if limits were tampered above the hard ceiling", () => {
    expect(failed(ctx({ limits: { ...limits, maxRiskPerTradeGBP: 5 } }))).toContain("limits_sane");
  });
});

describe("limits", () => {
  it("allows tightening", () => {
    expect(tightenLimits(limits, { maxRiskPerTradeGBP: 0.25 }).maxRiskPerTradeGBP).toBe(0.25);
    expect(tightenLimits(limits, { equityFloorGBP: 48 }).equityFloorGBP).toBe(48);
  });
  it("refuses loosening from the app", () => {
    expect(() => tightenLimits(limits, { maxRiskPerTradeGBP: 0.75 })).toThrow(/tightened/);
    expect(() => tightenLimits(limits, { equityFloorGBP: 10 })).toThrow(/tightened/);
    expect(() => tightenLimits(limits, { maxOpenPositions: Number.NaN })).toThrow();
  });
  it("clamps configured limits to hard ceilings (£0.50 max risk)", () => {
    expect(clampToCeilings({ ...limits, maxRiskPerTradeGBP: 10 }).maxRiskPerTradeGBP).toBe(HARD_CEILINGS.maxRiskPerTradeGBP);
    expect(HARD_CEILINGS.maxRiskPerTradeGBP).toBe(0.5);
  });
});
