import { appendAudit, verifyAudit } from "./audit/auditLog";
import { FallbackExplainer, type AiBudget, type TradeExplainer } from "./ai/explainer";
import { TemplateExplainer } from "./ai/templateExplainer";
import type { BrokerAdapter } from "./execution/broker";
import { ExecutionService } from "./execution/executionService";
import type { FeeModel } from "./fees/feeModel";
import type { MarketDataProvider } from "./marketdata/provider";
import { applyFill, equityOf, positionViews, realisedTotal, type PositionView } from "./portfolio/ledger";
import { DEFAULT_LIMITS, HARD_CEILINGS, clampToCeilings, isTightening, tightenLimits } from "./risk/limits";
import { failedChecks, validateEntry } from "./risk/riskEngine";
import { sizePosition } from "./risk/sizing";
import { evaluateTrend } from "./strategy/trendPullback";
import type {
  AuditActor,
  AuditEntry,
  CostTotals,
  DataHealth,
  EngineState,
  EquityPoint,
  OrderRecord,
  OrderRequest,
  Proposal,
  RiskLimits,
  ScanRow,
  Trade,
  TradeReason,
} from "./types";
import { newId } from "./util/ids";
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
  /** Must be "demo". Anything else makes every entry fail risk validation. */
  tradingMode: string;
  limits?: Partial<RiskLimits>;
  startingCapitalGBP?: number;
  scanIntervalMs?: number;
  /** Don't re-propose the same ETF within this window after a reject/expiry. */
  cooldownMs?: number;
  maxPendingProposals?: number;
  goalGBP?: number;
  onAudit?: (e: AuditEntry) => void;
}

export interface DashboardSnapshot {
  generatedAt: number;
  mode: string;
  liveTradingEnabled: false;
  dataHealth: DataHealth;
  broker: { name: string; environment: string };
  explainer: string;
  account: {
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
  equityHistory: EquityPoint[];
  costs: CostTotals & { tradingTotal: number; tradingPctOfCapital: number };
  limits: RiskLimits;
  ceilings: RiskLimits;
  emergencyStop: EngineState["emergencyStop"];
  halted: { active: boolean; reasons: string[] };
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
export const RESUME_PHRASE = "RESUME";

export class CopilotEngine {
  state: EngineState;
  private readonly md: MarketDataProvider;
  private readonly fees: FeeModel;
  private readonly clock: () => number;
  private readonly store?: StateStore;
  private readonly explainer: TradeExplainer;
  private readonly execution: ExecutionService;
  private readonly brokerInfo: { name: string; environment: string };
  private readonly allowed: Set<string>;
  private readonly approving = new Map<string, string>(); // proposalId -> symbol
  private readonly closing = new Set<string>();
  private readonly staleWarned = new Set<string>();
  private scanning = false;
  private lastRows: ScanRow[] = [];

  constructor(private readonly opts: EngineOptions) {
    this.md = opts.md;
    this.fees = opts.fees;
    this.clock = opts.clock ?? (() => Date.now());
    this.store = opts.store;
    this.allowed = new Set(opts.md.instruments().filter((i) => i.type === "ETF").map((i) => i.symbol));
    this.brokerInfo = { name: opts.broker.name, environment: opts.broker.environment };

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
      };
      this.audit("system", "ACCOUNT_CREATED", `Simulated account opened with £${capital.toFixed(2)}`, { capital, mode: opts.tradingMode });
    }

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
        if (this.state.orders.length > 500) this.state.orders.splice(0, this.state.orders.length - 500);
      },
      () => newId("ord"),
    );
    this.persist();
  }

  // ------------------------------------------------------------------ helpers

  private audit(actor: AuditActor, type: string, message: string, data?: Record<string, unknown>) {
    const e = appendAudit(this.state.audit, this.clock(), actor, type, message, data);
    this.opts.onAudit?.(e);
  }

  private persist() {
    this.store?.save(this.state);
  }

  private rollDay(now: number) {
    const day = dayKey(now);
    if (this.state.daily.day !== day) {
      this.state.daily = { day, entries: 0, startEquity: this.equity(), aiCostGBP: 0, aiCalls: 0 };
    }
  }

  equity(): number {
    return equityOf(this.state, this.md);
  }

  private haltReasons(now: number): string[] {
    const reasons: string[] = [];
    const l = this.state.limits;
    if (this.opts.tradingMode !== "demo") reasons.push("Not in demo mode");
    if (this.state.emergencyStop.active) reasons.push(`Emergency stop: ${this.state.emergencyStop.reason ?? "engaged"}`);
    const h = this.md.health(now);
    if (!h.ok) reasons.push(`Market data unavailable: ${h.detail}`);
    const dayPnl = this.equity() - this.state.daily.startEquity;
    if (dayPnl <= -l.maxDailyLossGBP) reasons.push(`Daily loss limit reached (£${dayPnl.toFixed(2)})`);
    if (this.state.daily.entries >= l.maxTradesPerDay) reasons.push("Daily trade limit reached");
    return reasons;
  }

  private riskContext(now: number, p: Pick<Proposal, "symbol" | "quantity" | "entryPrice" | "stopPrice" | "estCosts">, proposedPrice?: number, excludeProposalId?: string) {
    const inFlight = new Set<string>();
    for (const [pid, sym] of this.approving) if (pid !== excludeProposalId) inFlight.add(sym);
    return {
      now,
      tradingMode: this.opts.tradingMode,
      limits: this.state.limits,
      emergencyStopActive: this.state.emergencyStop.active,
      instrument: this.md.instrument(p.symbol),
      allowedSymbols: this.allowed,
      quote: this.md.quote(p.symbol),
      dataHealth: this.md.health(now),
      order: { symbol: p.symbol, side: "BUY" as const, quantity: p.quantity, entryPrice: p.entryPrice, stopPrice: p.stopPrice, estCosts: p.estCosts, proposedPrice },
      cash: this.state.cash,
      equity: this.equity(),
      dayStartEquity: this.state.daily.startEquity,
      entriesToday: this.state.daily.entries,
      positions: this.state.positions,
      openOrders: this.state.orders,
      inFlightSymbols: inFlight,
    };
  }

  // ------------------------------------------------------------------ main loop

  /** Advance market data, expire approvals, run protective exits and (when due) a scan. */
  async tick(): Promise<void> {
    const now = this.clock();
    this.md.tick(now);
    this.rollDay(now);
    this.expireProposals(now);
    await this.protectiveExits(now);
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
    if (!this.state.emergencyStop.active && eq <= this.state.limits.equityFloorGBP) {
      this.engageEmergencyStop(`Equity £${eq.toFixed(2)} hit the £${this.state.limits.equityFloorGBP.toFixed(2)} floor`, "risk", now);
    }
  }

  private recordEquity(now: number) {
    const h = this.state.equityHistory;
    const last = h[h.length - 1];
    if (last && now - last.t < EQUITY_SAMPLE_MS) return;
    h.push({ t: now, equity: this.equity(), cash: this.state.cash });
    if (h.length > MAX_EQUITY_POINTS) {
      // Thin the older half so long histories stay small.
      const half = Math.floor(h.length / 2);
      const older = h.slice(0, half).filter((_, i) => i % 2 === 0);
      this.state.equityHistory = [...older, ...h.slice(half)];
    }
  }

  /** Stop-loss and take-profit exits that were part of the approved plan. They only reduce exposure. */
  private async protectiveExits(now: number) {
    for (const pos of [...this.state.positions]) {
      const q = this.md.quote(pos.symbol);
      const fresh = !!q && this.md.health(now).ok && now - q.asOf <= this.state.limits.maxDataAgeMs;
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
    if (this.closing.has(symbol)) throw new EngineError(`${symbol} is already being closed`, "CONFLICT");
    const inst = this.md.instrument(symbol)!;
    this.closing.add(symbol);
    try {
      const req: OrderRequest = {
        clientOrderId: `exit-${pos.proposalId ?? symbol}-${pos.openedAt}`,
        symbol,
        t212Ticker: inst.t212Ticker,
        side: "SELL",
        quantity: pos.quantity,
        type: "MARKET",
        reason,
      };
      const rec = await this.execution.submit(req, now);
      if (rec.status === "FILLED" && rec.fill) {
        const t = applyFill(this.state, { orderId: rec.id, symbol, side: "SELL", fill: rec.fill, reason, simulated: rec.simulated, tradeId: newId("trd") });
        this.audit(actor === "user" ? "user" : "broker", "POSITION_CLOSED", `${reason.replace("_", " ")}: sold ${t.quantity} ${symbol} @ ${t.price} · P&L £${(t.realisedPnl ?? 0).toFixed(2)}`, { orderId: rec.id, reason, pnl: t.realisedPnl, simulated: rec.simulated });
        return t;
      }
      this.audit("broker", "EXIT_NOT_FILLED", `${symbol} exit (${reason}) not filled: ${rec.reason ?? rec.status}`, { orderId: rec.id, status: rec.status });
      return undefined;
    } finally {
      this.closing.delete(symbol);
      this.persist();
    }
  }

  // ------------------------------------------------------------------ scanning & proposals

  scanRows(now = this.clock()): ScanRow[] {
    return this.md.instruments().map((inst) => {
      const bars = this.md.bars(inst.symbol, 120);
      const quote = this.md.quote(inst.symbol);
      const signal = evaluateTrend(inst, bars, quote, now);
      const first = bars[Math.max(0, bars.length - 41)]?.c ?? 0;
      const last = bars[bars.length - 1]?.c ?? 0;
      return {
        instrument: inst,
        quote,
        changePct: first ? round(((last - first) / first) * 100, 2) : 0,
        sparkline: bars.slice(-40).map((b) => b.c),
        signal,
      };
    });
  }

  /** Run the scanner and create approval requests for qualifying signals. Never places orders. */
  async scan(): Promise<ScanRow[]> {
    if (this.scanning) return this.lastRows;
    this.scanning = true;
    const now = this.clock();
    try {
      this.state.lastScanAt = now;
      const rows = this.scanRows(now);
      const cooldown = this.opts.cooldownMs ?? 5 * 60_000;
      const maxPending = this.opts.maxPendingProposals ?? 2;
      const halt = this.haltReasons(now);

      for (const row of rows) {
        const sym = row.instrument.symbol;
        if (row.signal.status !== "SIGNAL") continue;
        if (halt.length) { row.blockedReason = halt[0]; continue; }
        if (this.state.positions.some((p) => p.symbol === sym)) { row.blockedReason = "Already holding"; continue; }
        if (this.state.proposals.some((p) => p.symbol === sym && (p.status === "PENDING" || p.status === "APPROVED"))) { row.blockedReason = "Awaiting your decision"; continue; }
        const recent = this.state.proposals.find((p) => p.symbol === sym && p.decidedAt && now - p.decidedAt < cooldown && p.status !== "EXECUTED");
        if (recent) { row.blockedReason = "Cooling down after last decision"; continue; }
        if (this.state.proposals.filter((p) => p.status === "PENDING").length >= maxPending) { row.blockedReason = "Too many approvals waiting"; continue; }

        const q = row.quote!;
        const sizing = sizePosition({ instrument: row.instrument, entry: q.ask, stop: row.signal.stop, target: row.signal.target, cash: this.state.cash, limits: this.state.limits, fees: this.fees });
        if (!sizing.ok) { row.blockedReason = sizing.reason; continue; }

        const draft = { symbol: sym, quantity: sizing.quantity, entryPrice: q.ask, stopPrice: row.signal.stop, estCosts: sizing.estCosts };
        const risk = validateEntry(this.riskContext(now, draft));
        if (!risk.approved) { row.blockedReason = `Risk: ${failedChecks(risk).map((c) => c.label).join("; ")}`; continue; }

        const explanation = await this.explainer.explain(
          {
            instrument: row.instrument,
            signal: row.signal,
            quantity: sizing.quantity,
            entryPrice: q.ask,
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
          entryPrice: q.ask,
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
        this.audit("strategy", "PROPOSAL_CREATED", `Suggested BUY ${proposal.quantity} ${sym} @ ${proposal.entryPrice} (risk £${proposal.riskGBP.toFixed(2)}) – awaiting approval`, {
          proposalId: proposal.id,
          sizedBy: sizing.cappedBy,
          explanation: explanation.source,
        });
        if (explanation.source === "CLAUDE") this.audit("ai", "AI_EXPLANATION", `Claude explained ${sym} proposal`, { model: explanation.model, costGBP: explanation.costGBP });
        else if (explanation.note) this.audit("ai", "AI_FALLBACK", explanation.note, {});
      }
      this.lastRows = rows;
      return rows;
    } finally {
      this.scanning = false;
      this.persist();
    }
  }

  // ------------------------------------------------------------------ user decisions

  /**
   * Explicit user approval of a single proposal. Re-validates risk against a
   * fresh quote, then submits exactly one order (idempotent on the proposal id).
   */
  async approve(id: string): Promise<Proposal> {
    const p = this.state.proposals.find((x) => x.id === id);
    if (!p) throw new EngineError("Proposal not found", "NOT_FOUND");
    if (p.status === "EXECUTED" || p.status === "SUBMITTED") return p; // already done – no second order
    if (this.approving.has(id)) throw new EngineError("Approval already in progress", "CONFLICT");
    if (p.status !== "PENDING") throw new EngineError(`Proposal is ${p.status.toLowerCase()}`, "CONFLICT");

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
    this.audit("user", "PROPOSAL_APPROVED", `You approved BUY ${p.quantity} ${p.symbol}`, { proposalId: id });
    try {
      const decision = validateEntry(this.riskContext(now, p, p.entryPrice, id));
      if (!decision.approved) {
        p.status = "BLOCKED";
        p.statusReason = failedChecks(decision).map((c) => `${c.label} (${c.detail})`).join("; ");
        this.audit("risk", "ORDER_BLOCKED", `Risk re-check blocked ${p.symbol}: ${p.statusReason}`, { proposalId: id, failed: failedChecks(decision).map((c) => c.id) });
        return p;
      }
      const inst = this.md.instrument(p.symbol)!;
      const rec = await this.execution.submit(
        { clientOrderId: `entry-${p.id}`, symbol: p.symbol, t212Ticker: inst.t212Ticker, side: "BUY", quantity: p.quantity, type: "MARKET", reason: "ENTRY", proposalId: p.id },
        now,
      );
      p.orderId = rec.id;
      if (rec.status === "FILLED" && rec.fill) {
        const t = applyFill(this.state, { orderId: rec.id, symbol: p.symbol, side: "BUY", fill: rec.fill, reason: "ENTRY", stop: p.stopPrice, target: p.targetPrice, proposalId: p.id, simulated: rec.simulated, tradeId: newId("trd") });
        this.state.daily.entries++;
        p.status = "EXECUTED";
        this.audit("broker", "ORDER_FILLED", `${rec.simulated ? "Simulated fill" : "Fill"}: bought ${t.quantity} ${p.symbol} @ ${t.price}`, { orderId: rec.id, brokerOrderId: rec.brokerOrderId, simulated: rec.simulated });
      } else if (rec.status === "ACCEPTED") {
        this.state.daily.entries++;
        p.status = "SUBMITTED";
        p.statusReason = "Accepted by broker – waiting for fill confirmation";
        this.audit("broker", "ORDER_ACCEPTED", `Order for ${p.symbol} accepted; holdings update only after a confirmed fill`, { orderId: rec.id });
      } else {
        p.status = "BLOCKED";
        p.statusReason = `Broker: ${rec.reason ?? rec.status}`;
        this.audit("broker", "ORDER_REJECTED", `Order for ${p.symbol} not filled: ${rec.reason ?? rec.status}`, { orderId: rec.id });
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
      const t = await this.exit(p.symbol, "EMERGENCY_CLOSE", this.clock(), "user").catch(() => undefined);
      if (t) n++;
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
    const equity = round(s.cash + invested);
    const realised = realisedTotal(s);
    const totalPnl = round(equity - s.startingCapitalGBP);
    const goal = this.opts.goalGBP ?? 1000;
    const tradingTotal = round(s.costs.commission + s.costs.fxFee + s.costs.stampDuty + s.costs.spreadCost);
    const halt = this.haltReasons(now);
    const rows = this.lastRows.length ? this.lastRows : this.scanRows(now);
    return {
      generatedAt: now,
      mode: this.opts.tradingMode,
      liveTradingEnabled: false,
      dataHealth: this.md.health(now),
      broker: this.brokerInfo,
      explainer: this.explainer.name,
      account: {
        startingCapital: s.startingCapitalGBP,
        cash: s.cash,
        invested,
        equity,
        unrealisedPnl: unrealised,
        realisedPnl: realised,
        totalPnl,
        totalPnlPct: round((totalPnl / s.startingCapitalGBP) * 100, 2),
        dayPnl: round(equity - s.daily.startEquity),
        goalGBP: goal,
        goalProgressPct: round(Math.max(0, Math.min(100, ((equity - s.startingCapitalGBP) / (goal - s.startingCapitalGBP)) * 100)), 2),
      },
      positions,
      pending: s.proposals.filter((p) => p.status === "PENDING" || p.status === "APPROVED").reverse(),
      recentProposals: s.proposals.filter((p) => p.status !== "PENDING").slice(-30).reverse(),
      scanner: rows,
      trades: s.trades.slice(-100).reverse(),
      orders: s.orders.slice(-50).reverse(),
      equityHistory: [...s.equityHistory.slice(-400), { t: now, equity, cash: s.cash }],
      costs: { ...s.costs, tradingTotal, tradingPctOfCapital: round((tradingTotal / s.startingCapitalGBP) * 100, 3) },
      limits: s.limits,
      ceilings: { ...HARD_CEILINGS },
      emergencyStop: s.emergencyStop,
      halted: { active: halt.length > 0, reasons: halt },
      entriesToday: s.daily.entries,
      audit: s.audit.slice(-150).reverse(),
      auditIntegrity: verifyAudit(s.audit),
      lastScanAt: s.lastScanAt,
      nextScanAt: s.lastScanAt + (this.opts.scanIntervalMs ?? 30_000),
    };
  }
}
