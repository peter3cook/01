import type { Bar, DataHealth, DataSource, Instrument, Quote } from "../types";

/**
 * Market data boundary. Strategy, risk and execution only see this interface,
 * so a real provider can replace the simulator without touching them.
 */
export interface MarketDataProvider {
  readonly source: DataSource;
  instruments(): Instrument[];
  instrument(symbol: string): Instrument | undefined;
  /** Latest usable quote, or undefined when the symbol must not be traded. */
  quote(symbol: string, now?: number): Quote | undefined;
  bars(symbol: string, count?: number): Bar[];
  health(now: number): DataHealth;
  /** Advance to `now` (pull/refresh). The simulator generates bars here. */
  tick(now: number): void;
}
