// Shared domain types. Everything in src/core is environment-agnostic
// (no Node or browser APIs) so it can run on the server and in the preview.

/** Where a price came from. Phase 1 only ever produces SIMULATED. */
export type DataSource = "SIMULATED" | "LIVE";

export interface Instrument {
  symbol: string; // LSE ticker, e.g. "VUSA"
  /** Trading 212 ticker. Must be verified against /equity/metadata/instruments before any broker use. */
  t212Ticker: string;
  name: string;
  type: "ETF";
  currency: "GBP";
  exchange: "LSE";
  category: string;
  /** Typical quoted spread in basis points (simulated assumption). */
  spreadBps: number;
  /** Typical daily traded value in £m (simulated assumption, used by the liquidity rule). */
  avgDailyValueGBPm: number;
  /** Fractional quantity precision supported for orders. */
  qtyDecimals: number;
}

export interface Bar {
  t: number; // bar close time, epoch ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  mid: number;
  asOf: number; // epoch ms
  source: DataSource;
}

export interface DataHealth {
  source: DataSource;
  ok: boolean;
  lastUpdate: number;
  detail: string;
}

// ---------- Strategy ----------

export interface RuleCheck {
  id: string;
  label: string;
  passed: boolean;
  /** Human-readable value vs threshold, e.g. "RSI 58.2 (needs 50–70)". */
  detail: string;
}

export type ScanStatus = "SIGNAL" | "WATCH" | "NO_SETUP" | "INSUFFICIENT_DATA";

export interface Signal {
  symbol: string;
  side: "BUY";
  status: ScanStatus;
  strategy: string;
  price: number;
  rules: RuleCheck[];
  score: number; // passed / total, 0..1
  indicators: Record<string, number>;
  /** Suggested protective stop and target (only meaningful when status === SIGNAL). */
  stop: number;
  target: number;
  generatedAt: number;
}

export interface ScanRow {
  instrument: Instrument;
  quote?: Quote;
  changePct: number;
  sparkline: number[];
  signal: Signal;
  /** Why no proposal was created even if the signal fired. */
  blockedReason?: string;
}

// ---------- Risk ----------

export interface RiskLimits {
  /** Max loss if the stop is hit, including estimated costs. */
  maxRiskPerTradeGBP: number;
  /** Max value of a single position (fixed £, never scales with the balance). */
  maxPositionValueGBP: number;
  maxOpenPositions: number;
  maxTradesPerDay: number;
  /** Realised + unrealised loss today that halts new entries. */
  maxDailyLossGBP: number;
  /** Equity floor: if equity drops below this, emergency stop engages automatically. */
  equityFloorGBP: number;
  minOrderValueGBP: number;
  /** Estimated round-trip costs must be at most this fraction of the risk taken. */
  maxCostToRiskRatio: number;
  /** Quotes older than this are stale and block trading. */
  maxDataAgeMs: number;
  /** At execution, price may not have moved more than this from the proposal. */
  maxPriceDriftBps: number;
  /** How long an approval request stays valid. */
  proposalTtlMs: number;
}

export interface RiskCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  checks: RiskCheck[];
  evaluatedAt: number;
}

// ---------- Fees ----------

export interface FeeBreakdown {
  commission: number;
  fxFee: number;
  stampDuty: number;
  /** Explicit fees charged to cash. */
  explicitTotal: number;
  /** Estimated implicit cost of crossing the spread (already in the fill price). */
  spreadCost: number;
}

// ---------- AI ----------

export interface Explanation {
  source: "CLAUDE" | "TEMPLATE";
  model?: string;
  summary: string;
  whyNow: string[];
  risks: string[];
  invalidation: string;
  generatedAt: number;
  costGBP: number;
  note?: string;
}

// ---------- Proposals & orders ----------

export type ProposalStatus =
  | "PENDING"
  | "APPROVED" // user approved; execution in progress
  | "EXECUTED" // fill confirmed by broker
  | "SUBMITTED" // broker accepted the order, fill not yet confirmed
  | "REJECTED" // user rejected
  | "EXPIRED"
  | "BLOCKED" // failed risk re-validation at approval time
  | "CANCELLED"; // e.g. emergency stop

export interface Proposal {
  id: string;
  symbol: string;
  instrumentName: string;
  side: "BUY";
  quantity: number;
  entryPrice: number; // ask at proposal time
  stopPrice: number;
  targetPrice: number;
  notionalGBP: number;
  riskGBP: number; // incl. estimated costs
  rewardGBP: number;
  estCosts: FeeBreakdown; // round trip estimate
  signal: Signal;
  preTradeRisk: RiskDecision;
  explanation: Explanation;
  createdAt: number;
  expiresAt: number;
  status: ProposalStatus;
  decidedAt?: number;
  statusReason?: string;
  orderId?: string;
  dataSource: DataSource;
}

export type OrderStatus = "FILLED" | "ACCEPTED" | "REJECTED" | "ERROR";
export type TradeReason = "ENTRY" | "STOP_LOSS" | "TAKE_PROFIT" | "MANUAL_CLOSE" | "EMERGENCY_CLOSE";

export interface OrderRequest {
  clientOrderId: string; // idempotency key
  symbol: string;
  t212Ticker: string;
  side: "BUY" | "SELL";
  quantity: number;
  type: "MARKET" | "LIMIT";
  limitPrice?: number;
  reason: TradeReason;
  proposalId?: string;
}

export interface BrokerFill {
  price: number;
  quantity: number;
  at: number;
  fees: FeeBreakdown;
}

export interface BrokerOrderResult {
  status: OrderStatus;
  brokerOrderId?: string;
  fill?: BrokerFill;
  reason?: string;
  simulated: boolean;
}

export interface OrderRecord {
  id: string;
  request: OrderRequest;
  status: OrderStatus;
  brokerOrderId?: string;
  broker: string;
  submittedAt: number;
  fill?: BrokerFill;
  reason?: string;
  simulated: boolean;
}

export interface Position {
  symbol: string;
  quantity: number;
  avgPrice: number;
  costBasis: number; // incl. explicit entry fees
  stopPrice: number;
  targetPrice: number;
  openedAt: number;
  proposalId?: string;
  feesPaid: number;
}

export interface Trade {
  id: string;
  orderId: string;
  symbol: string;
  side: "BUY" | "SELL";
  quantity: number;
  price: number;
  value: number;
  fees: FeeBreakdown;
  realisedPnl?: number;
  reason: TradeReason;
  at: number;
  simulated: boolean;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
}

export type AuditActor = "system" | "user" | "strategy" | "risk" | "ai" | "broker";

export interface AuditEntry {
  seq: number;
  at: number;
  actor: AuditActor;
  type: string;
  message: string;
  data?: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface CostTotals {
  commission: number;
  fxFee: number;
  stampDuty: number;
  spreadCost: number;
  aiCostGBP: number;
  aiCalls: number;
}

export interface EngineState {
  version: 1;
  createdAt: number;
  startingCapitalGBP: number;
  cash: number;
  positions: Position[];
  proposals: Proposal[];
  orders: OrderRecord[];
  trades: Trade[];
  equityHistory: EquityPoint[];
  audit: AuditEntry[];
  costs: CostTotals;
  limits: RiskLimits;
  emergencyStop: { active: boolean; reason?: string; since?: number };
  /** Day key (UTC yyyy-mm-dd) -> counters, for daily limits. */
  daily: { day: string; entries: number; startEquity: number; aiCostGBP: number; aiCalls: number };
  lastScanAt: number;
}
