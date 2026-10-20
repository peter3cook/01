import { describe, expect, it } from "vitest";
import { AUTO_PHRASE, CopilotEngine, MemoryStore } from "../src/core/engine";
import { Trading212FeeModel } from "../src/core/fees/feeModel";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import type { MarketClock } from "../src/core/util/marketHours";
import { FakeAsyncBroker, FakeMarket, T0 } from "./helpers";

function setupAsync(over: Partial<ConstructorParameters<typeof CopilotEngine>[0]> = {}) {
  let now = T0;
  const md = new FakeMarket(ETF_UNIVERSE.filter((i) => ["VUSA", "ISF"].includes(i.symbol)), now);
  const broker = new FakeAsyncBroker();
  const engine = new CopilotEngine({
    md,
    broker,
    fees: new Trading212FeeModel(),
    tradingMode: "paper",
    clock: () => now,
    store: new MemoryStore(),
    entryOrder: { type: "LIMIT", limitBufferBps: 50 },
    brokerSyncMs: 0,
    ...over,
  });
  const advance = (ms: number) => {
    now += ms;
    md.asOf = now;
  };
  return { engine, broker, md, advance, now: () => now };
}

async function proposal(h: ReturnType<typeof setupAsync>) {
  await h.engine.tick();
  const p = h.engine.snapshot().pending[0];
  if (!p) throw new Error("no proposal");
  return p;
}

/** Approve, fill the buy and let the engine place its stop. */
async function holding(h: ReturnType<typeof setupAsync>) {
  const p = await proposal(h);
  await h.engine.approve(p.id);
  h.broker.fill(h.broker.lastId(), p.entryPrice, p.quantity, h.now());
  h.advance(20_000);
  await h.engine.syncBroker();
  return p;
}

const held = (p: { quantity: number; entryPrice: number }, price: number) => [
  { symbol: "VUSA", t212Ticker: "VUSAl_EQ", quantity: p.quantity, avgPriceGBP: p.entryPrice, currentPriceGBP: price, valueGBP: price * p.quantity, costGBP: p.entryPrice * p.quantity },
];

describe("broker flow (Trading 212 style)", () => {
  it("doesn't trade before the first account sync", async () => {
    const h = setupAsync({ brokerSyncMs: 10 ** 12 });
    await h.engine.scan();
    expect(h.engine.snapshot().pending).toHaveLength(0);
    expect(h.engine.snapshot().halted.reasons.join()).toMatch(/sync/);
  });

  it("buys with a LIMIT order, holds nothing until the fill, then places a stop-loss at the broker", async () => {
    const h = setupAsync();
    const p = await proposal(h);
    expect(p.entryPrice).toBeGreaterThan(h.md.quote("VUSA")!.ask); // limit = price + buffer
    const r = await h.engine.approve(p.id);
    expect(r.status).toBe("SUBMITTED");
    expect(h.broker.placed[0]).toMatchObject({ side: "BUY", type: "LIMIT", limitPrice: p.entryPrice, timeValidity: "DAY" });
    expect(h.engine.state.positions).toHaveLength(0);

    h.broker.fill(h.broker.lastId(), p.entryPrice - 0.1, p.quantity, h.now());
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(1);
    expect(h.engine.state.proposals[0]!.status).toBe("EXECUTED");
    expect(h.broker.placed[1]).toMatchObject({ side: "SELL", type: "STOP", stopPrice: p.stopPrice, quantity: p.quantity, timeValidity: "GOOD_TILL_CANCEL" });
    expect(h.engine.state.positions[0]!.stopOrderId).toBe(h.broker.lastId());
  });

  it("records the exit when the broker's stop-loss fills", async () => {
    const h = setupAsync();
    const p = await holding(h);
    const stopId = h.engine.state.positions[0]!.stopOrderId!;
    h.broker.fill(stopId, p.stopPrice - 0.05, p.quantity, h.now());
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(0);
    const exit = h.engine.state.trades.at(-1)!;
    expect(exit.reason).toBe("STOP_LOSS");
    expect(exit.realisedPnl!).toBeLessThan(0);
  });

  it("cancels the proposal if the limit order expires unfilled", async () => {
    const h = setupAsync();
    const p = await proposal(h);
    await h.engine.approve(p.id);
    h.broker.updates.set(h.broker.lastId(), { state: "CLOSED", brokerStatus: "CANCELLED", reason: "expired" });
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(0);
    expect(h.engine.state.proposals[0]!.status).toBe("CANCELLED");
  });

  it("after a timeout it looks the order up instead of sending it again", async () => {
    const h = setupAsync();
    const p = await proposal(h);
    h.broker.failNextPlace = true;
    const r = await h.engine.approve(p.id);
    expect(r.status).toBe("SUBMITTED");
    expect(h.engine.state.orders[0]!.status).toBe("ERROR");
    // Approving again or rescanning must not place a second buy.
    await h.engine.approve(p.id);
    h.advance(31_000);
    await h.engine.scan();
    expect(h.broker.placed).toHaveLength(0);
    h.broker.found = "777";
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.orders[0]).toMatchObject({ status: "ACCEPTED", brokerOrderId: "777" });
    expect(h.broker.placed).toHaveLength(0);
  });

  it("gives up on a lost order only after checking for two minutes", async () => {
    const h = setupAsync();
    const p = await proposal(h);
    h.broker.failNextPlace = true;
    await h.engine.approve(p.id);
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.orders[0]!.status).toBe("ERROR");
    h.advance(130_000);
    await h.engine.syncBroker();
    expect(h.engine.state.orders[0]!.status).toBe("REJECTED");
    expect(h.engine.state.proposals[0]!.status).toBe("CANCELLED");
  });

  it("take-profit cancels the stop first, then sells", async () => {
    const h = setupAsync();
    const p = await holding(h);
    const stopId = h.engine.state.positions[0]!.stopOrderId!;
    h.broker.positions = held(p, p.targetPrice + 0.2);
    h.advance(20_000);
    await h.engine.tick();
    expect(h.broker.cancelled).toContain(stopId);
    expect(h.broker.placed.at(-1)).toMatchObject({ side: "SELL", type: "MARKET", reason: "TAKE_PROFIT" });
    h.broker.fill(h.broker.lastId(), p.targetPrice + 0.2, p.quantity, h.now());
    h.broker.positions = [];
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(0);
    expect(h.engine.state.trades.at(-1)!.reason).toBe("TAKE_PROFIT");
  });

  it("re-places a missing stop-loss", async () => {
    const h = setupAsync();
    const p = await holding(h);
    const first = h.engine.state.positions[0]!.stopOrderId!;
    h.broker.positions = held(p, p.entryPrice);
    h.broker.updates.set(first, { state: "CLOSED", brokerStatus: "CANCELLED", reason: "cancelled in app" });
    h.advance(20_000);
    await h.engine.syncBroker();
    const second = h.engine.state.positions[0]!.stopOrderId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });

  it("records a sale made in the Trading 212 app", async () => {
    const h = setupAsync();
    const p = await holding(h);
    h.broker.positions = [];
    h.broker.sellFills = [{ brokerOrderId: "9001", type: "MARKET", price: p.entryPrice + 0.3, quantity: p.quantity, at: h.now(), feesGBP: 0 }];
    // Our stop is still pending at the broker, so the first sync re-checks it.
    h.broker.updates.set(h.engine.state.positions[0]!.stopOrderId!, { state: "CLOSED", brokerStatus: "CANCELLED", reason: "cancelled" });
    h.advance(20_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(1); // one missing sync isn't enough
    h.advance(70_000);
    await h.engine.syncBroker();
    expect(h.engine.state.positions).toHaveLength(0);
    expect(h.engine.state.trades.at(-1)!.reason).toBe("EXTERNAL");
  });

  it("adopts holdings bought outside the app without managing them", async () => {
    const h = setupAsync();
    h.broker.positions = [{ symbol: "VUSA", t212Ticker: "VUSAl_EQ", quantity: 1, avgPriceGBP: 90, currentPriceGBP: 91, valueGBP: 91, costGBP: 90 }];
    await h.engine.tick();
    expect(h.engine.state.positions[0]!.external).toBe(true);
    expect(h.broker.placed.filter((o) => o.side === "BUY")).toHaveLength(0);
    expect(h.broker.placed.filter((o) => o.type === "STOP")).toHaveLength(0);
    await expect(h.engine.closePosition("VUSA")).rejects.toThrow(/outside the app/);
  });

  it("uses the broker's cash and value", async () => {
    const h = setupAsync();
    h.broker.account = { cashGBP: 42, totalValueGBP: 60, investedGBP: 18, currency: "GBP" };
    await h.engine.tick();
    const s = h.engine.snapshot();
    expect(s.account.source).toBe("broker");
    expect(s.account.cash).toBe(42);
    expect(s.account.equity).toBe(60);
    expect(s.account.startingCapital).toBe(60);
  });

  it("never invests more than the capital cap even if the account holds more", async () => {
    const h = setupAsync();
    h.broker.account = { cashGBP: 500, totalValueGBP: 500, investedGBP: 0, currency: "GBP" };
    h.engine.updateLimits({ maxCapitalGBP: 5 });
    const p = await proposal(h);
    expect(p.notionalGBP).toBeLessThanOrEqual(5);
  });

  it("doesn't open trades when the market is closed", async () => {
    const closed: MarketClock = { isOpen: () => false, entriesAllowed: () => false, describe: () => "LSE closed" };
    const h = setupAsync({ market: closed });
    await h.engine.tick();
    expect(h.engine.snapshot().pending).toHaveLength(0);
    expect(h.engine.snapshot().scanner.find((r) => r.instrument.symbol === "VUSA")!.blockedReason).toBe("LSE closed");
  });

  it("live mode never trades unless armed", async () => {
    const off = setupAsync({ tradingMode: "live", liveArmed: false });
    await off.engine.tick();
    expect(off.engine.snapshot().pending).toHaveLength(0);
    const on = setupAsync({ tradingMode: "live", liveArmed: true });
    await on.engine.tick();
    expect(on.engine.snapshot().pending).toHaveLength(1);
    expect(on.engine.snapshot().liveTradingEnabled).toBe(true);
  });
});

describe("auto mode", () => {
  it("needs the typed phrase to turn on", () => {
    const h = setupAsync();
    expect(() => h.engine.setAutoTrade(true, "yes")).toThrow();
    h.engine.setAutoTrade(true, AUTO_PHRASE);
    expect(h.engine.state.autoTrade!.enabled).toBe(true);
    h.engine.setAutoTrade(false);
    expect(h.engine.state.autoTrade!.enabled).toBe(false);
  });

  it("places the order without waiting for approval, through the same risk checks", async () => {
    const h = setupAsync();
    h.engine.setAutoTrade(true, AUTO_PHRASE);
    await h.engine.tick();
    expect(h.broker.placed).toHaveLength(1);
    expect(h.engine.state.proposals[0]!.status).toBe("SUBMITTED");
    expect(h.engine.state.audit.some((e) => e.type === "PROPOSAL_APPROVED" && e.data?.by === "auto")).toBe(true);
  });

  it("still respects the emergency stop and the daily trade limit", async () => {
    const a = setupAsync();
    a.engine.setAutoTrade(true, AUTO_PHRASE);
    a.engine.setEmergencyStop(true);
    await a.engine.tick();
    expect(a.broker.placed).toHaveLength(0);

    const b = setupAsync();
    b.engine.setAutoTrade(true, AUTO_PHRASE);
    b.engine.updateLimits({ maxTradesPerDay: 0 });
    await b.engine.tick();
    expect(b.broker.placed).toHaveLength(0);
  });

  it("emergency stop cancels pending buys at the broker", async () => {
    const h = setupAsync();
    h.engine.setAutoTrade(true, AUTO_PHRASE);
    await h.engine.tick();
    const id = h.broker.lastId();
    h.engine.setEmergencyStop(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.broker.cancelled).toContain(id);
  });
});
