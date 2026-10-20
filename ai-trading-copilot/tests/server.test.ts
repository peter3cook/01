import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/core/engine";
import { EodMarketData } from "../src/core/marketdata/eod";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import type { Bar, OrderRequest } from "../src/core/types";
import { LseClock, sessionsBehind } from "../src/core/util/marketHours";
import { buildApp } from "../src/server/app";
import { Trading212Broker, Trading212Client, verifyInstruments, type FetchLike } from "../src/server/brokers/trading212";
import { ConfigError, LIVE_ACK_PHRASE, loadConfig } from "../src/server/config";
import { AlphaVantageSource } from "../src/server/marketdata/alphaVantage";
import { auditNotifier } from "../src/server/notifier";

const TOKEN = "t".repeat(32);
const PAPER = { TRADING_MODE: "paper", APP_ACCESS_TOKEN: TOKEN, ALPHAVANTAGE_API_KEY: "av", T212_DEMO_API_KEY: "k", T212_DEMO_API_SECRET: "s" };
const LIVE = { TRADING_MODE: "live", APP_ACCESS_TOKEN: TOKEN, ALPHAVANTAGE_API_KEY: "av", T212_LIVE_API_KEY: "k", T212_LIVE_API_SECRET: "s", LIVE_TRADING_ACK: LIVE_ACK_PHRASE };

describe("config", () => {
  it("defaults to the simulated demo", () => {
    const c = loadConfig({});
    expect(c.tradingMode).toBe("simulated");
    expect(c.liveArmed).toBe(false);
    expect(c.t212).toBeUndefined();
    expect(c.claudeModel).toBe("claude-opus-5-5");
  });
  it("paper mode uses the practice account and needs keys, prices and a token", () => {
    expect(loadConfig(PAPER).t212).toMatchObject({ env: "demo" });
    expect(() => loadConfig({ ...PAPER, APP_ACCESS_TOKEN: "" })).toThrow(/APP_ACCESS_TOKEN/);
    expect(() => loadConfig({ ...PAPER, ALPHAVANTAGE_API_KEY: "" })).toThrow(/ALPHAVANTAGE/);
    expect(() => loadConfig({ ...PAPER, T212_DEMO_API_SECRET: "" })).toThrow(/T212_DEMO/);
  });
  it("live mode needs live keys and the exact acknowledgement", () => {
    const c = loadConfig(LIVE);
    expect(c.t212).toMatchObject({ env: "live" });
    expect(c.liveArmed).toBe(true);
    expect(() => loadConfig({ ...LIVE, LIVE_TRADING_ACK: "yes" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...LIVE, T212_LIVE_API_KEY: "" })).toThrow(/T212_LIVE/);
  });
  it("refuses live keys outside live mode and unknown modes", () => {
    expect(() => loadConfig({ T212_LIVE_API_KEY: "x" })).toThrow(/not live/);
    expect(() => loadConfig({ ...PAPER, T212_LIVE_API_SECRET: "x" })).toThrow(/not live/);
    expect(() => loadConfig({ TRADING_MODE: "yolo" })).toThrow(ConfigError);
  });
  it("requires a strong access token in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/APP_ACCESS_TOKEN/);
  });
});

// ---------------------------------------------------------------- Trading 212

type Call = { url: string; method: string; body?: unknown; auth?: string };
function fakeT212(routes: Record<string, (body?: unknown) => { status?: number; json?: unknown } | Error>) {
  const calls: Call[] = [];
  const f: FetchLike = async (url, init) => {
    const u = new URL(url);
    const key = `${init.method} ${u.pathname.replace("/api/v0", "")}`;
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization });
    const h = routes[key] ?? routes[key.replace(/\/\d+$/, "/{id}")];
    const r = h ? h(init.body ? JSON.parse(init.body) : undefined) : { status: 404, json: {} };
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.json, text: async () => JSON.stringify(r.json ?? "") };
  };
  return { f, calls };
}
const noSleep = async () => {};
const ISF = { ...ETF_UNIVERSE.find((i) => i.symbol === "ISF")!, priceUnit: "GBX" as const };
const VUSA = { ...ETF_UNIVERSE.find((i) => i.symbol === "VUSA")!, priceUnit: "GBP" as const };
const req = (o: Partial<OrderRequest>): OrderRequest => ({ clientOrderId: "c", symbol: "ISF", t212Ticker: "ISFl_EQ", side: "BUY", quantity: 1, type: "LIMIT", limitPrice: 8.5, timeValidity: "DAY", reason: "ENTRY", ...o });

describe("Trading 212 client", () => {
  it("uses the right host per environment with Basic auth", async () => {
    for (const env of ["demo", "live"] as const) {
      const { f, calls } = fakeT212({ "GET /equity/account/summary": () => ({ json: { currency: "GBP", totalValue: 50, cash: { availableToTrade: 50 } } }) });
      await new Trading212Client(env, "key", "secret", f, 1000, noSleep).accountSummary();
      expect(calls[0]!.url).toBe(`https://${env}.trading212.com/api/v0/equity/account/summary`);
      expect(calls[0]!.auth).toBe("Basic " + Buffer.from("key:secret").toString("base64"));
    }
  });
  it("paces requests to the published rate limits", async () => {
    const sleep = vi.fn(async () => {});
    const { f } = fakeT212({ "GET /equity/orders": () => ({ json: [] }) });
    const c = new Trading212Client("demo", "k", "s", f, 1000, sleep);
    await c.pendingOrders();
    await c.pendingOrders();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect((sleep.mock.calls[0] as unknown as [number])[0]).toBeGreaterThan(4000); // 1 req / 5s
  });
});

describe("Trading 212 broker", () => {
  const make = (routes: Parameters<typeof fakeT212>[0]) => {
    const t = fakeT212({ "GET /equity/orders": () => ({ json: [] }), ...routes });
    return { broker: new Trading212Broker(new Trading212Client("demo", "k", "s", t.f, 1000, noSleep), [ISF, VUSA]), calls: t.calls };
  };

  it("sends buys as limit orders in pence for GBX funds, rounding the limit down", async () => {
    const { broker, calls } = make({ "POST /equity/orders/limit": () => ({ json: { id: 42, status: "NEW" } }) });
    const r = await broker.placeOrder(req({ quantity: 1.2345, limitPrice: 8.51237 }), 0);
    expect(r).toMatchObject({ status: "ACCEPTED", brokerOrderId: "42" });
    expect(r.fill).toBeUndefined();
    expect(calls.at(-1)!.body).toEqual({ ticker: "ISFl_EQ", quantity: 1.2345, limitPrice: 851.23, timeValidity: "DAY" });
  });
  it("sends stops as negative-quantity sells, rounding the stop up", async () => {
    const { broker, calls } = make({ "POST /equity/orders/stop": () => ({ json: { id: 7, status: "NEW" } }) });
    await broker.placeOrder(req({ symbol: "VUSA", t212Ticker: "VUSAl_EQ", side: "SELL", type: "STOP", quantity: 0.1, stopPrice: 88.12301, limitPrice: undefined, timeValidity: "GOOD_TILL_CANCEL", reason: "STOP_LOSS" }), 0);
    expect(calls.at(-1)!.body).toEqual({ ticker: "VUSAl_EQ", quantity: -0.1, stopPrice: 88.13, timeValidity: "GOOD_TILL_CANCEL" });
  });
  it("refuses a buy when an order is already pending for the fund", async () => {
    const { broker } = make({ "GET /equity/orders": () => ({ json: [{ id: 1, ticker: "ISFl_EQ", status: "NEW" }] }) });
    expect((await broker.placeOrder(req({}), 0)).status).toBe("REJECTED");
  });
  it("refuses market buys and anything over the safety cap", async () => {
    const { broker } = make({});
    expect((await broker.placeOrder(req({ type: "MARKET", limitPrice: undefined }), 0)).status).toBe("REJECTED");
    expect((await broker.placeOrder(req({ quantity: 10, limitPrice: 8.5 }), 0)).reason).toMatch(/safety cap/);
  });
  it("refuses instruments that weren't verified", async () => {
    const { broker } = make({});
    expect((await broker.placeOrder(req({ symbol: "XXX", t212Ticker: "XXXl_EQ" }), 0)).status).toBe("REJECTED");
  });
  it("treats a 400 as rejected but a timeout as unknown (thrown)", async () => {
    const a = make({ "POST /equity/orders/limit": () => ({ status: 400, json: { message: "bad" } }) });
    expect((await a.broker.placeOrder(req({}), 0)).status).toBe("REJECTED");
    const b = make({ "POST /equity/orders/limit": () => new Error("aborted") });
    await expect(b.broker.placeOrder(req({}), 0)).rejects.toThrow();
  });
  it("reads fills from order history and converts pence to pounds", async () => {
    const { broker } = make({
      "GET /equity/orders/{id}": () => ({ status: 404, json: {} }),
      "GET /equity/history/orders": () => ({
        json: { items: [{ order: { id: 42, ticker: "ISFl_EQ", status: "FILLED", side: "BUY", filledQuantity: 1 }, fill: { price: 850, quantity: 1, filledAt: "2026-10-20T09:00:00Z", walletImpact: { taxes: [{ quantity: 0.02 }] } } }] },
      }),
    });
    const u = await broker.getOrderUpdate("42", req({}), 0);
    expect(u.state).toBe("FILLED");
    if (u.state === "FILLED") {
      expect(u.fill.price).toBe(8.5);
      expect(u.fill.fees.explicitTotal).toBe(0.02);
    }
  });
  it("reports pending orders as pending", async () => {
    const { broker } = make({ "GET /equity/orders/{id}": () => ({ json: { id: 42, ticker: "ISFl_EQ", status: "NEW" } }) });
    expect((await broker.getOrderUpdate("42", req({}), 0)).state).toBe("PENDING");
  });
  it("finds an order after a timeout by ticker, quantity and time", async () => {
    const { broker } = make({ "GET /equity/orders": () => ({ json: [{ id: 99, ticker: "ISFl_EQ", status: "NEW", quantity: 1, createdAt: new Date(1_000_000).toISOString() }] }) });
    expect(await broker.findOrder(req({}), 1_000_000)).toEqual({ brokerOrderId: "99" });
  });
  it("values positions from the broker's GBP figures and catches unit mistakes", async () => {
    const ok = make({ "GET /equity/positions": () => ({ json: [{ instrument: { ticker: "ISFl_EQ" }, quantity: 2, averagePricePaid: 840, currentPrice: 850, walletImpact: { currentValue: 17, totalCost: 16.8 } }] }) });
    const [p] = await ok.broker.getPositions();
    expect(p).toMatchObject({ symbol: "ISF", currentPriceGBP: 8.5, valueGBP: 17 });
    const bad = make({ "GET /equity/positions": () => ({ json: [{ instrument: { ticker: "VUSAl_EQ" }, quantity: 1, averagePricePaid: 9000, currentPrice: 9500, walletImpact: { currentValue: 95, totalCost: 90 } }] }) });
    await expect(bad.broker.getPositions()).rejects.toThrow(/unit mismatch/);
  });
  it("only accepts GBP accounts", async () => {
    const { broker } = make({ "GET /equity/account/summary": () => ({ json: { currency: "EUR", totalValue: 1, cash: { availableToTrade: 1 } } }) });
    await expect(broker.getAccount()).rejects.toThrow(/GBP/);
  });
});

describe("instrument verification", () => {
  it("keeps GBP/GBX ETFs, corrects tickers and drops the rest", () => {
    const { verified, report } = verifyInstruments(ETF_UNIVERSE.slice(0, 3), [
      { ticker: "VUSAl_EQ", name: "S&P", shortName: "VUSA", type: "ETF", currencyCode: "GBP" },
      { ticker: "VWRPl_EQ", name: "AW", shortName: "VWRP", type: "ETF", currencyCode: "USD" },
      { ticker: "ISF_new_l_EQ", name: "FTSE", shortName: "ISF", type: "ETF", currencyCode: "GBX" },
    ]);
    expect(verified.map((v) => [v.symbol, v.t212Ticker, v.priceUnit])).toEqual([
      ["VUSA", "VUSAl_EQ", "GBP"],
      ["ISF", "ISF_new_l_EQ", "GBX"],
    ]);
    expect(report.join()).toMatch(/VWRP.*USD/);
  });
});

// ---------------------------------------------------------------- prices & hours

const day = (d: string, c: number): Bar => ({ t: Date.parse(`${d}T16:30:00Z`), o: c, h: c, l: c, c, v: 1 });

describe("end-of-day prices", () => {
  it("counts missing sessions, skipping weekends and bank holidays", () => {
    // Tue 20 Oct 2026, 09:00 London: Monday's close is the latest expected.
    const now = Date.parse("2026-10-20T08:00:00Z");
    expect(sessionsBehind("2026-10-19", now)).toBe(0);
    expect(sessionsBehind("2026-10-16", now)).toBe(1); // Friday
    expect(sessionsBehind("2026-10-14", now)).toBe(3);
    // Tue after Easter Monday 2026 (6 Apr): Thursday 2 Apr is only one session behind.
    expect(sessionsBehind("2026-04-02", Date.parse("2026-04-07T08:00:00Z"))).toBe(0);
  });
  it("quotes only fresh, plausible prices", () => {
    const md = new EodMarketData([VUSA, ISF], "test");
    const now = Date.parse("2026-10-20T08:00:00Z");
    md.setBars("VUSA", [day("2026-10-16", 94), day("2026-10-19", 95)], now);
    md.setBars("ISF", [day("2026-10-19", 850)], now); // pence by mistake
    expect(md.quote("VUSA", now)).toMatchObject({ mid: 95, source: "END_OF_DAY" });
    expect(md.quote("ISF", now)).toBeUndefined();
    expect(md.problem("ISF", now)).toMatch(/expected range/);
    expect(md.quote("VUSA", Date.parse("2026-10-23T08:00:00Z"))).toBeUndefined(); // 3 sessions old
  });
  it("blocks a fund when the broker's price disagrees", () => {
    const md = new EodMarketData([VUSA], "test");
    const now = Date.parse("2026-10-20T08:00:00Z");
    md.setBars("VUSA", [day("2026-10-19", 95)], now);
    md.setMark("VUSA", 120, now);
    expect(md.quote("VUSA", now)).toBeUndefined();
  });
  it("Alpha Vantage: parses daily bars and converts pence", async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ "Time Series (Daily)": { "2026-10-19": { "1. open": "850", "2. high": "860", "3. low": "845", "4. close": "855", "5. volume": "1000" } } }) }));
    const bars = await new AlphaVantageSource("key", f).fetchDaily(ISF);
    expect(bars[0]!.c).toBe(8.55);
    expect(String((f.mock.calls[0] as unknown as [string])[0])).toContain("symbol=ISF.LON");
  });
  it("Alpha Vantage: surfaces rate-limit notes as errors", async () => {
    const f = async () => ({ ok: true, status: 200, json: async () => ({ Note: "Thank you for using Alpha Vantage! rate limit" }) });
    await expect(new AlphaVantageSource("key", f).fetchDaily(VUSA)).rejects.toThrow(/rate limit/);
  });
  it("LSE clock: entries only 08:15–16:00 UK time on trading days", () => {
    const c = new LseClock();
    expect(c.entriesAllowed(Date.parse("2026-10-20T08:30:00Z"))).toBe(true); // 09:30 BST
    expect(c.entriesAllowed(Date.parse("2026-10-20T07:10:00Z"))).toBe(false); // 08:10 BST
    expect(c.entriesAllowed(Date.parse("2026-10-24T10:00:00Z"))).toBe(false); // Saturday
    expect(c.entriesAllowed(Date.parse("2026-12-25T10:00:00Z"))).toBe(false); // Christmas
    expect(c.isOpen(Date.parse("2026-12-01T16:20:00Z"))).toBe(true); // 16:20 GMT
  });
});

describe("notifications", () => {
  it("sends important events once and throttles repeats", async () => {
    const send = vi.fn(async () => {});
    const n = auditNotifier({ name: "x", send }, "", () => {});
    const e = { seq: 1, at: 0, actor: "broker" as const, type: "STOP_NOT_PLACED", message: "VUSA stop", prevHash: "", hash: "" };
    n(e);
    n({ ...e, seq: 2, at: 1000 });
    n({ ...e, seq: 3, type: "TICK", message: "noise" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("STOP-LOSS NOT SET", "VUSA stop", true);
  });
});

// ---------------------------------------------------------------- HTTP API

describe("HTTP API", () => {
  const cfg = (env: Record<string, string> = {}) => loadConfig({ DATA_DIR: "/nonexistent-not-used", ...env });

  it("requires the bearer token when one is configured", async () => {
    const { app } = await buildApp(cfg({ APP_ACCESS_TOKEN: TOKEN }), { store: new MemoryStore(), webDir: "/nope" });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/api/state", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().liveTradingEnabled).toBe(false);
    expect(ok.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(JSON.stringify(ok.json())).not.toContain(TOKEN);
    await app.close();
  });

  it("validates inputs and needs typed confirmations", async () => {
    const { app } = await buildApp(cfg(), { store: new MemoryStore(), webDir: "/nope" });
    expect((await app.inject({ method: "POST", url: "/api/proposals/nope/approve" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/limits", payload: { maxRiskPerTradeGBP: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/emergency-stop", payload: { active: true } })).json().active).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/emergency-stop", payload: { active: false, confirm: "no" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auto-trade", payload: { enabled: true, confirm: "no" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/auto-trade", payload: { enabled: true, confirm: "AUTO" } })).json().enabled).toBe(true);
    await app.close();
  });

  it("starts in practice mode against Trading 212 and never needs real keys in tests", async () => {
    const t = fakeT212({
      "GET /equity/account/summary": () => ({ json: { currency: "GBP", totalValue: 50, cash: { availableToTrade: 50 }, investments: { currentValue: 0 } } }),
      "GET /equity/positions": () => ({ json: [] }),
      "GET /equity/orders": () => ({ json: [] }),
    });
    const { app, engine } = await buildApp(loadConfig({ ...PAPER, DATA_DIR: "/nonexistent-not-used" }), {
      store: new MemoryStore(),
      webDir: "/nope",
      t212Fetch: t.f,
      t212Instruments: [{ ticker: "VUSAl_EQ", name: "S&P", shortName: "VUSA", type: "ETF", currencyCode: "GBP" }],
      priceSource: { name: "fake", fetchDaily: async () => [] },
      log: () => {},
    });
    await engine.syncBroker();
    const s = (await app.inject({ method: "GET", url: "/api/state", headers: { authorization: `Bearer ${TOKEN}` } })).json();
    expect(s.mode).toBe("paper");
    expect(s.broker.environment).toBe("T212_DEMO");
    expect(s.account.source).toBe("broker");
    expect(t.calls.every((c) => c.url.startsWith("https://demo.trading212.com/"))).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/sim/outage", headers: { authorization: `Bearer ${TOKEN}` } })).statusCode).toBe(404);
    await app.close();
  });
});
