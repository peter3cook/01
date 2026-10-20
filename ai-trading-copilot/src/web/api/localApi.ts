import { CopilotEngine, EngineError, type StateStore } from "../../core/engine";
import { Trading212FeeModel } from "../../core/fees/feeModel";
import { SimulatedBroker } from "../../core/execution/simulatedBroker";
import { SimulatedMarketData } from "../../core/marketdata/simulated";
import type { EngineState, RiskLimits } from "../../core/types";
import { ApiError, type AppState, type CopilotApi } from "./client";

const KEY = "copilot.preview.state.v1";

class LocalStore implements StateStore {
  load(): EngineState | undefined {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as EngineState) : undefined;
    } catch {
      return undefined;
    }
  }
  save(s: EngineState) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable – preview still works in memory */
    }
  }
}

/**
 * Standalone preview: runs the same core engine in the browser with simulated
 * prices, the simulated broker and rules-template explanations. No network,
 * no broker, no credentials.
 */
export class LocalApi implements CopilotApi {
  readonly kind = "standalone" as const;
  private engine: CopilotEngine;
  private md: SimulatedMarketData;

  constructor() {
    const now = Date.now();
    // Fresh simulated market each visit; saved positions are dropped because their prices would not match.
    const store = new LocalStore();
    const saved = store.load();
    if (saved && (saved.positions.length || now - saved.createdAt > 6 * 3600_000)) localStorage.removeItem(KEY);
    this.md = new SimulatedMarketData({ now, barMs: 8_000, seed: now % 100_000 });
    const fees = new Trading212FeeModel();
    this.engine = new CopilotEngine({
      md: this.md,
      broker: new SimulatedBroker(this.md, fees),
      fees,
      tradingMode: "demo",
      store,
      scanIntervalMs: 16_000,
      limits: { proposalTtlMs: 5 * 60_000 },
      cooldownMs: 90_000,
    });
    void this.engine.tick();
    setInterval(() => void this.engine.tick(), 2_000);
  }

  private async wrap<T>(f: () => T | Promise<T>): Promise<T> {
    try {
      return await f();
    } catch (e) {
      if (e instanceof EngineError) throw new ApiError(e.message, e.code === "NOT_FOUND" ? 404 : 409);
      throw e;
    }
  }

  async state(): Promise<AppState> { return { ...this.engine.snapshot(), outage: this.md.outageActive }; }
  approve(id: string) { return this.wrap(() => this.engine.approve(id)); }
  reject(id: string) { return this.wrap(() => this.engine.reject(id)); }
  closePosition(s: string) { return this.wrap(() => this.engine.closePosition(s)); }
  closeAll() { return this.wrap(() => this.engine.closeAll()); }
  emergencyStop(active: boolean, confirm?: string) { return this.wrap(() => this.engine.setEmergencyStop(active, { confirm })); }
  tightenLimits(patch: Partial<RiskLimits>) { return this.wrap(() => this.engine.updateLimits(patch)); }
  scan() { return this.wrap(async () => { await this.engine.tick(); return this.engine.scan(); }); }
  setOutage(active: boolean) { return this.wrap(() => { this.md.setOutage(active); return { outage: active }; }); }
  setAutoTrade(enabled: boolean, confirm?: string) { return this.wrap(() => this.engine.setAutoTrade(enabled, confirm)); }
}
