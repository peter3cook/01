import type { BrokerAdapter } from "../../core/execution/broker";
import type { BrokerAccount, BrokerFill, BrokerOrderResult, BrokerOrderUpdate, BrokerPosition, Instrument, OrderRequest } from "../../core/types";

/**
 * Trading 212 Public API (v0) – https://docs.trading212.com/api
 *
 *  - "demo" = practice (paper) account, "live" = real money. The host is fixed
 *    per environment and re-checked on every request.
 *  - Credentials stay on the server (HTTP Basic). Never logged or returned.
 *  - Order endpoints are NOT idempotent (per the docs), so a timeout is treated
 *    as "unknown" and reconciled – never blindly retried.
 *  - Prices are sent and received in the instrument's currency (GBP or GBX pence);
 *    everything inside the app is GBP.
 */
export type T212Env = "demo" | "live";
export const T212_HOSTS: Record<T212Env, string> = { demo: "demo.trading212.com", live: "live.trading212.com" };

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export class Trading212Error extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
  /** True when the request definitely did not take effect. */
  get definitive(): boolean {
    return [400, 401, 403, 404, 429].includes(this.status);
  }
}

// Minimum spacing between calls per endpoint, from the published rate limits.
const MIN_INTERVAL_MS: Record<string, number> = {
  "GET /equity/account/summary": 5_000,
  "GET /equity/positions": 1_000,
  "GET /equity/orders": 5_000,
  "GET /equity/orders/{id}": 1_000,
  "GET /equity/history/orders": 3_000, // 20/min
  "GET /equity/metadata/instruments": 50_000,
  "GET /equity/metadata/exchanges": 30_000,
  "POST /equity/orders/limit": 2_000,
  "POST /equity/orders/stop": 2_000,
  "POST /equity/orders/market": 1_200,
  "DELETE /equity/orders/{id}": 1_200,
};

export interface T212Order {
  id: number;
  ticker: string;
  side?: "BUY" | "SELL";
  type?: "LIMIT" | "STOP" | "MARKET" | "STOP_LIMIT";
  status: string;
  quantity?: number;
  filledQuantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  createdAt?: string;
  currency?: string;
}

export interface T212HistoricalOrder {
  order: T212Order;
  fill?: {
    id?: number;
    filledAt?: string;
    price?: number;
    quantity?: number;
    walletImpact?: { currency?: string; netValue?: number; taxes?: Array<{ name?: string; quantity?: number; currency?: string }> };
  };
}

export interface T212Instrument {
  ticker: string;
  name: string;
  shortName?: string;
  type: string;
  currencyCode: string;
  isin?: string;
}

export class Trading212Client {
  private readonly auth: string;
  private readonly host: string;
  private nextAllowed = new Map<string, number>();

  constructor(
    readonly env: T212Env,
    apiKey: string,
    apiSecret: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 10_000,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!apiKey || !apiSecret) throw new Error("Trading 212 API key and secret are required");
    this.host = T212_HOSTS[env];
    this.auth = "Basic " + Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  }

  private async pace(key: string) {
    const gap = MIN_INTERVAL_MS[key] ?? 1_000;
    const now = Date.now();
    const at = Math.max(now, this.nextAllowed.get(key) ?? 0);
    this.nextAllowed.set(key, at + gap);
    if (at > now) await this.sleep(at - now);
  }

  async request<T>(method: "GET" | "POST" | "DELETE", path: string, rateKey: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/equity/")) throw new Error("Unexpected API path");
    const url = new URL(`https://${this.host}/api/v0${path}`);
    if (url.hostname !== this.host || url.protocol !== "https:") throw new Error("Refusing to call an unexpected host");
    await this.pace(rateKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(url.toString(), {
        method,
        headers: { Authorization: this.auth, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
      throw new Trading212Error(`Trading 212 ${res.status}: ${text || "error"}`, res.status);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  accountSummary() {
    return this.request<{ currency: string; totalValue: number; cash: { availableToTrade: number; reservedForOrders?: number }; investments?: { currentValue?: number } }>(
      "GET", "/equity/account/summary", "GET /equity/account/summary",
    );
  }
  positions() {
    return this.request<Array<{ instrument: { ticker: string; currency?: string }; quantity: number; averagePricePaid: number; currentPrice: number; walletImpact?: { currentValue?: number; totalCost?: number } }>>(
      "GET", "/equity/positions", "GET /equity/positions",
    );
  }
  pendingOrders() {
    return this.request<T212Order[]>("GET", "/equity/orders", "GET /equity/orders");
  }
  async orderById(id: string): Promise<T212Order | undefined> {
    try {
      return await this.request<T212Order>("GET", `/equity/orders/${encodeURIComponent(id)}`, "GET /equity/orders/{id}");
    } catch (e) {
      if (e instanceof Trading212Error && e.status === 404) return undefined; // no longer pending
      throw e;
    }
  }
  historyOrders(ticker?: string, limit = 50) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (ticker) q.set("ticker", ticker);
    return this.request<{ items: T212HistoricalOrder[] }>("GET", `/equity/history/orders?${q}`, "GET /equity/history/orders");
  }
  instruments() {
    return this.request<T212Instrument[]>("GET", "/equity/metadata/instruments", "GET /equity/metadata/instruments");
  }
  placeLimit(ticker: string, quantity: number, limitPrice: number, timeValidity: "DAY" | "GOOD_TILL_CANCEL") {
    return this.request<T212Order>("POST", "/equity/orders/limit", "POST /equity/orders/limit", { ticker, quantity, limitPrice, timeValidity });
  }
  placeStop(ticker: string, quantity: number, stopPrice: number, timeValidity: "DAY" | "GOOD_TILL_CANCEL") {
    return this.request<T212Order>("POST", "/equity/orders/stop", "POST /equity/orders/stop", { ticker, quantity, stopPrice, timeValidity });
  }
  placeMarket(ticker: string, quantity: number) {
    return this.request<T212Order>("POST", "/equity/orders/market", "POST /equity/orders/market", { ticker, quantity, extendedHours: false });
  }
  async cancel(id: string): Promise<void> {
    try {
      await this.request<unknown>("DELETE", `/equity/orders/${encodeURIComponent(id)}`, "DELETE /equity/orders/{id}");
    } catch (e) {
      if (e instanceof Trading212Error && e.status === 404) return; // already gone
      throw e;
    }
  }
}

/** GBX (pence) <-> GBP. */
export const toGBP = (price: number, unit: "GBP" | "GBX" = "GBP") => (unit === "GBX" ? price / 100 : price);
export const fromGBP = (gbp: number, unit: "GBP" | "GBX" = "GBP") => (unit === "GBX" ? gbp * 100 : gbp);
const floor2 = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
const ceil2 = (x: number) => Math.ceil(x * 100 - 1e-9) / 100;

const PENDING_STATES = new Set(["LOCAL", "UNCONFIRMED", "CONFIRMED", "NEW", "PARTIALLY_FILLED", "REPLACING", "CANCELLING"]);

/**
 * BrokerAdapter for Trading 212. Buys are LIMIT orders (worst-case price is
 * known), stops are resting STOP orders at the broker, exits are MARKET sells.
 */
export class Trading212Broker implements BrokerAdapter {
  readonly name: string;
  readonly environment: "T212_DEMO" | "T212_LIVE";
  private readonly bySymbol: Map<string, Instrument>;
  private readonly byTicker: Map<string, Instrument>;

  constructor(
    private readonly client: Trading212Client,
    instruments: Instrument[],
    /** Defence in depth: never send a buy worth more than this (GBP). */
    private readonly maxOrderValueGBP = 25,
  ) {
    this.environment = client.env === "live" ? "T212_LIVE" : "T212_DEMO";
    this.name = client.env === "live" ? "Trading 212 (REAL MONEY)" : "Trading 212 (practice account)";
    this.bySymbol = new Map(instruments.map((i) => [i.symbol, i]));
    this.byTicker = new Map(instruments.map((i) => [i.t212Ticker, i]));
  }

  private unit(ticker: string) {
    return this.byTicker.get(ticker)?.priceUnit ?? "GBP";
  }

  async placeOrder(req: OrderRequest, _now: number): Promise<BrokerOrderResult> {
    const inst = this.bySymbol.get(req.symbol);
    if (!inst || inst.t212Ticker !== req.t212Ticker) return { status: "REJECTED", reason: "Instrument not verified with Trading 212", simulated: false };
    const unit = inst.priceUnit ?? "GBP";
    if (!(req.quantity > 0)) return { status: "REJECTED", reason: "Invalid quantity", simulated: false };

    let pending: T212Order[];
    try {
      pending = (await this.client.pendingOrders()).filter((o) => o.ticker === req.t212Ticker && !["CANCELLED", "FILLED", "REJECTED"].includes(o.status));
    } catch (e) {
      return { status: "REJECTED", reason: `Couldn't check pending orders: ${(e as Error).message}`, simulated: false };
    }

    try {
      let order: T212Order;
      if (req.side === "BUY") {
        if (req.type !== "LIMIT" || !req.limitPrice) return { status: "REJECTED", reason: "Buys must be limit orders", simulated: false };
        if (pending.length) return { status: "REJECTED", reason: "An order is already pending for this fund", simulated: false };
        if (req.quantity * req.limitPrice > this.maxOrderValueGBP) return { status: "REJECTED", reason: `Order value above £${this.maxOrderValueGBP} safety cap`, simulated: false };
        // Round the limit DOWN so the worst-case price never exceeds the plan.
        order = await this.client.placeLimit(req.t212Ticker, req.quantity, floor2(fromGBP(req.limitPrice, unit)), req.timeValidity ?? "DAY");
      } else if (req.type === "STOP") {
        if (!req.stopPrice) return { status: "REJECTED", reason: "Stop price required", simulated: false };
        if (pending.some((o) => o.type === "STOP" && o.status !== "CANCELLING")) return { status: "REJECTED", reason: "A stop order already exists", simulated: false };
        // Round a sell stop UP: it triggers slightly earlier, never later than planned.
        order = await this.client.placeStop(req.t212Ticker, -Math.abs(req.quantity), ceil2(fromGBP(req.stopPrice, unit)), req.timeValidity ?? "GOOD_TILL_CANCEL");
      } else {
        if (pending.some((o) => o.side === "SELL" && o.type !== "STOP" && o.status !== "CANCELLING")) return { status: "REJECTED", reason: "A sell order is already pending", simulated: false };
        order = await this.client.placeMarket(req.t212Ticker, -Math.abs(req.quantity));
      }
      return { status: "ACCEPTED", brokerOrderId: String(order.id), simulated: false };
    } catch (e) {
      if (e instanceof Trading212Error && e.definitive) return { status: "REJECTED", reason: e.message, simulated: false };
      throw e; // timeout / 5xx: outcome unknown – the engine reconciles
    }
  }

  private toFill(h: T212HistoricalOrder, ticker: string): BrokerFill | undefined {
    const unit = this.unit(ticker);
    const qty = Math.abs(h.fill?.quantity ?? h.order.filledQuantity ?? 0);
    const price = h.fill?.price;
    if (!qty || !price) return undefined;
    const fees = (h.fill?.walletImpact?.taxes ?? []).reduce((s, t) => s + Math.abs(t.quantity ?? 0), 0);
    return {
      price: toGBP(price, unit),
      quantity: qty,
      at: h.fill?.filledAt ? Date.parse(h.fill.filledAt) : Date.now(),
      fees: { commission: 0, fxFee: 0, stampDuty: fees, explicitTotal: fees, spreadCost: 0 },
    };
  }

  async getOrderUpdate(brokerOrderId: string, req: OrderRequest, _submittedAt: number): Promise<BrokerOrderUpdate> {
    const live = await this.client.orderById(brokerOrderId);
    if (live && PENDING_STATES.has(live.status)) return { state: "PENDING", brokerStatus: live.status };
    const hist = (await this.client.historyOrders(req.t212Ticker)).items.find((h) => String(h.order.id) === brokerOrderId);
    if (!hist) return { state: "UNKNOWN", reason: "Not in pending or history yet" };
    const fill = this.toFill(hist, req.t212Ticker);
    if (hist.order.status === "FILLED" && fill) return { state: "FILLED", fill, brokerStatus: "FILLED" };
    return { state: "CLOSED", brokerStatus: hist.order.status, reason: hist.order.status.toLowerCase(), fill };
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.client.cancel(brokerOrderId);
  }

  async findOrder(req: OrderRequest, submittedAt: number): Promise<{ brokerOrderId: string } | undefined> {
    const after = submittedAt - 15_000;
    const matches = (o: T212Order) =>
      o.ticker === req.t212Ticker &&
      Math.abs(Math.abs(o.quantity ?? 0) - req.quantity) < 1e-6 &&
      (!o.createdAt || Date.parse(o.createdAt) >= after);
    const p = (await this.client.pendingOrders()).find(matches);
    if (p) return { brokerOrderId: String(p.id) };
    const h = (await this.client.historyOrders(req.t212Ticker)).items.find((x) => matches(x.order));
    return h ? { brokerOrderId: String(h.order.id) } : undefined;
  }

  async getAccount(): Promise<BrokerAccount> {
    const s = await this.client.accountSummary();
    if (s.currency !== "GBP") throw new Error(`Account currency ${s.currency} not supported (GBP only)`);
    return { cashGBP: s.cash.availableToTrade, totalValueGBP: s.totalValue, investedGBP: s.investments?.currentValue ?? s.totalValue - s.cash.availableToTrade, currency: s.currency };
  }

  async getPositions(): Promise<BrokerPosition[]> {
    const rows = await this.client.positions();
    return rows.map((r) => {
      const inst = this.byTicker.get(r.instrument.ticker);
      // Wallet impact is in account currency (GBP): the safest source for values.
      const value = r.walletImpact?.currentValue ?? toGBP(r.currentPrice, inst?.priceUnit) * r.quantity;
      const cost = r.walletImpact?.totalCost ?? toGBP(r.averagePricePaid, inst?.priceUnit) * r.quantity;
      const currentGBP = r.quantity ? value / r.quantity : 0;
      if (inst && r.walletImpact?.currentValue !== undefined && r.quantity > 0) {
        // Cross-check our pence/pounds mapping against the broker's own GBP value.
        const viaUnit = toGBP(r.currentPrice, inst.priceUnit);
        if (Math.abs(viaUnit - currentGBP) / currentGBP > 0.05) {
          throw new Error(`Price unit mismatch for ${inst.symbol}: check GBP/GBX setting`);
        }
      }
      return {
        symbol: inst?.symbol ?? r.instrument.ticker,
        t212Ticker: r.instrument.ticker,
        quantity: r.quantity,
        avgPriceGBP: r.quantity ? cost / r.quantity : 0,
        currentPriceGBP: currentGBP,
        valueGBP: value,
        costGBP: cost,
      };
    });
  }

  async getSellFills(symbol: string, since: number) {
    const inst = this.bySymbol.get(symbol);
    if (!inst) return [];
    const items = (await this.client.historyOrders(inst.t212Ticker)).items;
    return items
      .filter((h) => (h.order.side === "SELL" || (h.order.quantity ?? 0) < 0) && h.fill?.filledAt && Date.parse(h.fill.filledAt) >= since)
      .map((h) => {
        const f = this.toFill(h, inst.t212Ticker)!;
        return f && { brokerOrderId: String(h.order.id), type: h.order.type ?? "MARKET", price: f.price, quantity: f.quantity, at: f.at, feesGBP: f.fees.explicitTotal };
      })
      .filter(Boolean) as Array<{ brokerOrderId: string; type: string; price: number; quantity: number; at: number; feesGBP: number }>;
  }
}

/**
 * Match our ETF list to Trading 212's instrument list. Only GBP/GBX-priced ETFs
 * are kept (no FX fees, and the API trades in the account currency only).
 */
export function verifyInstruments(universe: Instrument[], t212: T212Instrument[]): { verified: Instrument[]; report: string[] } {
  const report: string[] = [];
  const verified: Instrument[] = [];
  for (const inst of universe) {
    const exact = t212.find((x) => x.ticker === inst.t212Ticker);
    const match =
      exact ??
      t212.find((x) => x.type === "ETF" && (x.shortName ?? "").toUpperCase() === inst.symbol && /l_EQ$/.test(x.ticker) && ["GBP", "GBX"].includes(x.currencyCode));
    if (!match) {
      report.push(`${inst.symbol}: not found at Trading 212 – disabled`);
      continue;
    }
    if (match.type !== "ETF") {
      report.push(`${inst.symbol}: ${match.ticker} is ${match.type}, not ETF – disabled`);
      continue;
    }
    if (!["GBP", "GBX"].includes(match.currencyCode)) {
      report.push(`${inst.symbol}: quoted in ${match.currencyCode} – disabled (GBP/GBX only)`);
      continue;
    }
    const priceUnit = match.currencyCode === "GBX" ? "GBX" : "GBP";
    verified.push({ ...inst, t212Ticker: match.ticker, priceUnit });
    report.push(`${inst.symbol}: ${match.ticker} (${priceUnit})${exact ? "" : " – ticker corrected"}`);
  }
  return { verified, report };
}
