import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { CopilotEngine, EngineError, MemoryStore, type StateStore } from "../core/engine";
import { Trading212FeeModel } from "../core/fees/feeModel";
import { SimulatedBroker } from "../core/execution/simulatedBroker";
import { SimulatedMarketData, type SimulatedMarketSnapshot } from "../core/marketdata/simulated";
import type { RiskLimits } from "../core/types";
import { ClaudeExplainer } from "./claudeExplainer";
import type { ServerConfig } from "./config";
import { FileStore, auditAppender } from "./fileStore";

export interface AppDeps {
  clock?: () => number;
  store?: StateStore;
  md?: SimulatedMarketData;
  webDir?: string;
  persistMarket?: boolean;
}

export interface AppHandle {
  app: FastifyInstance;
  engine: CopilotEngine;
  md: SimulatedMarketData;
  saveMarket: () => void;
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

export async function buildApp(config: ServerConfig, deps: AppDeps = {}): Promise<AppHandle> {
  const clock = deps.clock ?? (() => Date.now());
  const fileStore = deps.store ? undefined : new FileStore(config.dataDir);
  const store: StateStore = deps.store ?? fileStore ?? new MemoryStore();

  const savedMarket = fileStore?.readJson<SimulatedMarketSnapshot>("market.json");
  const md = deps.md ?? (savedMarket ? SimulatedMarketData.fromSnapshot(savedMarket, clock()) : new SimulatedMarketData({ now: clock(), barMs: config.barMs }));
  const saveMarket = () => {
    if (fileStore && deps.persistMarket !== false) fileStore.writeJson("market.json", md.snapshot());
  };

  const fees = new Trading212FeeModel();
  // Phase 1: config validation guarantees the simulated broker is used with simulated data.
  const broker = new SimulatedBroker(md, fees, 60_000);
  const engine = new CopilotEngine({
    md,
    broker,
    fees,
    tradingMode: config.tradingMode,
    aiExplainer: config.anthropicApiKey ? new ClaudeExplainer(config.anthropicApiKey, config.claudeModel) : undefined,
    aiBudget: { maxCallsPerDay: config.aiMaxCallsPerDay, maxCostPerDayGBP: config.aiMaxCostPerDayGBP },
    store,
    clock,
    limits: config.limits,
    scanIntervalMs: config.scanIntervalMs,
    onAudit: fileStore ? auditAppender(config.dataDir) : undefined,
  });

  const app = Fastify({ logger: { level: config.production ? "info" : "warn", redact: ["req.headers.authorization"] }, bodyLimit: 16 * 1024 });

  // Security headers on every response.
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

  // Bearer-token auth for every /api route except health.
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/api/") || req.url === "/api/health") return;
    if (!config.accessToken) return; // local development only (production requires a token)
    const h = req.headers.authorization ?? "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token || !safeEqual(token, config.accessToken)) return reply.code(401).send({ error: "Unauthorised" });
  });

  app.get("/api/health", async () => ({ ok: true, mode: config.tradingMode, liveTrading: false, data: md.health(clock()) }));

  app.get("/api/state", async () => ({ ...engine.snapshot(), authRequired: !!config.accessToken, outage: md.outageActive }));

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
      return (await engine.closePosition(req.params.symbol)) ?? reply.code(409).send({ error: "Exit not filled – see activity log" });
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

  app.post<{ Body: { active?: boolean } }>("/api/sim/outage", async (req) => {
    md.setOutage(!!req.body?.active);
    return { outage: md.outageActive };
  });

  const webDir = deps.webDir ?? resolve("dist/web");
  if (existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, index: ["index.html"], list: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, engine, md, saveMarket };
}
