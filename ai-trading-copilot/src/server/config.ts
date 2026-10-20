import type { RiskLimits } from "../core/types";

export interface ServerConfig {
  port: number;
  host: string;
  tradingMode: "demo";
  dataDir: string;
  accessToken?: string;
  production: boolean;
  broker: "simulated" | "t212-demo";
  marketData: "simulated";
  anthropicApiKey?: string;
  claudeModel: string;
  aiMaxCallsPerDay: number;
  aiMaxCostPerDayGBP: number;
  t212: { apiKey?: string; apiSecret?: string };
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
 * Reads configuration from environment variables and refuses to start in any
 * unsafe combination. Live trading cannot be enabled by configuration.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const mode = (env.TRADING_MODE ?? "demo").toLowerCase();
  if (mode !== "demo") {
    throw new ConfigError(`TRADING_MODE=${mode} refused. Phase 1 supports demo mode only; live trading is not implemented.`);
  }
  for (const k of Object.keys(env)) {
    if (/^T212_LIVE/i.test(k) || k === "LIVE_TRADING") {
      throw new ConfigError(`${k} is set. Live credentials/flags are not accepted by this build – remove it.`);
    }
  }

  const broker = (env.BROKER ?? "simulated") as ServerConfig["broker"];
  if (broker !== "simulated" && broker !== "t212-demo") throw new ConfigError(`Unknown BROKER=${broker}`);
  const marketData = (env.MARKET_DATA ?? "simulated") as ServerConfig["marketData"];
  if (marketData !== "simulated") throw new ConfigError(`MARKET_DATA=${marketData} not available in Phase 1`);
  if (broker === "t212-demo" && marketData === "simulated") {
    // Never send even paper orders to a broker based on made-up prices.
    throw new ConfigError("BROKER=t212-demo needs a real market-data provider. With simulated prices only the simulated broker is allowed.");
  }

  const production = env.NODE_ENV === "production";
  const accessToken = env.APP_ACCESS_TOKEN || undefined;
  if (production && (!accessToken || accessToken.length < 24)) {
    throw new ConfigError("APP_ACCESS_TOKEN (24+ chars) is required when NODE_ENV=production.");
  }

  const limits: Partial<RiskLimits> = {};
  if (env.RISK_MAX_PER_TRADE_GBP) limits.maxRiskPerTradeGBP = num(env, "RISK_MAX_PER_TRADE_GBP", 0.5);
  if (env.RISK_MAX_POSITION_GBP) limits.maxPositionValueGBP = num(env, "RISK_MAX_POSITION_GBP", 12.5);
  if (env.RISK_MAX_DAILY_LOSS_GBP) limits.maxDailyLossGBP = num(env, "RISK_MAX_DAILY_LOSS_GBP", 1.5);
  if (env.PROPOSAL_TTL_SECONDS) limits.proposalTtlMs = num(env, "PROPOSAL_TTL_SECONDS", 600) * 1000;

  return {
    port: num(env, "PORT", 8787),
    host: env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1"),
    tradingMode: "demo",
    dataDir: env.DATA_DIR ?? "./data",
    accessToken,
    production,
    broker,
    marketData,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeModel: env.CLAUDE_MODEL ?? "claude-opus-5-5",
    aiMaxCallsPerDay: num(env, "AI_MAX_CALLS_PER_DAY", 10),
    aiMaxCostPerDayGBP: num(env, "AI_MAX_COST_PER_DAY_GBP", 0.05),
    t212: { apiKey: env.T212_DEMO_API_KEY || undefined, apiSecret: env.T212_DEMO_API_SECRET || undefined },
    scanIntervalMs: num(env, "SCAN_INTERVAL_SECONDS", 30) * 1000,
    tickIntervalMs: num(env, "TICK_INTERVAL_SECONDS", 3) * 1000,
    barMs: num(env, "SIM_BAR_SECONDS", 15) * 1000,
    limits,
  };
}
