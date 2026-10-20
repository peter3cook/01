import type { RiskLimits, TradingMode } from "../core/types";

/** The exact sentence required in LIVE_TRADING_ACK before real-money trading can start. */
export const LIVE_ACK_PHRASE = "I accept that this trades real money";

export interface ServerConfig {
  port: number;
  host: string;
  tradingMode: TradingMode;
  /** live mode only: operator typed the acknowledgement. */
  liveArmed: boolean;
  dataDir: string;
  accessToken?: string;
  production: boolean;
  anthropicApiKey?: string;
  claudeModel: string;
  aiMaxCallsPerDay: number;
  aiMaxCostPerDayGBP: number;
  t212?: { env: "demo" | "live"; apiKey: string; apiSecret: string };
  alphaVantageKey?: string;
  entryLimitBufferBps: number;
  notify: { ntfyUrl?: string; ntfyToken?: string; telegramToken?: string; telegramChatId?: string };
  scanIntervalMs: number;
  tickIntervalMs: number;
  barMs: number;
  limits: Partial<RiskLimits>;
}

export class ConfigError extends Error {}

function num(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const v = env[key];
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be a number`);
  return n;
}

/**
 * Reads configuration and refuses to start in any unsafe combination:
 *  - simulated (default): simulated prices and paper broker, no keys needed.
 *  - paper: real prices + Trading 212 PRACTICE account.
 *  - live:  real prices + Trading 212 REAL-MONEY account. Needs live keys,
 *           LIVE_TRADING_ACK set to the exact phrase, and an access token.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const raw = (env.TRADING_MODE ?? "simulated").toLowerCase();
  const mode: TradingMode | undefined = raw === "demo" || raw === "simulated" ? "simulated" : raw === "paper" ? "paper" : raw === "live" ? "live" : undefined;
  if (!mode) throw new ConfigError(`TRADING_MODE=${raw} not recognised (use simulated, paper or live)`);

  const hasLiveKeys = Object.keys(env).some((k) => /^T212_LIVE_/.test(k) && env[k]);
  if (mode !== "live" && hasLiveKeys) {
    throw new ConfigError("Real-money Trading 212 keys are set but TRADING_MODE is not live. Remove them.");
  }

  const production = env.NODE_ENV === "production";
  const accessToken = env.APP_ACCESS_TOKEN || undefined;
  const needsToken = production || mode !== "simulated";
  if (needsToken && (!accessToken || accessToken.length < 24)) {
    throw new ConfigError("APP_ACCESS_TOKEN (24+ random characters) is required for paper/live mode and in production.");
  }

  let t212: ServerConfig["t212"];
  let alphaVantageKey: string | undefined;
  let liveArmed = false;
  if (mode !== "simulated") {
    alphaVantageKey = env.ALPHAVANTAGE_API_KEY || undefined;
    if (!alphaVantageKey) throw new ConfigError("ALPHAVANTAGE_API_KEY is required for real prices.");
    const prefix = mode === "live" ? "T212_LIVE" : "T212_DEMO";
    const apiKey = env[`${prefix}_API_KEY`];
    const apiSecret = env[`${prefix}_API_SECRET`];
    if (!apiKey || !apiSecret) throw new ConfigError(`${prefix}_API_KEY and ${prefix}_API_SECRET are required for ${mode} mode.`);
    t212 = { env: mode === "live" ? "live" : "demo", apiKey, apiSecret };
    if (mode === "live") {
      if (env.LIVE_TRADING_ACK !== LIVE_ACK_PHRASE) {
        throw new ConfigError(`Live mode needs LIVE_TRADING_ACK="${LIVE_ACK_PHRASE}".`);
      }
      liveArmed = true;
    }
  }

  const limits: Partial<RiskLimits> = {};
  if (env.RISK_MAX_PER_TRADE_GBP) limits.maxRiskPerTradeGBP = num(env, "RISK_MAX_PER_TRADE_GBP", 0.5);
  if (env.RISK_MAX_POSITION_GBP) limits.maxPositionValueGBP = num(env, "RISK_MAX_POSITION_GBP", 12.5);
  if (env.RISK_MAX_DAILY_LOSS_GBP) limits.maxDailyLossGBP = num(env, "RISK_MAX_DAILY_LOSS_GBP", 1.5);
  if (env.RISK_MAX_CAPITAL_GBP) limits.maxCapitalGBP = num(env, "RISK_MAX_CAPITAL_GBP", 50);
  if (env.RISK_EQUITY_FLOOR_GBP) limits.equityFloorGBP = num(env, "RISK_EQUITY_FLOOR_GBP", 45);
  const ttlDefault = mode === "simulated" ? 600 : 1800;
  limits.proposalTtlMs = num(env, "PROPOSAL_TTL_SECONDS", ttlDefault) * 1000;

  const broker = mode !== "simulated";
  return {
    port: num(env, "PORT", 8787),
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    tradingMode: mode,
    liveArmed,
    dataDir: env.DATA_DIR ?? "./data",
    accessToken,
    production,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    aiMaxCallsPerDay: num(env, "AI_MAX_CALLS_PER_DAY", 10),
    aiMaxCostPerDayGBP: num(env, "AI_MAX_COST_PER_DAY_GBP", 0.05),
    t212,
    alphaVantageKey,
    entryLimitBufferBps: Math.min(100, Math.max(0, num(env, "ENTRY_LIMIT_BUFFER_BPS", 50))),
    notify: {
      ntfyUrl: env.NTFY_URL || undefined,
      ntfyToken: env.NTFY_TOKEN || undefined,
      telegramToken: env.TELEGRAM_BOT_TOKEN || undefined,
      telegramChatId: env.TELEGRAM_CHAT_ID || undefined,
    },
    scanIntervalMs: num(env, "SCAN_INTERVAL_SECONDS", broker ? 600 : 30) * 1000,
    tickIntervalMs: num(env, "TICK_INTERVAL_SECONDS", broker ? 15 : 3) * 1000,
    barMs: num(env, "SIM_BAR_SECONDS", 15) * 1000,
    limits,
  };
}
