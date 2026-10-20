import { CopilotEngine, MemoryStore, type EngineOptions } from "../src/core/engine";
import { Trading212FeeModel } from "../src/core/fees/feeModel";
import { SimulatedBroker } from "../src/core/execution/simulatedBroker";
import type { MarketDataProvider } from "../src/core/marketdata/provider";
import { ETF_UNIVERSE } from "../src/core/marketdata/universe";
import type { Bar, DataHealth, Instrument, Quote } from "../src/core/types";

export const T0 = Date.UTC(2026, 9, 20, 9, 0, 0);

/** Zig-zag up-trend (+0.2%, −0.1%) that passes every strategy rule (RSI ≈ 67). */
export function uptrendBars(start: number, n: number, endT: number, barMs = 15_000): Bar[] {
  const bars: Bar[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    const c = i % 2 === 0 ? p * 1.002 : p * 0.999;
    bars.push({ t: endT - (n - 1 - i) * barMs, o: p, c, h: Math.max(p, c) * 1.00005, l: Math.min(p, c) * 0.99995, v: 1000 });
    p = c;
  }
  return bars;
}

export function downtrendBars(start: number, n: number, endT: number, barMs = 15_000): Bar[] {
  return uptrendBars(start, n, endT, barMs).map((b, i, all) => ({ ...b, c: all[all.length - 1 - i]!.c, o: all[all.length - 1 - i]!.o }));
}

/** Fully controllable market for deterministic tests. */
export class FakeMarket implements MarketDataProvider {
  readonly source = "SIMULATED" as const;
  bySymbol = new Map<string, Bar[]>();
  override = new Map<string, number>();
  asOf: number;
  healthy = true;
  constructor(readonly list: Instrument[], now: number) {
    this.asOf = now;
    for (const i of list) this.bySymbol.set(i.symbol, i.symbol === "VUSA" ? uptrendBars(90, 120, now) : downtrendBars(10, 120, now));
  }
  instruments() { return this.list; }
  instrument(s: string) { return this.list.find((i) => i.symbol === s); }
  bars(s: string, n = 200) { return (this.bySymbol.get(s) ?? []).slice(-n); }
  quote(s: string): Quote | undefined {
    const inst = this.instrument(s);
    const last = this.bars(s).at(-1);
    if (!inst || !last) return undefined;
    const mid = this.override.get(s) ?? last.c;
    const half = (mid * inst.spreadBps) / 20_000;
    return { symbol: s, mid, bid: mid - half, ask: mid + half, asOf: this.asOf, source: "SIMULATED" };
  }
  health(now: number): DataHealth {
    const ok = this.healthy && now - this.asOf < 60_000;
    return { source: "SIMULATED", ok, lastUpdate: this.asOf, detail: ok ? "ok" : "stale" };
  }
  tick(now: number) { if (this.healthy) this.asOf = now; }
}

export function setup(opts: Partial<EngineOptions> & { symbols?: string[] } = {}) {
  let now = T0;
  const clock = () => now;
  const list = ETF_UNIVERSE.filter((i) => (opts.symbols ?? ["VUSA", "ISF"]).includes(i.symbol));
  const md = new FakeMarket(list, now);
  const fees = new Trading212FeeModel();
  const broker = new SimulatedBroker(md, fees);
  const store = new MemoryStore();
  const engine = new CopilotEngine({ md, broker, fees, tradingMode: "demo", clock, store, scanIntervalMs: 30_000, ...opts });
  return {
    engine, md, store, fees, broker,
    advance: (ms: number) => { now += ms; },
    now: () => now,
  };
}
