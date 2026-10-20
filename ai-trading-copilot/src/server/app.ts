import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CopilotEngine, EngineError, MemoryStore, type StateStore } from "../core/engine";
import type { BrokerAdapter } from "../core/execution/broker";
import { SimulatedBroker } from "../core/execution/simulatedBroker";
import { Trading212FeeModel } from "../core/fees/feeModel";
import { EodMarketData, type DailyBarSource } from "../core/marketdata/eod";
import type { MarketDataProvider } from "../core/marketdata/provider";
import { SimulatedMarketData, type SimulatedMarketSnapshot } from "../core/marketdata/simulated";
import { ETF_UNIVERSE } from "../core/marketdata/universe";
import { DAILY_STRATEGY } from "../core/strategy/trendPullback";
import type { AuditEntry, Bar, Instrument, RiskLimits } from "../core/types";
import { LseClock, sessionsBehind } from "../core/util/marketHours";
import { Trading212Broker, Trading212Client, verifyInstruments, type FetchLike, type T212Instrument } from "./brokers/trading212";
import { ClaudeExplainer } from "./claudeExplainer";
import type { ServerConfig } from "./config";
import { FileStore, auditAppender } from "./fileStore";
import { AlphaVantageSource } from "./marketdata/alphaVantage";
import { NtfyNotifier, TelegramNotifier, auditNotifier, type Notifier } from "./notifier";

export interface AppDeps {
  clock?: () => number;
  store?: StateStore;
  md?: SimulatedMarketData;
  webDir?: string;
  persistMarket?: boolean;
  /** Test seams for broker modes. */
  t212Fetch?: FetchLike;
  t212Instruments?: T212Instrument[];
  priceSource?: DailyBarSource;
  notifier?: Notifier;
  log?: (msg: string) => void;
}

export interface AppHandle {
  app: FastifyInstance;
  engine: CopilotEngine;
  md: MarketDataProvider;
  /** Persist simulator / price cache. */
  saveMarket: () => void;
  /** Broker modes: fetch any missing daily prices (respects the free-tier budget). */
  refreshPrices: () => Promise<void>;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof EngineError) {
    const status = { NOT_FOUND: 404, CONFLICT: 409, EXPIRED: 410, INVALID: 400 }[err.code];
    return reply.code(status).send({ error: err.message, code: err.code });
  }
  reply.log.error(err);
  return reply.code(500).send({ error: "Internal error" });
}

const PRICE_BUDGET_PER_DAY = 20;
const PRICE_RETRY_MS = 3 * 3600_000;

export async function buildApp(config: ServerConfig, deps: AppDeps = {}): Promise<AppHandle> {
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? ((m: string) => console.log(m));
  const fileStore = deps.store ? undefined : new FileStore(config.dataDir);
  const store: StateStore = deps.store ?? fileStore ?? new MemoryStore();
  const fees = new Trading212FeeModel();

  const notifier =
    deps.notifier ??
    (config.notify.ntfyUrl
      ? new NtfyNotifier(config.notify.ntfyUrl, config.notify.ntfyToken)
      : config.notify.telegramToken && config.notify.telegramChatId
        ? new TelegramNotifier(config.notify.telegramToken, config.notify.telegramChatId)
        : undefined);
  const prefix = config.tradingMode === "live" ? "" : config.tradingMode === "paper" ? "[PRACTICE] " : "[DEMO] ";
  const toFile = fileStore ? auditAppender(config.dataDir) : undefined;
  const toPhone = auditNotifier(notifier, prefix, log);
  const onAudit = (e: AuditEntry) => {
    toFile?.(e);
    toPhone(e);
  };

  let md: MarketDataProvider;
  let broker: BrokerAdapter;
  let saveMarket: () => void = () => {};
  let refreshPrices: () => Promise<void> = async () => {};
  let sim: SimulatedMarketData | undefined;
  const startupNotes: string[] = [];

  if (config.tradingMode === "simulated") {
    const savedMarket = fileStore?.readJson<SimulatedMarketSnapshot>("market.json");
    sim = deps.md ?? (savedMarket ? SimulatedMarketData.fromSnapshot(savedMarket, clock()) : new SimulatedMarketData({ now: clock(), barMs: config.barMs }));
    md = sim;
    broker = new SimulatedBroker(sim, fees, 60_000);
    saveMarket = () => {
      if (fileStore && deps.persistMarket !== false) fileStore.writeJson("market.json", sim!.snapshot());
    };
  } else {
    const t = config.t212!;
    const client = new Trading212Client(t.env, t.apiKey, t.apiSecret, deps.t212Fetch);

    // 1. Match our fund list to Trading 212 (cached for a day: the endpoint allows 1 call / 50s).
    let t212List = deps.t212Instruments;
    if (!t212List) {
      const cached = fileStore?.readJson<{ at: number; env: string; list: T212Instrument[] }>("t212-instruments.json");
      if (cached && cached.env === t.env && clock() - cached.at < 24 * 3600_000) t212List = cached.list;
      else {
        t212List = await client.instruments();
        fileStore?.writeJson("t212-instruments.json", { at: clock(), env: t.env, list: t212List.filter((i) => i.type === "ETF") });
      }
    }
    const { verified, report } = verifyInstruments(ETF_UNIVERSE, t212List);
    startupNotes.push(...report);
    if (!verified.length) throw new Error("None of the ETFs could be matched at Trading 212 – refusing to start.");

    // 2. Real end-of-day prices, cached on disk.
    const eod = new EodMarketData(verified, "Alpha Vantage");
    const cache = fileStore?.readJson<{ bars: Record<string, Bar[]>; attempts: Record<string, number>; day: string; used: number }>("prices.json");
    if (cache) eod.restore(cache.bars, clock());
    const budget = { day: cache?.day ?? "", used: cache?.used ?? 0, attempts: cache?.attempts ?? {} };
    const source = deps.priceSource ?? new AlphaVantageSource(config.alphaVantageKey!);
    md = eod;
    saveMarket = () => fileStore?.writeJson("prices.json", { bars: eod.snapshot(), attempts: budget.attempts, day: budget.day, used: budget.used });
    let refreshing = false;
    refreshPrices = async () => {
      if (refreshing) return;
      refreshing = true;
      const now = clock();
      const today = new Date(now).toISOString().slice(0, 10);
      if (budget.day !== today) Object.assign(budget, { day: today, used: 0 });
      let lastError: string | undefined;
      try {
        for (const inst of verified) {
          const last = eod.lastBarDate(inst.symbol);
          if (last && sessionsBehind(last, now) === 0) continue; // already current
          if (now - (budget.attempts[inst.symbol] ?? 0) < PRICE_RETRY_MS && last) continue;
          if (budget.used >= PRICE_BUDGET_PER_DAY) { lastError = "daily price-request budget used"; break; }
          budget.used++;
          budget.attempts[inst.symbol] = now;
          try {
            eod.setBars(inst.symbol, await source.fetchDaily(inst), now);
          } catch (e) {
            lastError = (e as Error).message;
            eod.setError(inst.symbol, lastError);
          }
          if (!deps.priceSource) await new Promise((r) => setTimeout(r, 15_000)); // free tier: a few calls per minute
        }
      } finally {
        eod.markRefreshed(clock(), verified.some((i) => !eod.problem(i.symbol, clock())) ? undefined : lastError);
        saveMarket();
        refreshing = false;
      }
    };
    broker = new Trading212Broker(client, verified);
  }

  const broking = config.tradingMode !== "simulated";
  const engine = new CopilotEngine({
    md,
    broker,
    fees,
    tradingMode: config.tradingMode,
    liveArmed: config.liveArmed,
    aiExplainer: config.anthropicApiKey ? new ClaudeExplainer(config.anthropicApiKey, config.claudeModel) : undefined,
    aiBudget: { maxCallsPerDay: config.aiMaxCallsPerDay, maxCostPerDayGBP: config.aiMaxCostPerDayGBP },
    store,
    clock,
    limits: config.limits,
    scanIntervalMs: config.scanIntervalMs,
    onAudit,
    ...(broking
      ? {
          market: new LseClock(),
          entryOrder: { type: "LIMIT" as const, limitBufferBps: config.entryLimitBufferBps },
          maxQuoteAgeMs: 7 * 24 * 3600_000, // freshness is enforced per session by the price feed
          strategy: DAILY_STRATEGY,
          cooldownMs: 20 * 3600_000,
          maxPendingProposals: 3,
          brokerSyncMs: 30_000,
        }
      : {}),
  });
  for (const note of startupNotes) log(`  ${note}`);

  const app = Fastify({ logger: { level: config.production ? "info" : "warn", redact: ["req.headers.authorization"] }, bodyLimit: 16 * 1024 });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (config.production) reply.header("Strict-Transport-Security", "max-age=31536000");
    return payload;
  });

  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/health") return;
    if (!config.accessToken) return; // simulated local development only
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token || !safeEqual(token, config.accessToken)) return reply.code(401).send({ error: "Unauthorised" });
  });

  app.get("/api/health", async () => ({ ok: true, mode: config.tradingMode, liveTrading: config.liveArmed, data: md.health(clock()) }));

  app.get("/api/state", async () => ({
    ...engine.snapshot(),
    authRequired: !!config.accessToken,
    outage: sim?.outageActive ?? false,
    notifications: notifier?.name ?? null,
  }));

  app.post<{ Params: { id: string } }>("/api/proposals/:id/approve", async (req, reply) => {
    try {
      return await engine.approve(req.params.id);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/reject", async (req, reply) => {
    try {
      return engine.reject(req.params.id);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Params: { symbol: string } }>("/api/positions/:symbol/close", async (req, reply) => {
    try {
      const t = await engine.closePosition(req.params.symbol);
      if (t) return t;
      const pos = engine.state.positions.find((p) => p.symbol === req.params.symbol);
      return pos?.exitRecordId ? { status: "SUBMITTED" } : reply.code(409).send({ error: "Sell not placed – see the activity log" });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post("/api/positions/close-all", async (_req, reply) => {
    try {
      return { closed: await engine.closeAll() };
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: { active?: boolean; reason?: string; confirm?: string } }>("/api/emergency-stop", async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.active !== "boolean") return reply.code(400).send({ error: "active (boolean) required" });
    try {
      return engine.setEmergencyStop(b.active, { reason: typeof b.reason === "string" ? b.reason.slice(0, 120) : undefined, confirm: b.confirm });
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: { enabled?: boolean; confirm?: string } }>("/api/auto-trade", async (req, reply) => {
    const b = req.body ?? {};
    if (typeof b.enabled !== "boolean") return reply.code(400).send({ error: "enabled (boolean) required" });
    try {
      return engine.setAutoTrade(b.enabled, b.confirm);
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post<{ Body: Partial<RiskLimits> }>("/api/limits", async (req, reply) => {
    try {
      return engine.updateLimits(req.body ?? {});
    } catch (e) {
      return sendError(reply, e);
    }
  });

  app.post("/api/scan", async () => {
    await engine.tick();
    await engine.scan();
    return engine.snapshot();
  });

  if (sim) {
    app.post<{ Body: { active?: boolean } }>("/api/sim/outage", async (req) => {
      sim!.setOutage(!!req.body?.active);
      return { outage: sim!.outageActive };
    });
  }

  const webDir = deps.webDir ?? resolve("dist/web");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, index: ["index.html"], list: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, engine, md, saveMarket, refreshPrices };
}

export type { Instrument };
