import type { DataHealth, FeeBreakdown, Instrument, OrderRecord, Position, Quote, RiskCheck, RiskDecision, RiskLimits } from "../types";
import { round } from "../util/math";
import { HARD_CEILINGS } from "./limits";

/** Everything the risk engine needs, passed in explicitly so it holds no state of its own. */
export interface EntryRiskContext {
  now: number;
  tradingMode: string;
  limits: RiskLimits;
  emergencyStopActive: boolean;
  instrument: Instrument | undefined;
  allowedSymbols: ReadonlySet<string>;
  quote: Quote | undefined;
  dataHealth: DataHealth;
  order: {
    symbol: string;
    side: "BUY" | "SELL";
    quantity: number;
    entryPrice: number;
    stopPrice: number;
    estCosts: FeeBreakdown;
    /** Price at proposal time, used for the drift check at execution. */
    proposedPrice?: number;
    leverage?: number;
  };
  cash: number;
  equity: number;
  dayStartEquity: number;
  entriesToday: number;
  positions: Position[];
  /** Orders submitted but not yet filled/rejected (for duplicate protection). */
  openOrders: OrderRecord[];
  /** Symbols with an approval currently executing. */
  inFlightSymbols: ReadonlySet<string>;
}

/**
 * Independent pre-trade risk validation for NEW ENTRY orders.
 *
 * This module does not trust the strategy, the AI or the UI: it recomputes risk
 * from raw inputs and every check must pass. It is run twice – when a proposal
 * is created and again, with a fresh quote, at the moment of execution.
 */
export function validateEntry(ctx: EntryRiskContext): RiskDecision {
  const { limits, order } = ctx;
  const checks: RiskCheck[] = [];
  const add = (id: string, label: string, passed: boolean, detail: string) => checks.push({ id, label, passed, detail });

  add("demo_mode", "Demo mode only", ctx.tradingMode === "demo", `Mode: ${ctx.tradingMode}`);
  add("emergency_stop", "Emergency stop off", !ctx.emergencyStopActive, ctx.emergencyStopActive ? "Emergency stop is ACTIVE" : "Off");

  // Limits must never exceed the hard ceilings, whatever was loaded from config/state.
  const ceilingBreaches = (Object.keys(HARD_CEILINGS) as (keyof RiskLimits)[]).filter((k) =>
    k === "equityFloorGBP" || k === "minOrderValueGBP" ? limits[k] < HARD_CEILINGS[k] : limits[k] > HARD_CEILINGS[k],
  );
  add("limits_sane", "Risk limits within hard ceilings", ceilingBreaches.length === 0, ceilingBreaches.length ? `Breached: ${ceilingBreaches.join(", ")}` : "OK");

  const inst = ctx.instrument;
  add(
    "instrument",
    "Instrument on the ETF allow-list",
    !!inst && inst.type === "ETF" && ctx.allowedSymbols.has(order.symbol),
    inst ? `${inst.symbol} (${inst.type})` : `Unknown symbol ${order.symbol}`,
  );

  const q = ctx.quote;
  const age = q ? ctx.now - q.asOf : Infinity;
  const fresh = !!q && ctx.dataHealth.ok && age <= limits.maxDataAgeMs && q.bid > 0 && q.ask >= q.bid;
  add("data_fresh", "Market data fresh and valid", fresh, q ? `${Math.round(age / 1000)}s old (max ${limits.maxDataAgeMs / 1000}s) · ${ctx.dataHealth.detail}` : "No quote");

  add("long_only", "Buy-only entry (no shorting)", order.side === "BUY", order.side);
  add("no_leverage", "No leverage, margin or CFDs", (order.leverage ?? 1) === 1, `Leverage ${order.leverage ?? 1}x`);

  const qtyOk = Number.isFinite(order.quantity) && order.quantity > 0;
  add("quantity", "Positive quantity", qtyOk, `${order.quantity}`);

  const entry = q ? q.ask : order.entryPrice;
  const notional = round(order.quantity * entry);
  const totalCash = notional + order.estCosts.explicitTotal / 2;
  add("cash", "Paid from available cash", totalCash <= ctx.cash + 1e-9, `Needs £${totalCash.toFixed(2)}, cash £${ctx.cash.toFixed(2)}`);

  const stopOk = order.stopPrice > 0 && order.stopPrice < entry;
  add("stop", "Protective stop below entry", stopOk, `Stop ${order.stopPrice} vs entry ${entry}`);

  const costs = order.estCosts.explicitTotal + order.estCosts.spreadCost;
  const risk = round(order.quantity * Math.max(0, entry - order.stopPrice) + costs);
  add("risk_per_trade", `Risk ≤ £${limits.maxRiskPerTradeGBP.toFixed(2)} per trade`, stopOk && risk <= limits.maxRiskPerTradeGBP + 1e-9, `£${risk.toFixed(4)} at stop incl. costs`);

  add("position_size", `Position ≤ £${limits.maxPositionValueGBP.toFixed(2)}`, notional <= limits.maxPositionValueGBP + 1e-9, `£${notional.toFixed(2)}`);
  add("min_order", `Order ≥ £${limits.minOrderValueGBP.toFixed(2)}`, notional >= limits.minOrderValueGBP, `£${notional.toFixed(2)}`);

  const costRatio = risk > 0 ? costs / risk : 1;
  add("cost_ratio", `Costs ≤ ${Math.round(limits.maxCostToRiskRatio * 100)}% of risk`, costRatio <= limits.maxCostToRiskRatio, `${(costRatio * 100).toFixed(1)}% (£${costs.toFixed(4)})`);

  add("max_positions", `≤ ${limits.maxOpenPositions} open positions`, ctx.positions.length < limits.maxOpenPositions, `${ctx.positions.length} open`);
  add("daily_trades", `≤ ${limits.maxTradesPerDay} new trades today`, ctx.entriesToday < limits.maxTradesPerDay, `${ctx.entriesToday} today`);

  const dayPnl = ctx.equity - ctx.dayStartEquity;
  add("daily_loss", `Daily loss under £${limits.maxDailyLossGBP.toFixed(2)}`, dayPnl > -limits.maxDailyLossGBP, `Today £${dayPnl.toFixed(2)}`);
  add("equity_floor", `Equity above £${limits.equityFloorGBP.toFixed(2)} floor`, ctx.equity > limits.equityFloorGBP, `Equity £${ctx.equity.toFixed(2)}`);

  const dup =
    ctx.positions.some((p) => p.symbol === order.symbol) ||
    ctx.openOrders.some((o) => o.request.symbol === order.symbol && o.status === "ACCEPTED") ||
    ctx.inFlightSymbols.has(order.symbol);
  add("duplicate", "No existing position or open order in this ETF", !dup, dup ? "Already holding / order open" : "None");

  if (order.proposedPrice !== undefined && q) {
    const driftBps = (Math.abs(q.ask - order.proposedPrice) / order.proposedPrice) * 10_000;
    add("price_drift", `Price moved ≤ ${limits.maxPriceDriftBps}bps since proposal`, driftBps <= limits.maxPriceDriftBps, `${driftBps.toFixed(1)}bps`);
  }

  return { approved: checks.every((c) => c.passed), checks, evaluatedAt: ctx.now };
}

export function failedChecks(d: RiskDecision): RiskCheck[] {
  return d.checks.filter((c) => !c.passed);
}
