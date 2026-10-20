import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../src/core/engine";
import { buildApp } from "../src/server/app";
import { Trading212DemoBroker, Trading212DemoClient, T212_DEMO_BASE_URL, type FetchLike } from "../src/server/brokers/trading212Demo";
import { ConfigError, loadConfig } from "../src/server/config";

describe("config guardrails", () => {
  it("defaults to demo mode with the simulated broker", () => {
    const c = loadConfig({});
    expect(c.tradingMode).toBe("demo");
    expect(c.broker).toBe("simulated");
    expect(c.claudeModel).toBe("claude-opus-5-5");
  });
  it("refuses live mode and any live credentials", () => {
    expect(() => loadConfig({ TRADING_MODE: "live" })).toThrow(ConfigError);
    expect(() => loadConfig({ T212_LIVE_API_KEY: "x" })).toThrow(/Live/);
    expect(() => loadConfig({ LIVE_TRADING: "true" })).toThrow(ConfigError);
  });
  it("refuses to send broker orders based on simulated prices", () => {
    expect(() => loadConfig({ BROKER: "t212-demo" })).toThrow(/market-data/);
  });
  it("requires a strong access token in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/APP_ACCESS_TOKEN/);
    expect(loadConfig({ NODE_ENV: "production", APP_ACCESS_TOKEN: "x".repeat(32) }).production).toBe(true);
  });
});

function fakeFetch(responses: Record<string, unknown>) {
  const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
  const f: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const key = `${init.method} ${new URL(url).pathname}`;
    const body = responses[key] ?? {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { f, calls };
}

describe("Trading 212 demo client", () => {
  it("only ever calls the demo host with Basic auth", async () => {
    expect(T212_DEMO_BASE_URL).toBe("https://demo.trading212.com/api/v0");
    const { f, calls } = fakeFetch({ "GET /api/v0/equity/account/summary": { id: 1, currency: "GBP", totalValue: 50, cash: {} } });
    const c = new Trading212DemoClient("key", "secret", f);
    await c.accountSummary();
    expect(calls[0]!.url).toBe("https://demo.trading212.com/api/v0/equity/account/summary");
    expect(calls[0]!.init.headers.Authorization).toBe("Basic " + Buffer.from("key:secret").toString("base64"));
  });
  it("sends sells as negative quantities and returns ACCEPTED, not FILLED", async () => {
    const { f, calls } = fakeFetch({ "GET /api/v0/equity/orders": [], "POST /api/v0/equity/orders/limit": { id: 42, status: "NEW" } });
    const broker = new Trading212DemoBroker(new Trading212DemoClient("k", "s", f));
    const r = await broker.placeOrder({ clientOrderId: "c", symbol: "VUSA", t212Ticker: "VUSAl_EQ", side: "SELL", quantity: 0.5, type: "LIMIT", limitPrice: 90, reason: "MANUAL_CLOSE" }, 0);
    expect(r.status).toBe("ACCEPTED");
    expect(r.fill).toBeUndefined();
    const body = JSON.parse(calls.find((c) => c.init.method === "POST")!.init.body!);
    expect(body.quantity).toBe(-0.5);
    expect(body.ticker).toBe("VUSAl_EQ");
  });
  it("refuses when a pending order already exists for the ticker", async () => {
    const { f } = fakeFetch({ "GET /api/v0/equity/orders": [{ id: 1, ticker: "VUSAl_EQ", quantity: 1, status: "NEW" }] });
    const broker = new Trading212DemoBroker(new Trading212DemoClient("k", "s", f));
    const r = await broker.placeOrder({ clientOrderId: "c", symbol: "VUSA", t212Ticker: "VUSAl_EQ", side: "BUY", quantity: 0.5, type: "LIMIT", limitPrice: 90, reason: "ENTRY" }, 0);
    expect(r.status).toBe("REJECTED");
  });
  it("requires credentials", () => {
    expect(() => new Trading212DemoClient("", "", vi.fn())).toThrow();
  });
});

describe("HTTP API", () => {
  const cfg = (env: Record<string, string> = {}) => loadConfig({ DATA_DIR: "/nonexistent-not-used", ...env });

  it("requires the bearer token when one is configured", async () => {
    const { app } = await buildApp(cfg({ APP_ACCESS_TOKEN: "t".repeat(32) }), { store: new MemoryStore(), webDir: "/nope" });
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/state" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/api/state", headers: { authorization: `Bearer ${"t".repeat(32)}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().liveTradingEnabled).toBe(false);
    expect(ok.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(JSON.stringify(ok.json())).not.toContain("t".repeat(32));
    await app.close();
  });

  it("returns 404 for unknown proposals and 400 for loosening limits", async () => {
    const { app } = await buildApp(cfg(), { store: new MemoryStore(), webDir: "/nope" });
    expect((await app.inject({ method: "POST", url: "/api/proposals/nope/approve" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/api/limits", payload: { maxRiskPerTradeGBP: 5 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/emergency-stop", payload: { active: true } })).json().active).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/emergency-stop", payload: { active: false, confirm: "no" } })).statusCode).toBe(400);
    await app.close();
  });
});
