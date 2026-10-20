import { appendAudit, verifyAudit } from "./audit/auditLog";
import { FallbackExplainer, type AiBudget, type TradeExplainer } from "./ai/explainer";
import { TemplateExplainer } from "./ai/templateExplainer";
import { isAsyncBroker, type BrokerAdapter } from "./execution/broker";
import { ExecutionService } from "./execution/executionService";
import type { FeeModel } from "./fees/feeModel";
import { ZERO_FEES } from "./fees/feeModel";
import type { MarketDataProvider } from "./marketdata/provider";
import { applyFill, equityOf, positionViews, realisedTotal, type PositionView } from "./portfolio/ledger";
import { DEFAULT_LIMITS, HARD_CEILINGS, clampToCeilings, isTightening, tightenLimits } from "./risk/limits";
import { failedChecks, validateEntry, type EntryRiskContext } from "./risk/riskEngine";
import { sizePosition } from "./risk/sizing";
import { DEFAULT_STRATEGY, evaluateTrend, type StrategyParams } from "./strategy/trendPullback";
import type {
  AuditActor,
  AuditEntry,
  BrokerFill,
  CostTotals,
  DataHealth,
  EngineState,
  EquityPoint,
  OrderRecord,
  OrderRequest,
  Position,
  Proposal,
  RiskLimits,
  ScanRow,
  Trade,
  TradeReason,
} from "./types";
import { newId } from "./util/ids";
import { ALWAYS_OPEN, type MarketClock } from "./util/marketHours";
import { dayKey, round } from "./util/math";

export interface StateStore {
  load(): EngineState | undefined;
  save(state: EngineState): void;
}

export class MemoryStore implements StateStore {
  private s?: EngineState;
  load() {
    return this.s ? structuredClone(this.s) : undefined;
  }
  save(state: EngineState) {
    this.s = structuredClone(state);
  }
}

export interface EngineOptions {
  md: MarketDataProvider;
  broker: BrokerAdapter;
  fees: FeeModel;
  /** Optional paid explainer (Claude). Falls back to the rules template. */
  aiExplainer?: TradeExplainer;
  aiBudget?: { maxCallsPerDay: number; maxCostPerDayGBP: number };
  store?: StateStore;
  clock?: () => number;
  /** "demo"/"simulated", "paper" (broker practice account) or "live" (real money). */
  tradingMode: string;
  /** Live mode only trades when the operator has explicitly armed it in config. */
  liveArmed?: boolean;
  limits?: Partial<RiskLimits>;
  startingCapitalGBP?: number;
  scanIntervalMs?: number;
  /** Don't re-propose the same ETF within this window after a reject/expiry. */
  cooldownMs?: number;
  maxPendingProposals?: number;
  goalGBP?: number;
  onAudit?: (e: AuditEntry) => void;
  /** Trading hours. Defaults to always open (simulator). */
  market?: MarketClock;
  /** Entry order style. LIMIT is required with end-of-day prices. */
  entryOrder?: { type: "MARKET" | "LIMIT"; limitBufferBps: number };
  /** Max quote age accepted by the risk engine (overrides limits.maxDataAgeMs). */
  maxQuoteAgeMs?: number;
  strategy?: StrategyParams;
  /** How often to sync cash/positions and check orders with a real broker. */
  brokerSyncMs?: number;
}

export interface DashboardSnapshot {
  generatedAt: number;
  mode: string;
  liveTradingEnabled: boolean;
  dataHealth: DataHealth;
  broker: { name: string; environment: string };
  explainer: string;
  market: { open: boolean; entriesAllowed: boolean; detail: string };
  autoTrade: { enabled: boolean; since?: number };
  account: {
    source: "simulated" | "broker";
    syncedAt?: number;
    startingCapital: number;
    cash: number;
    invested: number;
    equity: number;
    unrealisedPnl: number;
    realisedPnl: number;
    totalPnl: number;
    totalPnlPct: number;
    dayPnl: number;
    goalGBP: number;
    goalProgressPct: number;
  };
  positions: PositionView[];
  pending: Proposal[];
  recentProposals: Proposal[];
  scanner: ScanRow[];
  trades: Trade[];
  orders: OrderRecord[];
  openOrders: OrderRecord[];
  equityHistory: EquityPoint[];
  costs: CostTotals & { tradingTotal: number; tradingPctOfCapital: number };
  limits: RiskLimits;
  ceilings: RiskLimits;
  emergencyStop: EngineState["emergencyStop"];
  halted: { active: boolean; reasons: string[] };
  warnings: string[];
  entriesToday: number;
  audit: AuditEntry[];
  auditIntegrity: { ok: boolean; brokenAt?: number };
  lastScanAt: number;
  nextScanAt: number;
}

export class EngineError extends Error {
  constructor(message: string, readonly code: "NOT_FOUND" | "CONFLICT" | "EXPIRED" | "INVALID") {
    super(message);
  }
}

const EQUITY_SAMPLE_MS = 30_000;
const MAX_EQUITY_POINTS = 2000;
const ORDER_CHECK_MS = 15_000;
const LOST_ORDER_GIVE_UP_MS = 120_000;
export const RESUME_PHRASE = "RESUME";
export const AUTO_PHRASE = "AUTO";

export class CopilotEngine {
  state: EngineState;
  private readonly md: MarketDataProvider;
  private readonly fees: FeeModel;
  private readonly clock: () => number;
  private readonly store?: StateStore;
  private readonly explainer: TradeExplainer;
  private readonly execution: ExecutionService;
  private readonly broker: BrokerAdapter;
  private readonly asyncBroker: boolean;
  private readonly market: MarketClock;
  private readonly approving = new Map<string, string>(); // proposalId -> symbol
  private readonly closing = new Set<string>();
  private readonly staleWarned = new Set<string>();
  private scanning = false;
  private syncing = false;
  private lastSync = 0;
  private lastRows: ScanRow[] = [];

  constructor(private readonly opts: EngineOptions) {
    this.md = opts.md;
    this.fees = opts.fees;
    this.broker = opts.broker;
    this.asyncBroker = isAsyncBroker(opts.broker);
    this.market = opts.market ?? ALWAYS_OPEN;
    this.clock = opts.clock ?? (() => Date.now());
    this.store = opts.store;

    const now = this.clock();
    const configured = clampToCeilings({ ...DEFAULT_LIMITS, ...(opts.limits ?? {}) });
    const loaded = this.store?.load();
    if (loaded && loaded.version === 1) {
      this.state = loaded;
      // Use whichever is tighter: limits saved from the app or the current config.
      const merged = { ...configured };
      for (const k of Object.keys(configured) as (keyof RiskLimits)[]) {
        const saved = loaded.limits?.[k];
        if (typeof saved === "number" && isTightening(k, configured[k], saved)) merged[k] = saved;
      }
      this.state.limits = clampToCeilings(merged);
    } else {
      const capital = opts.startingCapitalGBP ?? 50;
      this.state = {
        version: 1,
        createdAt: now,
        startingCapitalGBP: capital,
        cash: capital,
        positions: [],
        proposals: [],
        orders: [],
        trades: [],
        equityHistory: [{ t: now, equity: capital, cash: capital }],
        audit: [],
        costs: { commission: 0, fxFee: 0, stampDuty: 0, spreadCost: 0, aiCostGBP: 0, aiCalls: 0 },
        limits: configured,
        emergencyStop: { active: false },
        daily: { day: dayKey(now), entries: 0, startEquity: capital, aiCostGBP: 0, aiCalls: 0 },
        lastScanAt: 0,
        autoTrade: { enabled: false },
      };
      this.audit(
        "system",
        "ACCOUNT_CREATED",
        this.asyncBroker ? `Connected to ${opts.broker.name} (${opts.tradingMode})` : `Simulated account opened with £${capital.toFixed(2)}`,
        { capital, mode: opts.tradingMode },
      );
    }
    this.state.autoTrade ??= { enabled: false };

    const budget = opts.aiBudget ?? { maxCallsPerDay: 10, maxCostPerDayGBP: 0.05 };
    const aiBudget: AiBudget = {
      allow: (t) => {
        this.rollDay(t);
        return this.state.daily.aiCalls < budget.maxCallsPerDay && this.state.daily.aiCostGBP < budget.maxCostPerDayGBP;
      },
      record: (cost) => {
        this.state.daily.aiCalls++;
        this.state.daily.aiCostGBP = round(this.state.daily.aiCostGBP + cost, 6);
        this.state.costs.aiCalls++;
        this.state.costs.aiCostGBP = round(this.state.costs.aiCostGBP + cost, 6);
      },
    };
    this.explainer = new FallbackExplainer(opts.aiExplainer, new TemplateExplainer(), aiBudget);
    this.execution = new ExecutionService(
      opts.broker,
      () => this.state.orders,
      (rec) => {
        this.state.orders.push(rec);
        this.trimOrders();
      },
      () => newId("ord"),
    );
    this.persist();
  }

  // ------------------------------------------------------------------ helpers

  get isLive(): boolean {
    return this.opts.tradingMode === "live";
  }

  private audit(actor: AuditActor, type: string, message: string, data?: Record<string, unknown>) {
    const e = appendAudit(this.state.audit, this.clock(), actor, type, message, data);
    this.opts.onAudit?.(e);
  }

  private persist() {
    this.store?.save(this.state);
  }

  private trimOrders() {
    // Never drop unresolved orders.
    if (this.state.orders.length <= 500) return;
    const open = this.state.orders.filter((o) => this.isOpenOrder(o));
    const done = this.state.orders.filter((o) => !this.isOpenOrder(o)).slice(-(500 - open.length));
    this.state.orders = [...done, ...open].sort((a, b) => a.submittedAt - b.submittedAt);
  }

  private isOpenOrder(o: OrderRecord): boolean {
    return (o.status === "ACCEPTED" || (o.status === "ERROR" && this.asyncBroker)) && !o.resolvedAt;
  }

  private rollDay(now: number) {
    const day = dayKey(now);
    if (this.state.daily.day !== day) {
      this.state.daily = { day, entries: 0, startEquity: this.equity(), aiCostGBP: 0, aiCalls: 0 };
    }
  }

  equity(): number {
    const b = this.state.brokerAccount;
    if (this.asyncBroker && b) return b.totalValueGBP;
    return equityOf(this.state, this.md);
  }

  private investedByApp(): number {
    const held = positionViews(this.state, this.md)
      .filter((p) => !p.external)
      .reduce((s, p) => s + p.marketValue, 0);
    const pendingBuys = this.state.orders
      .filter((o) => this.isOpenOrder(o) && o.request.side === "BUY")
      .reduce((s, o) => s + o.request.quantity * (o.request.limitPrice ?? 0), 0);
    return round(held + pendingBuys);
  }

  private haltReasons(now: number): string[] {
    const reasons: string[] = [];
    const l = this.state.limits;
    if (this.isLive && !this.opts.liveArmed) reasons.push("Live mode is not armed");
    if (this.state.emergencyStop.active) reasons.push(`Emergency stop: ${this.state.emergencyStop.reason ?? "engaged"}`);
    const h = this.md.health(now);
    if (!h.ok) reasons.push(`Market data unavailable: ${h.detail}`);
    if (this.asyncBroker && !this.state.brokerAccount) reasons.push("Waiting for first sync with the broker");
    const dayPnl = this.equity() - this.state.daily.startEquity;
    if (dayPnl <= -l.maxDailyLossGBP) reasons.push(`Daily loss limit reached (£${dayPnl.toFixed(2)})`);
    if (this.state.daily.entries >= l.maxTradesPerDay) reasons.push("Daily trade limit reached");
    return reasons;
  }

  private warnings(): string[] {
    const w: string[] = [];
    for (const p of this.state.positions) {
      if (this.asyncBroker && !p.external && !p.stopOrderId) w.push(`${p.symbol} has no stop-loss at the broker yet`);
      if (p.external) w.push(`${p.symbol} was opened outside the app and is not managed`);
    }
    if (this.state.orders.some((o) => o.status === "ERROR" && !o.resolvedAt && this.asyncBroker)) w.push("Checking an order whose status is unknown – new orders in that fund are paused");
    return w;
  }

  private riskContext(now: number, p: Pick<Proposal, "symbol" | "quantity" | "entryPrice" | "stopPrice" | "estCosts">, proposedPrice?: number, excludeProposalId?: string): EntryRiskContext {
    const inFlight = new Set<string>();
    for (const [pid, sym] of this.approving) if (pid !== excludeProposalId) inFlight.add(sym);
    for (const o of this.state.orders) if (this.isOpenOrder(o) && o.request.side === "BUY") inFlight.add(o.request.symbol);
    const isLimit = (this.opts.entryOrder?.type ?? "MARKET") === "LIMIT";
    return {
      now,
      tradingMode: this.opts.tradingMode,
      liveArmed: this.opts.liveArmed,
      marketOpen: this.market.entriesAllowed(now),
      maxQuoteAgeMs: this.opts.maxQuoteAgeMs,
      investedGBP: this.investedByApp(),
      limits: this.state.limits,
      emergencyStopActive: this.state.emergencyStop.active,
      instrument: this.md.instrument(p.symbol),
      allowedSymbols: new Set(this.md.instruments().filter((i) => i.type === "ETF").map((i) => i.symbol)),
      quote: this.md.quote(p.symbol, now),
      dataHealth: this.md.health(now),
      order: { symbol: p.symbol, side: "BUY", quantity: p.quantity, entryPrice: p.entryPrice, stopPrice: p.stopPrice, estCosts: p.estCosts, proposedPrice, isLimit },
      cash: this.state.cash,
      equity: this.equity(),
      dayStartEquity: this.state.daily.startEquity,
      entriesToday: this.state.daily.entries,
      positions: this.state.positions,
      openOrders: this.state.orders.filter((o) => this.isOpenOrder(o)).map((o) => ({ ...o, status: "ACCEPTED" as const })),
      inFlightSymbols: inFlight,
    };
  }

  // ------------------------------------------------------------------ main loop

  /** Refresh data, sync with the broker, expire approvals, manage exits and (when due) scan. */
  async tick(): Promise<void> {
    const now = this.clock();
    this.md.tick(now);
    this.rollDay(now);
    this.expireProposals(now);
    if (this.asyncBroker && now - this.lastSync >= (this.opts.brokerSyncMs ?? 30_000)) await this.syncBroker(now);
    await this.manageExits(now);
    this.circuitBreakers(now);
    this.recordEquity(now);
    const interval = this.opts.scanIntervalMs ?? 30_000;
    if (now - this.state.lastScanAt >= interval) await this.scan();
    this.persist();
  }

  private expireProposals(now: number) {
    for (const p of this.state.proposals) {
      if (p.status === "PENDING" && now > p.expiresAt) {
        p.status = "EXPIRED";
        p.decidedAt = now;
        p.statusReason = "Not approved in time";
        this.audit("system", "PROPOSAL_EXPIRED", `${p.symbol} proposal expired without approval`, { proposalId: p.id });
      }
    }
  }

  private circuitBreakers(now: number) {
    const eq = this.equity();
    if (this.asyncBroker && !this.state.brokerAccount) return;
    if (!this.state.emergencyStop.active && eq <= this.state.limits.equityFloorGBP) {
      this.engageEmergencyStop(`Equity £${eq.toFixed(2)} hit the £${this.state.limits.equityFloorGBP.toFixed(2)} floor`, "risk", now);
    }
  }

  private recordEquity(now: number) {
    if (this.asyncBroker && !this.state.brokerAccount) return;
    const h = this.state.equityHistory;
    const last = h[h.length - 1];
    if (last && now - last.t < EQUITY_SAMPLE_MS) return;
    h.push({ t: now, equity: this.equity(), cash: this.state.cash });
    if (h.length > MAX_EQUITY_POINTS) {
      const half = Math.floor(h.length / 2);
      const older = h.slice(0, half).filter((_, i) => i % 2 === 0);
      this.state.equityHistory = [...older, ...h.slice(half)];
    }
  }

  // ------------------------------------------------------------------ broker sync (real brokers)

  /** Pull cash, positions and order states from the broker. The broker is the source of truth. */
  async syncBroker(now = this.clock()): Promise<void> {
    if (!this.asyncBroker || this.syncing) return;
    this.syncing = true;
    this.lastSync = now;
    try {
      await this.reconcileOrders(now);
      if (this.broker.getAccount) {
        const acc = await this.broker.getAccount();
        const first = !this.state.brokerAccount;
        this.state.brokerAccount = { ...acc, syncedAt: now };
        this.state.cash = acc.cashGBP;
        if (first && this.state.trades.length === 0) {
          // Measure performance from the real account value at connection time.
          this.state.startingCapitalGBP = acc.totalValueGBP;
          this.state.daily.startEquity = acc.totalValueGBP;
          this.state.equityHistory = [{ t: now, equity: acc.totalValueGBP, cash: acc.cashGBP }];
          this.audit("broker", "ACCOUNT_SYNCED", `Broker account connected: value £${acc.totalValueGBP.toFixed(2)}, cash £${acc.cashGBP.toFixed(2)}`, {});
        }
      }
      if (this.broker.getPositions) await this.reconcilePositions(now);
      await this.ensureStops(now);
    } catch (e) {
      this.audit("broker", "SYNC_FAILED", `Broker sync failed: ${(e as Error).message.slice(0, 160)}`, {});
    } finally {
      this.syncing = false;
      this.persist();
    }
  }

  private async reconcileOrders(now: number) {
    for (const rec of this.state.orders.filter((o) => this.isOpenOrder(o))) {
      if (rec.lastCheckedAt && now - rec.lastCheckedAt < ORDER_CHECK_MS) continue;
      rec.lastCheckedAt = now;

      // Unknown outcome (e.g. timeout): look for the order rather than resending.
      if (rec.status === "ERROR") {
        const found = await this.broker.findOrder?.(rec.request, rec.submittedAt).catch(() => undefined);
        if (found) {
          rec.status = "ACCEPTED";
          rec.brokerOrderId = found.brokerOrderId;
          this.audit("broker", "ORDER_FOUND", `${rec.request.symbol}: order found at broker after an error (${found.brokerOrderId})`, { orderId: rec.id });
        } else if (now - rec.submittedAt > LOST_ORDER_GIVE_UP_MS) {
          rec.status = "REJECTED";
          rec.resolvedAt = now;
          rec.reason = `${rec.reason ?? "Error"} – confirmed not placed`;
          this.audit("broker", "ORDER_NOT_PLACED", `${rec.request.symbol}: order was not placed at the broker`, { orderId: rec.id });
          this.onOrderClosed(rec, now);
        }
        continue;
      }

      if (!rec.brokerOrderId || !this.broker.getOrderUpdate) continue;
      const u = await this.broker.getOrderUpdate(rec.brokerOrderId, rec.request, rec.submittedAt);
      if (u.state === "PENDING") {
        rec.brokerStatus = u.brokerStatus;
      } else if (u.state === "FILLED") {
        rec.brokerStatus = u.brokerStatus;
        this.onOrderFilled(rec, u.fill, now);
      } else if (u.state === "CLOSED") {
        rec.brokerStatus = u.brokerStatus;
        if (u.fill && u.fill.quantity > 0) this.onOrderFilled(rec, u.fill, now);
        else {
          rec.status = u.brokerStatus === "REJECTED" ? "REJECTED" : "CANCELLED";
          rec.reason = u.reason;
          rec.resolvedAt = now;
          this.onOrderClosed(rec, now);
        }
      }
    }
  }

  private onOrderFilled(rec: OrderRecord, fill: BrokerFill, now: number) {
    if (rec.resolvedAt) return;
    rec.status = "FILLED";
    rec.fill = fill;
    rec.resolvedAt = now;
    const { symbol, side, reason, proposalId } = rec.request;
    if (side === "BUY") {
      const p = this.state.proposals.find((x) => x.id === proposalId);
      const t = applyFill(this.state, { orderId: rec.id, symbol, side: "BUY", fill, reason: "ENTRY", stop: p?.stopPrice, target: p?.targetPrice, proposalId, simulated: rec.simulated, tradeId: newId("trd") });
      if (p) {
        p.status = "EXECUTED";
        p.statusReason = undefined;
      }
      this.audit("broker", "ORDER_FILLED", `Bought ${t.quantity} ${symbol} @ £${t.price.toFixed(4)} (£${t.value.toFixed(2)})`, { orderId: rec.id, brokerOrderId: rec.brokerOrderId });
    } else {
      const pos = this.state.positions.find((x) => x.symbol === symbol);
      if (!pos) {
        this.audit("broker", "FILL_WITHOUT_POSITION", `${symbol}: sell fill received but no position recorded`, { orderId: rec.id });
        return;
      }
      const qty = Math.min(fill.quantity, pos.quantity);
      const t = applyFill(this.state, { orderId: rec.id, symbol, side: "SELL", fill: { ...fill, quantity: qty }, reason, simulated: rec.simulated, tradeId: newId("trd") });
      const still = this.state.positions.find((x) => x.symbol === symbol);
      if (still) {
        if (rec.id === still.exitRecordId) still.exitRecordId = undefined;
        if (rec.id === still.stopRecordId) { still.stopOrderId = undefined; still.stopRecordId = undefined; }
      }
      this.audit("broker", "POSITION_CLOSED", `${reason.replace("_", " ")}: sold ${t.quantity} ${symbol} @ £${t.price.toFixed(4)} · P&L £${(t.realisedPnl ?? 0).toFixed(2)}`, { orderId: rec.id, reason, pnl: t.realisedPnl });
    }
  }

  private onOrderClosed(rec: OrderRecord, now: number) {
    const { symbol, side, proposalId, type } = rec.request;
    if (side === "BUY") {
      const p = this.state.proposals.find((x) => x.id === proposalId);
      if (p && (p.status === "SUBMITTED" || p.status === "APPROVED")) {
        p.status = "CANCELLED";
        p.decidedAt ??= now;
        p.statusReason = `Order not filled: ${rec.reason ?? rec.status}`;
      }
      this.audit("broker", "ENTRY_NOT_FILLED", `${symbol}: buy order ended without a fill (${rec.reason ?? rec.status})`, { orderId: rec.id });
      return;
    }
    const pos = this.state.positions.find((x) => x.symbol === symbol);
    if (!pos) return;
    if (type === "STOP" && pos.stopRecordId === rec.id) {
      pos.stopOrderId = undefined;
      pos.stopRecordId = undefined;
      if (!pos.exitRecordId) this.audit("risk", "STOP_LOST", `${symbol}: stop-loss order at the broker ended (${rec.reason ?? rec.status}) – placing a new one`, {});
    }
    if (pos.exitRecordId === rec.id) {
      pos.exitRecordId = undefined;
      this.audit("broker", "EXIT_NOT_FILLED", `${symbol}: sell order ended without a fill – stop-loss will be re-placed`, { orderId: rec.id });
    }
  }

  private async reconcilePositions(now: number) {
    const brokerPositions = await this.broker.getPositions!();
    const bySymbol = new Map(brokerPositions.map((p) => [p.symbol, p]));

    for (const pos of [...this.state.positions]) {
      const b = bySymbol.get(pos.symbol);
      if (b) {
        pos.missingSince = undefined;
        pos.markPrice = b.currentPriceGBP;
        pos.markAt = now;
        (this.md as { setMark?: (s: string, p: number, t: number) => void }).setMark?.(pos.symbol, b.currentPriceGBP, now);
        if (pos.external) { pos.quantity = b.quantity; pos.costBasis = b.costGBP; pos.avgPrice = b.avgPriceGBP; }
        continue;
      }
      // Position gone at the broker. If our own sell is working, wait for its fill.
      const exitRec = this.state.orders.find((o) => o.id === pos.exitRecordId && this.isOpenOrder(o));
      if (exitRec) {
        exitRec.lastCheckedAt = 0; // check it on the next sync
        continue;
      }
      // Our stop may have just filled: check it now.
      const stopRec = this.state.orders.find((o) => o.id === pos.stopRecordId && this.isOpenOrder(o));
      if (stopRec?.brokerOrderId && this.broker.getOrderUpdate) {
        const u = await this.broker.getOrderUpdate(stopRec.brokerOrderId, stopRec.request, stopRec.submittedAt);
        if (u.state === "FILLED" || (u.state === "CLOSED" && u.fill)) {
          this.onOrderFilled(stopRec, u.fill!, now);
          continue;
        }
      }
      if (pos.external) {
        this.state.positions = this.state.positions.filter((x) => x !== pos);
        continue;
      }
      // The broker's position list can lag a fresh fill: only act once it has been
      // missing on two syncs at least a minute apart.
      if (pos.missingSince === undefined || now - pos.missingSince < 60_000) {
        pos.missingSince ??= now;
        continue;
      }
      // Sold outside the app (e.g. in the Trading 212 app). Remove our now-pointless stop first.
      if (stopRec?.brokerOrderId && this.broker.cancelOrder) {
        await this.broker.cancelOrder(stopRec.brokerOrderId).catch(() => undefined);
        stopRec.status = "CANCELLED";
        stopRec.resolvedAt = now;
        stopRec.reason = "Position sold outside the app";
      }
      // Record the real fills if we can find them.
      const fills = (await this.broker.getSellFills?.(pos.symbol, pos.openedAt).catch(() => [])) ?? [];
      const known = new Set(this.state.orders.map((o) => o.brokerOrderId));
      let recorded = false;
      for (const f of fills.filter((x) => !known.has(x.brokerOrderId))) {
        const current = this.state.positions.find((x) => x.symbol === pos.symbol);
        if (!current) break;
        const rec: OrderRecord = {
          id: newId("ord"),
          request: { clientOrderId: `external-${f.brokerOrderId}`, symbol: pos.symbol, t212Ticker: "", side: "SELL", quantity: f.quantity, type: "MARKET", reason: "EXTERNAL" },
          status: "FILLED",
          brokerOrderId: f.brokerOrderId,
          broker: this.broker.name,
          submittedAt: f.at,
          resolvedAt: now,
          simulated: false,
          fill: { price: f.price, quantity: Math.min(f.quantity, current.quantity), at: f.at, fees: { ...ZERO_FEES, stampDuty: f.feesGBP, explicitTotal: f.feesGBP } },
        };
        this.state.orders.push(rec);
        const t = applyFill(this.state, { orderId: rec.id, symbol: pos.symbol, side: "SELL", fill: rec.fill!, reason: "EXTERNAL", simulated: false, tradeId: newId("trd") });
        this.audit("broker", "POSITION_CLOSED", `${pos.symbol} sold outside the app: ${t.quantity} @ £${t.price.toFixed(4)} · P&L £${(t.realisedPnl ?? 0).toFixed(2)}`, { brokerOrderId: f.brokerOrderId });
        recorded = true;
      }
      if (!recorded && this.state.positions.includes(pos)) {
        this.state.positions = this.state.positions.filter((x) => x !== pos);
        this.audit("broker", "POSITION_VANISHED", `${pos.symbol} is no longer held at the broker and no sale was found – removed`, {});
      }
    }

    // Holdings we don't know about: adopt as external (unless our own buy is still being confirmed).
    for (const b of brokerPositions) {
      if (this.state.positions.some((p) => p.symbol === b.symbol)) continue;
      if (this.state.orders.some((o) => this.isOpenOrder(o) && o.request.side === "BUY" && o.request.symbol === b.symbol)) continue;
      this.state.positions.push({
        symbol: b.symbol,
        quantity: b.quantity,
        avgPrice: b.avgPriceGBP,
        costBasis: b.costGBP,
        stopPrice: 0,
        targetPrice: 0,
        openedAt: now,
        feesPaid: 0,
        external: true,
        markPrice: b.currentPriceGBP,
        markAt: now,
      });
      this.audit("broker", "EXTERNAL_POSITION", `${b.symbol} is held at the broker but wasn't bought by the app – shown, not managed`, {});
    }
  }

  /** Every managed position must have a stop-loss order resting at the broker. */
  private async ensureStops(now: number) {
    for (const pos of this.state.positions) {
      // Skip if protected already, being sold, or not currently showing at the broker.
      if (pos.external || pos.stopOrderId || pos.exitRecordId || pos.stopPrice <= 0 || pos.missingSince !== undefined) continue;
      const pendingStop = this.state.orders.find((o) => o.id === pos.stopRecordId && this.isOpenOrder(o));
      if (pendingStop) continue;
      const inst = this.md.instrument(pos.symbol);
      if (!inst) continue;
      const attempt = this.state.orders.filter((o) => o.request.clientOrderId.startsWith(`stop-${pos.symbol}-${pos.openedAt}`)).length;
      const rec = await this.execution.submit(
        {
          clientOrderId: `stop-${pos.symbol}-${pos.openedAt}-${attempt}`,
          symbol: pos.symbol,
          t212Ticker: inst.t212Ticker,
          side: "SELL",
          quantity: pos.quantity,
          type: "STOP",
          stopPrice: pos.stopPrice,
          timeValidity: "GOOD_TILL_CANCEL",
          reason: "STOP_LOSS",
          proposalId: pos.proposalId,
        },
        now,
      );
      pos.stopRecordId = rec.id;
      if (rec.status === "ACCEPTED" && rec.brokerOrderId) {
        pos.stopOrderId = rec.brokerOrderId;
        this.audit("broker", "STOP_PLACED", `${pos.symbol}: stop-loss placed at the broker at £${pos.stopPrice.toFixed(4)}`, { orderId: rec.id });
      } else if (rec.status !== "ERROR") {
        this.audit("risk", "STOP_NOT_PLACED", `${pos.symbol}: stop-loss could NOT be placed (${rec.reason ?? rec.status}) – will retry`, { orderId: rec.id });
      }
    }
  }

  // ------------------------------------------------------------------ exits

  private async manageExits(now: number) {
    for (const pos of [...this.state.positions]) {
      if (pos.external || pos.exitRecordId) continue;
      if (this.asyncBroker) {
        // The broker holds the stop. We only act on the target, using the broker's fresh price.
        const fresh = pos.markPrice !== undefined && pos.markAt !== undefined && now - pos.markAt < 5 * 60_000;
        if (fresh && pos.targetPrice > 0 && pos.markPrice! >= pos.targetPrice && this.market.isOpen(now)) {
          await this.exit(pos.symbol, "TAKE_PROFIT", now, "system").catch(() => undefined);
        }
        continue;
      }
      const q = this.md.quote(pos.symbol, now);
      const fresh = !!q && this.md.health(now).ok && now - q.asOf <= (this.opts.maxQuoteAgeMs ?? this.state.limits.maxDataAgeMs);
      if (!fresh) {
        if (!this.staleWarned.has(pos.symbol)) {
          this.staleWarned.add(pos.symbol);
          this.audit("risk", "EXIT_CHECK_SKIPPED", `${pos.symbol}: stop/target not checked – market data stale`, {});
        }
        continue;
      }
      this.staleWarned.delete(pos.symbol);
      let reason: TradeReason | undefined;
      if (pos.stopPrice > 0 && q.bid <= pos.stopPrice) reason = "STOP_LOSS";
      else if (pos.targetPrice > 0 && q.bid >= pos.targetPrice) reason = "TAKE_PROFIT";
      if (reason) await this.exit(pos.symbol, reason, now, "system");
    }
  }

  private async exit(symbol: string, reason: TradeReason, now: number, actor: AuditActor): Promise<Trade | undefined> {
    const pos = this.state.positions.find((p) => p.symbol === symbol);
    if (!pos) throw new EngineError(`No open position in ${symbol}`, "NOT_FOUND");
    if (pos.external) throw new EngineError(`${symbol} was opened outside the app – close it in Trading 212`, "CONFLICT");
    if (this.closing.has(symbol) || pos.exitRecordId) throw new EngineError(`${symbol} is already being closed`, "CONFLICT");
    const inst = this.md.instrument(symbol)!;
    this.closing.add(symbol);
    try {
      // Real broker: remove the resting stop first so the shares are free to sell.
      if (this.asyncBroker && pos.stopOrderId && this.broker.cancelOrder) {
        try {
          await this.broker.cancelOrder(pos.stopOrderId);
        } catch (e) {
          this.audit("broker", "EXIT_ABORTED", `${symbol}: couldn't cancel the stop-loss (${(e as Error).message.slice(0, 100)}) – not selling`, {});
          return undefined;
        }
        const stopRec = this.state.orders.find((o) => o.id === pos.stopRecordId);
        if (stopRec) { stopRec.status = "CANCELLED"; stopRec.resolvedAt = now; stopRec.reason = `Cancelled for ${reason}`; }
        pos.stopOrderId = undefined;
        pos.stopRecordId = undefined;
      }
      const attempt = this.state.orders.filter((o) => o.request.clientOrderId.startsWith(`exit-${symbol}-${pos.openedAt}`)).length;
      const rec = await this.execution.submit(
        { clientOrderId: `exit-${symbol}-${pos.openedAt}-${attempt}`, symbol, t212Ticker: inst.t212Ticker, side: "SELL", quantity: pos.quantity, type: "MARKET", reason },
        now,
      );
      if (rec.status === "FILLED" && rec.fill) {
        const t = applyFill(this.state, { orderId: rec.id, symbol, side: "SELL", fill: rec.fill, reason, simulated: rec.simulated, tradeId: newId("trd") });
        rec.resolvedAt = now;
        this.audit(actor === "user" ? "user" : "broker", "POSITION_CLOSED", `${reason.replace("_", " ")}: sold ${t.quantity} ${symbol} @ ${t.price} · P&L £${(t.realisedPnl ?? 0).toFixed(2)}`, { orderId: rec.id, reason, pnl: t.realisedPnl, simulated: rec.simulated });
        return t;
      }
      if (rec.status === "ACCEPTED" || (rec.status === "ERROR" && this.asyncBroker)) {
        pos.exitRecordId = rec.id;
        this.audit(actor === "user" ? "user" : "system", "EXIT_SUBMITTED", `${reason.replace("_", " ")}: sell order for ${symbol} sent – waiting for the fill`, { orderId: rec.id });
        return undefined;
      }
      this.audit("broker", "EXIT_NOT_FILLED", `${symbol} exit (${reason}) not filled: ${rec.reason ?? rec.status}`, { orderId: rec.id, status: rec.status });
      return undefined;
    } finally {
      this.closing.delete(symbol);
      if (this.asyncBroker) await this.ensureStops(now).catch(() => undefined); // re-protect if the sell didn't go out
      this.persist();
    }
  }

  // ------------------------------------------------------------------ scanning & proposals

  scanRows(now = this.clock()): ScanRow[] {
    return this.md.instruments().map((inst) => {
      const bars = this.md.bars(inst.symbol, 120);
      const quote = this.md.quote(inst.symbol, now);
      const signal = evaluateTrend(inst, bars, quote, now, this.opts.strategy ?? DEFAULT_STRATEGY);
      const first = bars[Math.max(0, bars.length - 41)]?.c ?? 0;
      const last = bars[bars.length - 1]?.c ?? 0;
      const problem = (this.md as { problem?: (s: string, t: number) => string | undefined }).problem?.(inst.symbol, now);
      return {
        instrument: inst,
        quote,
        changePct: first ? round(((last - first) / first) * 100, 2) : 0,
        sparkline: bars.slice(-40).map((b) => b.c),
        signal,
        blockedReason: problem,
      };
    });
  }

  private entryPrice(ask: number): number {
    const o = this.opts.entryOrder;
    if (!o || o.type === "MARKET") return ask;
    return round(ask * (1 + o.limitBufferBps / 10_000));
  }

  /** Run the scanner and create proposals for qualifying signals. In auto mode they execute immediately. */
  async scan(): Promise<ScanRow[]> {
    if (this.scanning) return this.lastRows;
    this.scanning = true;
    const now = this.clock();
    const toExecute: string[] = [];
    try {
      this.state.lastScanAt = now;
      const rows = this.scanRows(now);
      const cooldown = this.opts.cooldownMs ?? 5 * 60_000;
      const maxPending = this.opts.maxPendingProposals ?? 2;
      const halt = this.haltReasons(now);
      const entriesOpen = this.market.entriesAllowed(now);

      for (const row of rows) {
        const sym = row.instrument.symbol;
        if (row.signal.status !== "SIGNAL" || row.blockedReason) continue;
        if (halt.length) { row.blockedReason = halt[0]; continue; }
        if (!entriesOpen) { row.blockedReason = this.market.describe(now); continue; }
        if (this.state.positions.some((p) => p.symbol === sym)) { row.blockedReason = "Already holding"; continue; }
        if (this.state.orders.some((o) => this.isOpenOrder(o) && o.request.symbol === sym)) { row.blockedReason = "Order already working"; continue; }
        if (this.state.proposals.some((p) => p.symbol === sym && (p.status === "PENDING" || p.status === "APPROVED" || p.status === "SUBMITTED"))) { row.blockedReason = "Awaiting decision or fill"; continue; }
        const recent = this.state.proposals.find((p) => p.symbol === sym && p.decidedAt && now - p.decidedAt < cooldown && p.status !== "EXECUTED");
        if (recent) { row.blockedReason = "Cooling down after last decision"; continue; }
        if (this.state.proposals.filter((p) => p.status === "PENDING").length >= maxPending) { row.blockedReason = "Too many approvals waiting"; continue; }

        const q = row.quote!;
        const entry = this.entryPrice(q.ask);
        const cashForSizing = Math.min(this.state.cash, Math.max(0, this.state.limits.maxCapitalGBP - this.investedByApp()));
        const sizing = sizePosition({ instrument: row.instrument, entry, stop: row.signal.stop, target: row.signal.target, cash: cashForSizing, limits: this.state.limits, fees: this.fees });
        if (!sizing.ok) { row.blockedReason = sizing.reason; continue; }

        const draft = { symbol: sym, quantity: sizing.quantity, entryPrice: entry, stopPrice: row.signal.stop, estCosts: sizing.estCosts };
        const risk = validateEntry(this.riskContext(now, draft));
        if (!risk.approved) { row.blockedReason = `Risk: ${failedChecks(risk).map((c) => c.label).join("; ")}`; continue; }

        const explanation = await this.explainer.explain(
          {
            instrument: row.instrument,
            signal: row.signal,
            quantity: sizing.quantity,
            entryPrice: entry,
            stopPrice: row.signal.stop,
            targetPrice: row.signal.target,
            notionalGBP: sizing.notional,
            riskGBP: sizing.riskGBP,
            rewardGBP: sizing.rewardGBP,
            estCostsGBP: round(sizing.estCosts.explicitTotal + sizing.estCosts.spreadCost),
            risk,
            accountEquityGBP: this.equity(),
            dataSource: q.source,
          },
          now,
        );

        // State may have changed while the explanation was generated.
        if (this.state.emergencyStop.active || this.state.proposals.some((p) => p.symbol === sym && p.status === "PENDING")) continue;

        const created = this.clock();
        const proposal: Proposal = {
          id: newId("prop"),
          symbol: sym,
          instrumentName: row.instrument.name,
          side: "BUY",
          quantity: sizing.quantity,
          entryPrice: entry,
          stopPrice: row.signal.stop,
          targetPrice: row.signal.target,
          notionalGBP: sizing.notional,
          riskGBP: sizing.riskGBP,
          rewardGBP: sizing.rewardGBP,
          estCosts: sizing.estCosts,
          signal: row.signal,
          preTradeRisk: risk,
          explanation,
          createdAt: created,
          expiresAt: created + this.state.limits.proposalTtlMs,
          status: "PENDING",
          dataSource: q.source,
        };
        this.state.proposals.push(proposal);
        if (this.state.proposals.length > 200) this.state.proposals.splice(0, this.state.proposals.length - 200);
        const auto = this.state.autoTrade?.enabled === true;
        this.audit("strategy", "PROPOSAL_CREATED", `Suggested BUY ${proposal.quantity} ${sym} up to £${proposal.entryPrice} (risk £${proposal.riskGBP.toFixed(2)})${auto ? " – auto mode" : " – awaiting approval"}`, {
          proposalId: proposal.id,
          sizedBy: sizing.cappedBy,
          explanation: explanation.source,
          auto,
        });
        if (explanation.source === "CLAUDE") this.audit("ai", "AI_EXPLANATION", `Claude explained ${sym} proposal`, { model: explanation.model, costGBP: explanation.costGBP });
        else if (explanation.note) this.audit("ai", "AI_FALLBACK", explanation.note, {});
        if (auto) toExecute.push(proposal.id);
      }
      this.lastRows = rows;
    } finally {
      this.scanning = false;
      this.persist();
    }
    // Auto mode: execute through exactly the same path as a manual approval (full risk re-check).
    for (const id of toExecute) await this.approve(id, "auto").catch(() => undefined);
    return this.lastRows;
  }

  // ------------------------------------------------------------------ decisions

  /**
   * Approval of a single proposal (by you, or by auto mode). Re-validates risk,
   * then submits exactly one order (idempotent on the proposal id).
   */
  async approve(id: string, by: "user" | "auto" = "user"): Promise<Proposal> {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new EngineError("Proposal not found", "NOT_FOUND");
    if (p.status === "EXECUTED" || p.status === "SUBMITTED") return p; // already done – no second order
    if (this.approving.has(id)) throw new EngineError("Approval already in progress", "CONFLICT");
    if (p.status !== "PENDING") throw new EngineError(`Proposal is ${p.status.toLowerCase()}`, "CONFLICT");
    if (by === "auto" && !this.state.autoTrade?.enabled) throw new EngineError("Auto mode is off", "CONFLICT");

    const now = this.clock();
    if (now > p.expiresAt) {
      p.status = "EXPIRED";
      p.decidedAt = now;
      p.statusReason = "Approval arrived after expiry";
      this.audit("user", "APPROVAL_TOO_LATE", `${p.symbol} approval rejected: proposal had expired`, { proposalId: id });
      this.persist();
      throw new EngineError("This proposal has expired", "EXPIRED");
    }

    this.approving.set(id, p.symbol);
    p.status = "APPROVED";
    p.decidedAt = now;
    this.audit(by === "auto" ? "system" : "user", "PROPOSAL_APPROVED", by === "auto" ? `Auto mode approved BUY ${p.quantity} ${p.symbol}` : `You approved BUY ${p.quantity} ${p.symbol}`, { proposalId: id, by });
    try {
      const decision = validateEntry(this.riskContext(now, p, p.entryPrice, id));
      if (!decision.approved) {
        p.status = "BLOCKED";
        p.statusReason = failedChecks(decision).map((c) => `${c.label} (${c.detail})`).join("; ");
        this.audit("risk", "ORDER_BLOCKED", `Risk re-check blocked ${p.symbol}: ${p.statusReason}`, { proposalId: id, failed: failedChecks(decision).map((c) => c.id) });
        return p;
      }
      const inst = this.md.instrument(p.symbol)!;
      const limit = this.opts.entryOrder?.type === "LIMIT";
      const rec = await this.execution.submit(
        {
          clientOrderId: `entry-${p.id}`,
          symbol: p.symbol,
          t212Ticker: inst.t212Ticker,
          side: "BUY",
          quantity: p.quantity,
          type: limit ? "LIMIT" : "MARKET",
          limitPrice: limit ? p.entryPrice : undefined,
          timeValidity: limit ? "DAY" : undefined,
          reason: "ENTRY",
          proposalId: p.id,
        },
        now,
      );
      p.orderId = rec.id;
      if (rec.status === "FILLED" && rec.fill) {
        rec.resolvedAt = now;
        const t = applyFill(this.state, { orderId: rec.id, symbol: p.symbol, side: "BUY", fill: rec.fill, reason: "ENTRY", stop: p.stopPrice, target: p.targetPrice, proposalId: p.id, simulated: rec.simulated, tradeId: newId("trd") });
        this.state.daily.entries++;
        p.status = "EXECUTED";
        this.audit("broker", "ORDER_FILLED", `${rec.simulated ? "Simulated fill" : "Fill"}: bought ${t.quantity} ${p.symbol} @ ${t.price}`, { orderId: rec.id, brokerOrderId: rec.brokerOrderId, simulated: rec.simulated });
      } else if (rec.status === "ACCEPTED") {
        this.state.daily.entries++;
        p.status = "SUBMITTED";
        p.statusReason = "Order placed – waiting for the fill";
        this.audit("broker", "ORDER_ACCEPTED", `Buy order for ${p.symbol} placed at the broker (limit £${p.entryPrice}); holdings update when it fills`, { orderId: rec.id, brokerOrderId: rec.brokerOrderId });
      } else if (rec.status === "ERROR" && this.asyncBroker) {
        // Unknown outcome: the order may exist. Never resend – reconcile instead.
        this.state.daily.entries++;
        p.status = "SUBMITTED";
        p.statusReason = "Checking with the broker whether the order was placed";
        this.audit("broker", "ORDER_UNCERTAIN", `${p.symbol}: broker error (${rec.reason}); checking whether the order exists before doing anything else`, { orderId: rec.id });
      } else {
        rec.resolvedAt = now;
        p.status = "BLOCKED";
        p.statusReason = `Broker: ${rec.reason ?? rec.status}`;
        this.audit("broker", "ORDER_REJECTED", `Order for ${p.symbol} not placed: ${rec.reason ?? rec.status}`, { orderId: rec.id });
      }
      return p;
    } finally {
      this.approving.delete(id);
      this.persist();
    }
  }

  reject(id: string, reason = "Rejected by you"): Proposal {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new EngineError("Proposal not found", "NOT_FOUND");
    if (p.status !== "PENDING") throw new EngineError(`Proposal is ${p.status.toLowerCase()}`, "CONFLICT");
    p.status = "REJECTED";
    p.decidedAt = this.clock();
    p.statusReason = reason;
    this.audit("user", "PROPOSAL_REJECTED", `You rejected ${p.symbol}`, { proposalId: id });
    this.persist();
    return p;
  }

  async closePosition(symbol: string): Promise<Trade | undefined> {
    return this.exit(symbol, "MANUAL_CLOSE", this.clock(), "user");
  }

  async closeAll(): Promise<number> {
    let n = 0;
    for (const p of [...this.state.positions]) {
      if (p.external) continue;
      const t = await this.exit(p.symbol, "EMERGENCY_CLOSE", this.clock(), "user").catch(() => undefined);
      if (t || this.state.positions.find((x) => x.symbol === p.symbol)?.exitRecordId) n++;
    }
    return n;
  }

  private engageEmergencyStop(reason: string, actor: AuditActor, now: number) {
    this.state.emergencyStop = { active: true, reason, since: now };
    for (const p of this.state.proposals) {
      if (p.status === "PENDING") {
        p.status = "CANCELLED";
        p.decidedAt = now;
        p.statusReason = "Emergency stop";
      }
    }
    this.audit(actor, "EMERGENCY_STOP_ON", `Emergency stop engaged: ${reason}`, {});
    // Cancel buy orders still waiting at the broker (stop-losses stay in place).
    if (this.asyncBroker && this.broker.cancelOrder) {
      for (const o of this.state.orders.filter((x) => this.isOpenOrder(x) && x.request.side === "BUY" && x.brokerOrderId)) {
        void this.broker.cancelOrder(o.brokerOrderId!).then(
          () => this.audit("broker", "ORDER_CANCEL_REQUESTED", `${o.request.symbol}: pending buy cancelled (emergency stop)`, { orderId: o.id }),
          (e) => this.audit("broker", "ORDER_CANCEL_FAILED", `${o.request.symbol}: couldn't cancel pending buy – ${(e as Error).message.slice(0, 100)}`, { orderId: o.id }),
        );
      }
    }
  }

  setEmergencyStop(active: boolean, opts: { reason?: string; confirm?: string } = {}): EngineState["emergencyStop"] {
    const now = this.clock();
    if (active) {
      if (!this.state.emergencyStop.active) this.engageEmergencyStop(opts.reason ?? "Engaged by you", "user", now);
    } else if (this.state.emergencyStop.active) {
      if (opts.confirm !== RESUME_PHRASE) throw new EngineError(`Type ${RESUME_PHRASE} to release the emergency stop`, "INVALID");
      if (this.equity() <= this.state.limits.equityFloorGBP) throw new EngineError("Equity is below the floor – cannot resume", "CONFLICT");
      this.state.emergencyStop = { active: false };
      this.audit("user", "EMERGENCY_STOP_OFF", "Emergency stop released by you", {});
    }
    this.persist();
    return this.state.emergencyStop;
  }

  /** Auto mode: proposals execute without waiting for you. Turning it on needs the typed phrase. */
  setAutoTrade(enabled: boolean, confirm?: string): { enabled: boolean; since?: number } {
    if (enabled && !this.state.autoTrade?.enabled) {
      if (confirm !== AUTO_PHRASE) throw new EngineError(`Type ${AUTO_PHRASE} to turn on auto mode`, "INVALID");
      this.state.autoTrade = { enabled: true, since: this.clock() };
      this.audit("user", "AUTO_MODE_ON", `Auto mode turned ON – trades will execute without approval${this.isLive ? " (REAL MONEY)" : ""}`, {});
    } else if (!enabled && this.state.autoTrade?.enabled) {
      this.state.autoTrade = { enabled: false };
      this.audit("user", "AUTO_MODE_OFF", "Auto mode turned off – trades need your approval again", {});
    }
    this.persist();
    return this.state.autoTrade!;
  }

  /** Tighten-only limit changes from the app. */
  updateLimits(patch: Partial<RiskLimits>): RiskLimits {
    try {
      this.state.limits = tightenLimits(this.state.limits, patch);
    } catch (e) {
      throw new EngineError((e as Error).message, "INVALID");
    }
    this.audit("user", "LIMITS_TIGHTENED", "Risk limits tightened", { patch });
    this.persist();
    return this.state.limits;
  }

  // ------------------------------------------------------------------ read model

  snapshot(): DashboardSnapshot {
    const now = this.clock();
    const s = this.state;
    const positions = positionViews(s, this.md);
    const invested = round(positions.reduce((a, p) => a + p.marketValue, 0));
    const unrealised = round(positions.reduce((a, p) => a + p.unrealisedPnl, 0));
    const fromBroker = this.asyncBroker && !!s.brokerAccount;
    const equity = fromBroker ? s.brokerAccount!.totalValueGBP : round(s.cash + invested);
    const realised = realisedTotal(s);
    const totalPnl = round(equity - s.startingCapitalGBP);
    const goal = this.opts.goalGBP ?? 1000;
    const tradingTotal = round(s.costs.commission + s.costs.fxFee + s.costs.stampDuty + s.costs.spreadCost);
    const halt = this.haltReasons(now);
    const rows = this.lastRows.length ? this.lastRows : this.scanRows(now);
    return {
      generatedAt: now,
      mode: this.opts.tradingMode,
      liveTradingEnabled: this.isLive && !!this.opts.liveArmed,
      dataHealth: this.md.health(now),
      broker: { name: this.broker.name, environment: this.broker.environment },
      explainer: this.explainer.name,
      market: { open: this.market.isOpen(now), entriesAllowed: this.market.entriesAllowed(now), detail: this.market.describe(now) },
      autoTrade: s.autoTrade ?? { enabled: false },
      account: {
        source: fromBroker ? "broker" : "simulated",
        syncedAt: s.brokerAccount?.syncedAt,
        startingCapital: s.startingCapitalGBP,
        cash: s.cash,
        invested: fromBroker ? s.brokerAccount!.investedGBP : invested,
        equity,
        unrealisedPnl: unrealised,
        realisedPnl: realised,
        totalPnl,
        totalPnlPct: s.startingCapitalGBP ? round((totalPnl / s.startingCapitalGBP) * 100, 2) : 0,
        dayPnl: round(equity - s.daily.startEquity),
        goalGBP: goal,
        goalProgressPct: round(Math.max(0, Math.min(100, ((equity - s.startingCapitalGBP) / Math.max(1, goal - s.startingCapitalGBP)) * 100)), 2),
      },
      positions,
      pending: s.proposals.filter((p) => p.status === "PENDING" || p.status === "APPROVED").reverse(),
      recentProposals: s.proposals.filter((p) => p.status !== "PENDING").slice(-30).reverse(),
      scanner: rows,
      trades: s.trades.slice(-100).reverse(),
      orders: s.orders.slice(-50).reverse(),
      openOrders: s.orders.filter((o) => this.isOpenOrder(o)),
      equityHistory: [...s.equityHistory.slice(-400), { t: now, equity, cash: s.cash }],
      costs: { ...s.costs, tradingTotal, tradingPctOfCapital: round((tradingTotal / Math.max(1, s.startingCapitalGBP)) * 100, 3) },
      limits: s.limits,
      ceilings: { ...HARD_CEILINGS },
      emergencyStop: s.emergencyStop,
      halted: { active: halt.length > 0, reasons: halt },
      warnings: this.warnings(),
      entriesToday: s.daily.entries,
      audit: s.audit.slice(-150).reverse(),
      auditIntegrity: verifyAudit(s.audit),
      lastScanAt: s.lastScanAt,
      nextScanAt: s.lastScanAt + (this.opts.scanIntervalMs ?? 30_000),
    };
  }
}
