import type { BrokerAdapter } from "../../core/execution/broker";
import type { BrokerOrderResult, OrderRequest } from "../../core/types";

/**
 * Trading 212 Public API (v0) client – PAPER TRADING (DEMO) ENVIRONMENT ONLY.
 * Docs: https://docs.trading212.com/api
 *
 * Safety properties:
 *  - The base URL is a constant for the demo host. There is no way to pass a
 *    different host, and every request re-checks the host before sending.
 *  - Credentials are read on the server from env vars and sent as HTTP Basic
 *    auth. They are never logged, returned by the API or bundled into the web app.
 *  - Orders are reported as ACCEPTED (not FILLED) – holdings change only after a
 *    fill is confirmed by the broker (fill reconciliation is Phase 2).
 */
export const T212_DEMO_BASE_URL = "https://demo.trading212.com/api/v0";
const DEMO_HOST = "demo.trading212.com";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class Trading212Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class Trading212DemoClient {
  private readonly auth: string;
  /** Simple client-side guard: the limit-order endpoint allows 1 request / 2s. */
  private lastOrderAt = 0;

  constructor(apiKey: string, apiSecret: string, private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {
    if (!apiKey || !apiSecret) throw new Error("Trading 212 demo API key and secret are required");
    this.auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/equity/")) throw new Error("Unexpected API path");
    const url = new URL(T212_DEMO_BASE_URL + path);
    if (url.hostname !== DEMO_HOST || url.protocol !== "https:") throw new Error("Refusing to call a non-demo Trading 212 host");
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: { Authorization: this.auth, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      // Don't echo response bodies blindly; keep messages short and credential-free.
      const text = (await res.text().catch(() => "")).slice(0, 200);
      throw new Trading212Error(`Trading 212 demo API ${res.status}: ${text}`, res.status);
    }
    return (await res.json()) as T;
  }

  accountSummary() {
    return this.request<{ id: number; currency: string; totalValue: number; cash: { availableToTrade: number; reservedForOrders: number; inPies: number } }>(
      "GET",
      "/equity/account/summary",
    );
  }

  positions() {
    return this.request<Array<{ instrument: { ticker: string }; quantity: number; averagePricePaid: number; currentPrice: number }>>("GET", "/equity/positions");
  }

  pendingOrders() {
    return this.request<Array<{ id: number; ticker: string; quantity: number; status: string }>>("GET", "/equity/orders");
  }

  instruments() {
    return this.request<Array<{ ticker: string; name: string; type: string; currencyCode: string; isin: string }>>("GET", "/equity/metadata/instruments");
  }

  /** Quantity is negative for sells – a Trading 212 API convention. */
  placeLimitOrder(ticker: string, quantity: number, limitPrice: number, timeValidity: "DAY" | "GOOD_TILL_CANCEL" = "DAY") {
    const now = Date.now();
    if (now - this.lastOrderAt < 2_000) throw new Error("Rate limit: wait 2s between limit orders");
    this.lastOrderAt = now;
    return this.request<{ id: number; status: string }>("POST", "/equity/orders/limit", { ticker, quantity, limitPrice, timeValidity });
  }

  cancelOrder(id: number) {
    return this.request<unknown>("DELETE", `/equity/orders/${encodeURIComponent(String(id))}`);
  }
}

/**
 * BrokerAdapter for the Trading 212 demo account. Prepared for Phase 2; the
 * server refuses to enable it while market data is simulated.
 * Uses marketable LIMIT orders (price cap) rather than market orders.
 */
export class Trading212DemoBroker implements BrokerAdapter {
  readonly name = "Trading 212 (demo / paper)";
  readonly environment = "T212_DEMO" as const;

  constructor(private readonly client: Trading212DemoClient, private readonly limitSlippageBps = 20) {}

  async placeOrder(req: OrderRequest, _now: number): Promise<BrokerOrderResult> {
    if (!req.limitPrice) return { status: "REJECTED", reason: "Limit price required for broker orders", simulated: false };
    // Duplicate guard at the broker: don't add to a ticker that already has a pending order.
    const pending = await this.client.pendingOrders();
    if (pending.some((o) => o.ticker === req.t212Ticker)) {
      return { status: "REJECTED", reason: "Pending order already exists at broker for this ticker", simulated: false };
    }
    const signed = req.side === "SELL" ? -Math.abs(req.quantity) : Math.abs(req.quantity);
    const cap = req.side === "BUY" ? req.limitPrice * (1 + this.limitSlippageBps / 10_000) : req.limitPrice * (1 - this.limitSlippageBps / 10_000);
    const res = await this.client.placeLimitOrder(req.t212Ticker, signed, Math.round(cap * 100) / 100);
    return { status: "ACCEPTED", brokerOrderId: String(res.id), simulated: false };
  }
}
