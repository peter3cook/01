import { describe, expect, it, vi } from "vitest";
import { FallbackExplainer, type ExplanationInput, type TradeExplainer } from "../src/core/ai/explainer";
import { TemplateExplainer } from "../src/core/ai/templateExplainer";
import { appendAudit, verifyAudit } from "../src/core/audit/auditLog";
import { ExecutionService } from "../src/core/execution/executionService";
import { Trading212FeeModel } from "../src/core/fees/feeModel";
import { SimulatedMarketData } from "../src/core/marketdata/simulated";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import type { AuditEntry, OrderRecord } from "../src/core/types";
import { sha256Hex } from "../src/core/util/sha256";
import { T0 } from "./helpers";

describe("sha256 + audit log", () => {
  it("matches a known SHA-256 vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
  it("detects tampering", () => {
    const log: AuditEntry[] = [];
    appendAudit(log, 1, "user", "A", "one");
    appendAudit(log, 2, "user", "B", "two");
    appendAudit(log, 3, "user", "C", "three");
    expect(verifyAudit(log).ok).toBe(true);
    log[1]!.message = "edited";
    expect(verifyAudit(log)).toEqual({ ok: false, brokenAt: 2 });
  });
});

describe("fees", () => {
  const fm = new Trading212FeeModel();
  const VUSA = ETF_UNIVERSE[0]!;
  it("charges no commission or stamp duty on GBP ETFs, only spread", () => {
    const f = fm.roundTrip(VUSA, 10);
    expect(f.commission).toBe(0);
    expect(f.stampDuty).toBe(0);
    expect(f.fxFee).toBe(0);
    expect(f.spreadCost).toBeCloseTo((10 * VUSA.spreadBps) / 10_000, 6);
  });
  it("applies the 0.15% FX fee to non-GBP instruments", () => {
    const usd = { ...VUSA, currency: "USD" as unknown as "GBP" };
    expect(fm.oneSide(usd, 100, "BUY").fxFee).toBeCloseTo(0.15, 6);
  });
});

describe("simulated market data", () => {
  it("labels everything SIMULATED and goes stale during an outage", () => {
    const md = new SimulatedMarketData({ now: T0, barMs: 15_000 });
    expect(md.quote("VUSA")!.source).toBe("SIMULATED");
    expect(md.health(T0).ok).toBe(true);
    md.setOutage(true);
    md.tick(T0 + 120_000);
    expect(md.health(T0 + 120_000).ok).toBe(false);
    expect(md.quote("VUSA")!.asOf).toBe(T0);
  });
  it("is deterministic for a given seed and survives a snapshot round-trip", () => {
    const a = new SimulatedMarketData({ now: T0, seed: 7 });
    const b = new SimulatedMarketData({ now: T0, seed: 7 });
    expect(a.quote("ISF")).toEqual(b.quote("ISF"));
    const c = SimulatedMarketData.fromSnapshot(a.snapshot(), T0);
    expect(c.quote("ISF")!.mid).toBe(a.quote("ISF")!.mid);
  });
});

describe("execution idempotency", () => {
  it("submits once per clientOrderId, even concurrently", async () => {
    const orders: OrderRecord[] = [];
    const place = vi.fn(async () => ({ status: "FILLED" as const, brokerOrderId: "1", simulated: true, fill: { price: 1, quantity: 1, at: 0, fees: { commission: 0, fxFee: 0, stampDuty: 0, explicitTotal: 0, spreadCost: 0 } } }));
    const ex = new ExecutionService({ name: "x", environment: "SIMULATED", placeOrder: place }, () => orders, (r) => orders.push(r), () => `o${orders.length}`);
    const req = { clientOrderId: "k1", symbol: "VUSA", t212Ticker: "VUSAl_EQ", side: "BUY" as const, quantity: 1, type: "MARKET" as const, reason: "ENTRY" as const };
    await Promise.all([ex.submit(req, 0), ex.submit(req, 0)]);
    await ex.submit(req, 0);
    expect(place).toHaveBeenCalledTimes(1);
    expect(orders).toHaveLength(1);
  });
});

describe("explanations", () => {
  const input = { instrument: ETF_UNIVERSE[0]!, signal: { rules: [], indicators: {} }, quantity: 0.1, entryPrice: 1, stopPrice: 0.9, targetPrice: 1.2, notionalGBP: 1, riskGBP: 0.1, rewardGBP: 0.2, estCostsGBP: 0, accountEquityGBP: 50, dataSource: "SIMULATED" } as unknown as ExplanationInput;
  const budget = (ok: boolean) => ({ allow: () => ok, record: vi.fn() });

  it("falls back to the template when the AI fails", async () => {
    const bad: TradeExplainer = { name: "bad", explain: async () => { throw new Error("401"); } };
    const e = await new FallbackExplainer(bad, new TemplateExplainer(), budget(true)).explain(input, 0);
    expect(e.source).toBe("TEMPLATE");
    expect(e.note).toMatch(/unavailable/);
  });
  it("skips paid calls once the daily budget is used", async () => {
    const paid: TradeExplainer = { name: "paid", explain: vi.fn() };
    const e = await new FallbackExplainer(paid, new TemplateExplainer(), budget(false)).explain(input, 0);
    expect(paid.explain).not.toHaveBeenCalled();
    expect(e.note).toMatch(/budget/);
  });
  it("records AI cost on success", async () => {
    const b = budget(true);
    const ok: TradeExplainer = { name: "ok", explain: async () => ({ source: "CLAUDE", summary: "s", whyNow: [], risks: [], invalidation: "", generatedAt: 0, costGBP: 0.002 }) };
    await new FallbackExplainer(ok, new TemplateExplainer(), b).explain(input, 0);
    expect(b.record).toHaveBeenCalledWith(0.002, 0);
  });
});
