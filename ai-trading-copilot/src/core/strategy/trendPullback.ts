import type { Bar, Instrument, Quote, RuleCheck, Signal } from "../types";
import { round } from "../util/math";
import { atr, rsi, sma } from "./indicators";

export interface StrategyParams {
  fast: number;
  slow: number;
  rsiPeriod: number;
  rsiMin: number;
  rsiMax: number;
  atrPeriod: number;
  maxAtrPct: number;
  stopAtr: number;
  targetAtr: number;
  minLiquidityGBPm: number;
  maxSpreadBps: number;
}

export const DEFAULT_STRATEGY: StrategyParams = {
  fast: 20,
  slow: 50,
  rsiPeriod: 14,
  rsiMin: 50,
  rsiMax: 70,
  atrPeriod: 14,
  maxAtrPct: 0.6,
  stopAtr: 2,
  targetAtr: 3,
  minLiquidityGBPm: 10,
  maxSpreadBps: 15,
};

export const STRATEGY_NAME = "Trend + momentum (long only)";

/**
 * Transparent, rules-based, long-only signal. Every rule is reported with its
 * value and threshold so the user can see exactly why a trade is suggested.
 * A BUY signal requires ALL rules to pass. No AI is involved here.
 */
export function evaluateTrend(
  instrument: Instrument,
  bars: Bar[],
  quote: Quote | undefined,
  now: number,
  p: StrategyParams = DEFAULT_STRATEGY,
): Signal {
  const closes = bars.map((b) => b.c);
  const price = quote?.ask ?? closes[closes.length - 1] ?? 0;
  const fast = sma(closes, p.fast);
  const slow = sma(closes, p.slow);
  const fastPrev = sma(closes.slice(0, -5), p.fast);
  const r = rsi(closes, p.rsiPeriod);
  const a = atr(bars, p.atrPeriod);

  const base = { symbol: instrument.symbol, side: "BUY" as const, strategy: STRATEGY_NAME, price, generatedAt: now };
  if (fast === undefined || slow === undefined || fastPrev === undefined || r === undefined || a === undefined) {
    return { ...base, status: "INSUFFICIENT_DATA", rules: [], score: 0, indicators: {}, stop: 0, target: 0 };
  }

  const last = closes[closes.length - 1]!;
  const atrPct = (a / last) * 100;
  const f = (x: number) => (x >= 100 ? x.toFixed(2) : x.toFixed(3));

  const rules: RuleCheck[] = [
    { id: "trend", label: `Up-trend: SMA${p.fast} above SMA${p.slow}`, passed: fast > slow, detail: `SMA${p.fast} ${f(fast)} vs SMA${p.slow} ${f(slow)}` },
    { id: "slope", label: `SMA${p.fast} rising`, passed: fast > fastPrev, detail: `${f(fast)} now vs ${f(fastPrev)} five bars ago` },
    { id: "momentum", label: `Price above SMA${p.fast}`, passed: last > fast, detail: `Last ${f(last)} vs SMA${p.fast} ${f(fast)}` },
    { id: "rsi", label: `RSI(${p.rsiPeriod}) between ${p.rsiMin} and ${p.rsiMax}`, passed: r >= p.rsiMin && r <= p.rsiMax, detail: `RSI ${r.toFixed(1)}` },
    { id: "volatility", label: `Volatility calm: ATR ≤ ${p.maxAtrPct}% of price`, passed: atrPct <= p.maxAtrPct, detail: `ATR ${atrPct.toFixed(2)}% of price` },
    { id: "liquidity", label: `Liquid: ≥ £${p.minLiquidityGBPm}m/day, spread ≤ ${p.maxSpreadBps}bps`, passed: instrument.avgDailyValueGBPm >= p.minLiquidityGBPm && instrument.spreadBps <= p.maxSpreadBps, detail: `£${instrument.avgDailyValueGBPm}m/day, ${instrument.spreadBps}bps spread (assumed)` },
  ];

  const passed = rules.filter((x) => x.passed).length;
  const score = passed / rules.length;
  const status = passed === rules.length ? "SIGNAL" : passed >= rules.length - 2 ? "WATCH" : "NO_SETUP";

  return {
    ...base,
    status,
    rules,
    score,
    indicators: { smaFast: round(fast), smaSlow: round(slow), rsi: round(r, 2), atr: round(a), atrPct: round(atrPct, 3), last },
    stop: round(price - p.stopAtr * a),
    target: round(price + p.targetAtr * a),
  };
}
