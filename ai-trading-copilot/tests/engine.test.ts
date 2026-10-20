import { describe, expect, it } from "vitest";
import { CopilotEngine, EngineError, RESUME_PHRASE } from "../src/core/engine";
import type { BrokerAdapter } from "../src/core/execution/broker";
import { verifyAudit } from "../src/core/audit/auditLog";
import { setup } from "./helpers";

async function withProposal(opts: Parameters<typeof setup>[0] = {}) {
  const h = setup(opts);
  await h.engine.tick();
  const p = h.engine.snapshot().pending[0];
  if (!p) throw new Error("expected a proposal");
  return { ...h, p };
}

describe("engine: proposals", () => {
  it("starts with £50 simulated capital and no fabricated history", () => {
    const { engine } = setup();
    const s = engine.snapshot();
    expect(s.account.equity).toBe(50);
    expect(s.trades).toHaveLength(0);
    expect(s.equityHistory[0]!.equity).toBe(50);
    expect(s.mode).toBe("demo");
    expect(s.liveTradingEnabled).toBe(false);
    expect(s.dataHealth.source).toBe("SIMULATED");
  });

  it("creates a pending proposal for a signal but never places an order on its own", async () => {
    const { engine, p } = await withProposal();
    expect(p.symbol).toBe("VUSA");
    expect(p.status).toBe("PENDING");
    expect(p.riskGBP).toBeLessThanOrEqual(0.5);
    expect(p.explanation.source).toBe("TEMPLATE");
    expect(p.dataSource).toBe("SIMULATED");
    expect(engine.state.orders).toHaveLength(0);
    expect(engine.state.positions).toHaveLength(0);
    // Further ticks don't execute or duplicate it.
    await engine.tick();
    await engine.scan();
    expect(engine.state.orders).toHaveLength(0);
    expect(engine.snapshot().pending).toHaveLength(1);
  });

  it("does not propose while the emergency stop is on or data is stale", async () => {
    const a = setup();
    a.engine.setEmergencyStop(true);
    await a.engine.tick();
    expect(a.engine.snapshot().pending).toHaveLength(0);

    const b = setup();
    b.md.healthy = false;
    b.advance(120_000);
    await b.engine.tick();
    expect(b.engine.snapshot().pending).toHaveLength(0);
    expect(b.engine.snapshot().halted.active).toBe(true);
  });
});

describe("engine: approvals", () => {
  it("executes exactly once on approval and opens a position with stop and target", async () => {
    const { engine, p } = await withProposal();
    const done = await engine.approve(p.id);
    expect(done.status).toBe("EXECUTED");
    expect(engine.state.positions).toHaveLength(1);
    const pos = engine.state.positions[0]!;
    expect(pos.stopPrice).toBe(p.stopPrice);
    expect(pos.targetPrice).toBe(p.targetPrice);
    expect(engine.state.cash).toBeLessThan(50);
    expect(engine.state.trades[0]!.simulated).toBe(true);

    // Second approval of the same proposal: no second order.
    await engine.approve(p.id);
    expect(engine.state.orders).toHaveLength(1);
    expect(engine.state.trades).toHaveLength(1);
  });

  it("concurrent double-taps produce one order", async () => {
    const { engine, p } = await withProposal();
    const results = await Promise.allSettled([engine.approve(p.id), engine.approve(p.id), engine.approve(p.id)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    expect(engine.state.orders).toHaveLength(1);
    expect(engine.state.positions).toHaveLength(1);
  });

  it("rejects approval after expiry and marks it expired", async () => {
    const { engine, p, advance } = await withProposal();
    advance(engine.state.limits.proposalTtlMs + 1);
    await expect(engine.approve(p.id)).rejects.toMatchObject({ code: "EXPIRED" });
    expect(engine.state.proposals[0]!.status).toBe("EXPIRED");
    expect(engine.state.orders).toHaveLength(0);
  });

  it("expires untouched proposals on tick", async () => {
    const { engine, advance } = await withProposal();
    advance(engine.state.limits.proposalTtlMs + 1);
    await engine.tick();
    expect(engine.state.proposals.some((x) => x.status === "EXPIRED")).toBe(true);
  });

  it("reject leaves no order and cannot then be approved", async () => {
    const { engine, p } = await withProposal();
    engine.reject(p.id);
    await expect(engine.approve(p.id)).rejects.toBeInstanceOf(EngineError);
    expect(engine.state.orders).toHaveLength(0);
  });

  it("re-validates risk at approval time: stale data blocks the order", async () => {
    const { engine, p, md, advance } = await withProposal();
    md.healthy = false;
    advance(90_000);
    const r = await engine.approve(p.id);
    expect(r.status).toBe("BLOCKED");
    expect(r.statusReason).toMatch(/data/i);
    expect(engine.state.orders).toHaveLength(0);
  });

  it("re-validates risk at approval time: large price move blocks the order", async () => {
    const { engine, p, md } = await withProposal();
    md.override.set("VUSA", p.entryPrice * 1.01);
    const r = await engine.approve(p.id);
    expect(r.status).toBe("BLOCKED");
    expect(engine.state.orders).toHaveLength(0);
  });

  it("emergency stop cancels pending approvals and needs RESUME to release", async () => {
    const { engine, p } = await withProposal();
    engine.setEmergencyStop(true, { reason: "test" });
    expect(engine.state.proposals.find((x) => x.id === p.id)!.status).toBe("CANCELLED");
    await expect(engine.approve(p.id)).rejects.toBeInstanceOf(EngineError);
    expect(() => engine.setEmergencyStop(false, { confirm: "yes" })).toThrow();
    engine.setEmergencyStop(false, { confirm: RESUME_PHRASE });
    expect(engine.state.emergencyStop.active).toBe(false);
  });

  it("records broker errors as errors, never as fills", async () => {
    const h = setup();
    const failing: BrokerAdapter = { name: "boom", environment: "SIMULATED", placeOrder: async () => { throw new Error("network down"); } };
    const engine = new CopilotEngine({ md: h.md, broker: failing, fees: h.fees, tradingMode: "demo", clock: h.now });
    await engine.tick();
    const p = engine.snapshot().pending[0]!;
    const r = await engine.approve(p.id);
    expect(r.status).toBe("BLOCKED");
    expect(engine.state.orders[0]!.status).toBe("ERROR");
    expect(engine.state.positions).toHaveLength(0);
    expect(engine.state.cash).toBe(50);
  });

  it("a broker that only ACCEPTS does not change holdings", async () => {
    const h = setup();
    const accepting: BrokerAdapter = { name: "acc", environment: "T212_DEMO", placeOrder: async () => ({ status: "ACCEPTED", brokerOrderId: "1", simulated: false }) };
    const engine = new CopilotEngine({ md: h.md, broker: accepting, fees: h.fees, tradingMode: "demo", clock: h.now });
    await engine.tick();
    const r = await engine.approve(engine.snapshot().pending[0]!.id);
    expect(r.status).toBe("SUBMITTED");
    expect(engine.state.positions).toHaveLength(0);
    expect(engine.state.cash).toBe(50);
  });

  it("a non-demo trading mode can never execute", async () => {
    const { engine } = setup({ tradingMode: "live" });
    await engine.tick();
    expect(engine.snapshot().pending).toHaveLength(0);
    expect(engine.snapshot().halted.reasons.join(" ")).toMatch(/demo/i);
  });
});

describe("engine: exits, P&L and safety", () => {
  it("closes at the stop-loss and books realised P&L", async () => {
    const { engine, p, md } = await withProposal();
    await engine.approve(p.id);
    md.override.set("VUSA", p.stopPrice * 0.999);
    await engine.tick();
    expect(engine.state.positions).toHaveLength(0);
    const exit = engine.state.trades.at(-1)!;
    expect(exit.reason).toBe("STOP_LOSS");
    expect(exit.realisedPnl!).toBeLessThan(0);
    expect(Math.abs(exit.realisedPnl!)).toBeLessThanOrEqual(0.5 + 0.01);
    const s = engine.snapshot();
    expect(s.account.realisedPnl).toBe(exit.realisedPnl);
    expect(s.account.equity).toBeCloseTo(50 + exit.realisedPnl!, 4);
    expect(s.costs.spreadCost).toBeGreaterThan(0);
  });

  it("takes profit at the target", async () => {
    const { engine, p, md } = await withProposal();
    await engine.approve(p.id);
    md.override.set("VUSA", p.targetPrice * 1.001);
    await engine.tick();
    expect(engine.state.trades.at(-1)!.reason).toBe("TAKE_PROFIT");
    expect(engine.state.trades.at(-1)!.realisedPnl!).toBeGreaterThan(0);
  });

  it("shows unrealised P&L at the bid for open positions", async () => {
    const { engine, p } = await withProposal();
    await engine.approve(p.id);
    const pos = engine.snapshot().positions[0]!;
    expect(pos.unrealisedPnl).toBeLessThan(0); // just paid the spread
    expect(pos.markPrice).toBeLessThan(p.entryPrice);
  });

  it("does not check exits on stale data", async () => {
    const { engine, p, md, advance } = await withProposal();
    await engine.approve(p.id);
    md.healthy = false;
    md.override.set("VUSA", p.stopPrice * 0.5);
    advance(120_000);
    await engine.tick();
    expect(engine.state.positions).toHaveLength(1);
    expect(engine.state.audit.some((e) => e.type === "EXIT_CHECK_SKIPPED")).toBe(true);
  });

  it("engages the emergency stop automatically at the equity floor", async () => {
    const { engine, p, md } = await withProposal();
    engine.updateLimits({ equityFloorGBP: 49.999 });
    await engine.approve(p.id);
    md.override.set("VUSA", p.entryPrice * 0.9995); // small loss, above stop
    await engine.tick();
    expect(engine.state.emergencyStop.active).toBe(true);
  });

  it("risk per trade does not grow as the account grows", async () => {
    const { engine } = setup();
    engine.state.cash = 900; // pretend the account grew
    await engine.tick();
    const p = engine.snapshot().pending[0]!;
    expect(engine.state.limits.maxRiskPerTradeGBP).toBe(0.5);
    expect(p.notionalGBP).toBeLessThanOrEqual(12.5);
    expect(p.riskGBP).toBeLessThanOrEqual(0.5);
  });

  it("only allows tightening limits and keeps an intact audit chain", () => {
    const { engine } = setup();
    expect(() => engine.updateLimits({ maxRiskPerTradeGBP: 1 })).toThrow();
    engine.updateLimits({ maxRiskPerTradeGBP: 0.3 });
    expect(engine.state.limits.maxRiskPerTradeGBP).toBe(0.3);
    expect(verifyAudit(engine.state.audit).ok).toBe(true);
  });

  it("persists state and reloads it", async () => {
    const h = await withProposal();
    await h.engine.approve(h.p.id);
    const again = new CopilotEngine({ md: h.md, broker: h.broker, fees: h.fees, tradingMode: "demo", clock: h.now, store: h.store });
    expect(again.state.positions).toHaveLength(1);
    expect(again.state.orders).toHaveLength(1);
  });
});
