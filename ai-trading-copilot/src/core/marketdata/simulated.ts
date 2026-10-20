import type { Bar, DataHealth, Instrument, Quote } from "../types";
import { gaussian, hashString, mulberry32, round } from "../util/math";
import type { MarketDataProvider } from "./provider";
import { ETF_UNIVERSE, SIM_PARAMS } from "./universe";

export interface SimulatedMarketOptions {
  now: number;
  seed?: number;
  /** Simulated bar length. Short by default so the demo moves. */
  barMs?: number;
  historyBars?: number;
  instruments?: Instrument[];
  /** Health turns not-ok if no update for this long. */
  staleAfterMs?: number;
}

interface SeriesState {
  bars: Bar[];
  drift: number;
  regimeLeft: number;
  randState: number; // re-seeded per bar from (seed, symbol, index) for reproducibility
  index: number;
}

export interface SimulatedMarketSnapshot {
  seed: number;
  barMs: number;
  lastUpdate: number;
  series: Record<string, { bars: Bar[]; drift: number; regimeLeft: number; index: number }>;
}

const MAX_BARS = 400;

/**
 * Deterministic random-walk market with trending regimes. Every quote it emits
 * is labelled source: "SIMULATED". It never pretends to be live data.
 */
export class SimulatedMarketData implements MarketDataProvider {
  readonly source = "SIMULATED" as const;
  private readonly list: Instrument[];
  private readonly seed: number;
  private readonly barMs: number;
  private readonly staleAfterMs: number;
  private series = new Map<string, SeriesState>();
  private lastUpdate: number;
  private outage = false;

  constructor(opts: SimulatedMarketOptions) {
    this.list = opts.instruments ?? ETF_UNIVERSE;
    this.seed = opts.seed ?? 212;
    this.barMs = opts.barMs ?? 15_000;
    this.staleAfterMs = opts.staleAfterMs ?? Math.max(this.barMs * 3, 30_000);
    this.lastUpdate = opts.now;
    const historyBars = opts.historyBars ?? 160;
    const start = opts.now - historyBars * this.barMs;
    for (const inst of this.list) {
      const p = SIM_PARAMS[inst.symbol] ?? { seedPrice: 50, vol: 0.0012 };
      const st: SeriesState = { bars: [], drift: 0, regimeLeft: 0, randState: 0, index: 0 };
      let price = p.seedPrice;
      for (let i = 0; i < historyBars; i++) {
        price = this.step(inst.symbol, st, price, p.vol, start + (i + 1) * this.barMs);
      }
      this.series.set(inst.symbol, st);
    }
  }

  static fromSnapshot(snap: SimulatedMarketSnapshot, now: number, instruments: Instrument[] = ETF_UNIVERSE): SimulatedMarketData {
    const sim = new SimulatedMarketData({ now, seed: snap.seed, barMs: snap.barMs, historyBars: 1, instruments });
    for (const inst of instruments) {
      const s = snap.series[inst.symbol];
      if (s && s.bars.length) sim.series.set(inst.symbol, { ...s, randState: 0 });
    }
    sim.lastUpdate = snap.lastUpdate;
    return sim;
  }

  snapshot(): SimulatedMarketSnapshot {
    const series: SimulatedMarketSnapshot["series"] = {};
    for (const [sym, s] of this.series) series[sym] = { bars: s.bars, drift: s.drift, regimeLeft: s.regimeLeft, index: s.index };
    return { seed: this.seed, barMs: this.barMs, lastUpdate: this.lastUpdate, series };
  }

  private step(symbol: string, st: SeriesState, prev: number, vol: number, t: number): number {
    const rand = mulberry32(hashString(`${this.seed}:${symbol}:${st.index}`));
    if (st.regimeLeft <= 0) {
      // New regime: up-trend, down-trend or chop, lasting 25–80 bars.
      const r = rand();
      st.drift = r < 0.4 ? vol * 0.35 : r < 0.7 ? -vol * 0.3 : 0;
      st.regimeLeft = 25 + Math.floor(rand() * 55);
    }
    st.regimeLeft--;
    const ret = st.drift + vol * gaussian(rand);
    const close = Math.max(0.01, prev * (1 + ret));
    const wick = Math.abs(vol * gaussian(rand)) * prev * 0.5;
    const bar: Bar = {
      t,
      o: round(prev),
      c: round(close),
      h: round(Math.max(prev, close) + wick),
      l: round(Math.max(0.01, Math.min(prev, close) - wick)),
      v: Math.round(1000 + rand() * 9000),
    };
    st.bars.push(bar);
    if (st.bars.length > MAX_BARS) st.bars.splice(0, st.bars.length - MAX_BARS);
    st.index++;
    return close;
  }

  /** Simulate a data-feed outage so the stale-data safeguards can be demonstrated. */
  setOutage(active: boolean): void {
    this.outage = active;
  }

  get outageActive(): boolean {
    return this.outage;
  }

  tick(now: number): void {
    if (this.outage) return; // no updates: quotes go stale
    for (const inst of this.list) {
      const st = this.series.get(inst.symbol);
      if (!st) continue;
      const vol = SIM_PARAMS[inst.symbol]?.vol ?? 0.0012;
      let last = st.bars[st.bars.length - 1]!;
      // Catch up at most MAX_BARS bars (e.g. after a long pause).
      let guard = 0;
      while (now - last.t >= this.barMs && guard++ < MAX_BARS) {
        this.step(inst.symbol, st, last.c, vol, last.t + this.barMs);
        last = st.bars[st.bars.length - 1]!;
      }
    }
    this.lastUpdate = now;
  }

  instruments(): Instrument[] {
    return this.list;
  }

  instrument(symbol: string): Instrument | undefined {
    return this.list.find((i) => i.symbol === symbol);
  }

  quote(symbol: string): Quote | undefined {
    const inst = this.instrument(symbol);
    const st = this.series.get(symbol);
    const last = st?.bars[st.bars.length - 1];
    if (!inst || !last) return undefined;
    const half = (last.c * inst.spreadBps) / 2 / 10_000;
    return {
      symbol,
      mid: last.c,
      bid: round(last.c - half),
      ask: round(last.c + half),
      asOf: this.lastUpdate,
      source: "SIMULATED",
    };
  }

  bars(symbol: string, count = 200): Bar[] {
    const bars = this.series.get(symbol)?.bars ?? [];
    return bars.slice(-count);
  }

  health(now: number): DataHealth {
    const age = now - this.lastUpdate;
    const ok = !this.outage && age <= this.staleAfterMs;
    return {
      source: "SIMULATED",
      ok,
      lastUpdate: this.lastUpdate,
      detail: this.outage
        ? "Simulated feed outage active – no new prices"
        : ok
          ? `Simulated prices, ${Math.round(this.barMs / 1000)}s bars`
          : `No update for ${Math.round(age / 1000)}s`,
    };
  }
}
