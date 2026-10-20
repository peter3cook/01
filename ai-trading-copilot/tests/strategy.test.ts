import { describe, expect, it } from "vitest";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import { atr, rsi, sma } from "../src/core/strategy/indicators";
import { evaluateTrend } from "../src/core/strategy/trendPullback";
import { downtrendBars, T0, uptrendBars } from "./helpers";

const VUSA = ETF_UNIVERSE.find((i) => i.symbol === "VUSA")!;
const INRG = ETF_UNIVERSE.find((i) => i.symbol === "INRG")!;

describe("indicators", () => {
  it("computes SMA", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
    expect(sma([1], 2)).toBeUndefined();
  });
  it("RSI is 100 with no losses and ~67 for a 2:1 zig-zag", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])).toBe(100);
    const z = uptrendBars(100, 60, T0).map((b) => b.c);
    expect(rsi(z)!).toBeGreaterThan(60);
    expect(rsi(z)!).toBeLessThan(70);
  });
  it("ATR is positive", () => {
    expect(atr(uptrendBars(100, 30, T0))!).toBeGreaterThan(0);
  });
});

describe("trend strategy", () => {
  it("signals BUY only when every rule passes, with stop below and target above", () => {
    const s = evaluateTrend(VUSA, uptrendBars(90, 120, T0), undefined, T0);
    expect(s.status).toBe("SIGNAL");
    expect(s.rules.every((r) => r.passed)).toBe(true);
    expect(s.stop).toBeLessThan(s.price);
    expect(s.target).toBeGreaterThan(s.price);
    expect(s.side).toBe("BUY");
  });
  it("does not signal in a down-trend", () => {
    const s = evaluateTrend(VUSA, downtrendBars(90, 120, T0), undefined, T0);
    expect(s.status).not.toBe("SIGNAL");
    expect(s.rules.find((r) => r.id === "trend")!.passed).toBe(false);
  });
  it("rejects illiquid / wide-spread ETFs even in an up-trend", () => {
    const s = evaluateTrend(INRG, uptrendBars(6, 120, T0), undefined, T0);
    expect(s.status).not.toBe("SIGNAL");
    expect(s.rules.find((r) => r.id === "liquidity")!.passed).toBe(false);
  });
  it("reports insufficient data instead of guessing", () => {
    expect(evaluateTrend(VUSA, uptrendBars(90, 20, T0), undefined, T0).status).toBe("INSUFFICIENT_DATA");
  });
});
