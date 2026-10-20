import type { Bar, DataHealth, Instrument, Quote } from "../types";
import { round } from "../util/math";
import { sessionsBehind } from "../util/marketHours";
import type { MarketDataProvider } from "./provider";

/** A source of daily OHLC bars, already converted to GBP and sorted oldest first. */
export interface DailyBarSource {
  readonly name: string;
  fetchDaily(instrument: Instrument): Promise<Bar[]>;
}

interface SymbolData {
  bars: Bar[];
  fetchedAt: number;
  error?: string;
  mark?: { price: number; at: number };
}

/**
 * Real end-of-day prices. Quotes are the last daily close (labelled END_OF_DAY),
 * so entries must use LIMIT orders. A symbol stops quoting (blocking trades) when:
 *  - its data is more than `maxSessionsBehind` sessions old, or
 *  - the broker's live price disagrees with the last close by more than
 *    `maxDivergence` (catches pence/pound mix-ups and bad data).
 */
export class EodMarketData implements MarketDataProvider {
  readonly source = "END_OF_DAY" as const;
  private data = new Map<string, SymbolData>();
  private lastRefresh = 0;
  private refreshError?: string;

  constructor(
    private readonly list: Instrument[],
    private readonly sourceName: string,
    private readonly maxSessionsBehind = 1,
    private readonly maxDivergence = 0.08,
  ) {}

  setBars(symbol: string, bars: Bar[], at: number) {
    const clean = bars.filter((b) => [b.o, b.h, b.l, b.c].every((x) => Number.isFinite(x) && x > 0)).sort((a, b) => a.t - b.t);
    const prev = this.data.get(symbol);
    this.data.set(symbol, { bars: clean, fetchedAt: at, mark: prev?.mark });
  }

  setError(symbol: string, error: string) {
    const prev = this.data.get(symbol);
    this.data.set(symbol, { bars: prev?.bars ?? [], fetchedAt: prev?.fetchedAt ?? 0, error, mark: prev?.mark });
  }

  /** Latest broker price for a held instrument (GBP), used as a cross-check. */
  setMark(symbol: string, price: number, at: number) {
    const d = this.data.get(symbol);
    if (d) d.mark = { price, at };
  }

  markRefreshed(at: number, error?: string) {
    this.lastRefresh = at;
    this.refreshError = error;
  }

  snapshot(): Record<string, Bar[]> {
    const out: Record<string, Bar[]> = {};
    for (const [k, v] of this.data) out[k] = v.bars;
    return out;
  }

  restore(snap: Record<string, Bar[]>, at: number) {
    for (const [k, bars] of Object.entries(snap)) this.setBars(k, bars, at);
  }

  lastBarDate(symbol: string): string | undefined {
    const b = this.data.get(symbol)?.bars.at(-1);
    return b ? new Date(b.t).toISOString().slice(0, 10) : undefined;
  }

  /** Reason this symbol can't be traded right now, or undefined if it's fine. */
  problem(symbol: string, now: number): string | undefined {
    const d = this.data.get(symbol);
    const last = d?.bars.at(-1);
    if (!d || !last) return d?.error ?? "No price data yet";
    const behind = sessionsBehind(this.lastBarDate(symbol)!, now);
    if (behind > this.maxSessionsBehind) return `Price data ${behind} sessions old`;
    if (d.mark && Math.abs(d.mark.price - last.c) / last.c > this.maxDivergence) {
      return `Price check failed: data ${last.c} vs broker ${round(d.mark.price)}`;
    }
    return undefined;
  }

  tick(_now: number): void {
    /* refreshed by the server's data job */
  }

  instruments(): Instrument[] {
    return this.list;
  }

  instrument(symbol: string): Instrument | undefined {
    return this.list.find((i) => i.symbol === symbol);
  }

  bars(symbol: string, count = 200): Bar[] {
    return (this.data.get(symbol)?.bars ?? []).slice(-count);
  }

  quote(symbol: string, now = Date.now()): Quote | undefined {
    const inst = this.instrument(symbol);
    const last = this.data.get(symbol)?.bars.at(-1);
    if (!inst || !last || this.problem(symbol, now)) return undefined;
    const half = (last.c * inst.spreadBps) / 2 / 10_000;
    return { symbol, mid: last.c, bid: round(last.c - half), ask: round(last.c + half), asOf: last.t, source: "END_OF_DAY" };
  }

  health(now: number): DataHealth {
    const ok = this.list.filter((i) => !this.problem(i.symbol, now)).length;
    const total = this.list.length;
    const healthy = ok > 0 && !this.refreshError;
    return {
      source: "END_OF_DAY",
      ok: healthy,
      lastUpdate: this.lastRefresh,
      detail: this.refreshError ? `Price refresh failed: ${this.refreshError}` : `End-of-day prices (${this.sourceName}) · ${ok}/${total} funds current`,
    };
  }
}
