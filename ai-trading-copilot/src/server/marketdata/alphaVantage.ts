import type { DailyBarSource } from "../../core/marketdata/eod";
import type { Bar, Instrument } from "../../core/types";

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Alpha Vantage daily prices for London listings ("VUSA.LON").
 * Free tier: ~25 requests/day, so the server fetches each fund at most once a day
 * and caches results. Prices arrive in the instrument's quote unit (GBP or GBX
 * pence) and are converted to GBP here.
 */
export class AlphaVantageSource implements DailyBarSource {
  readonly name = "Alpha Vantage";
  constructor(private readonly apiKey: string, private readonly fetchImpl: Fetch = fetch as unknown as Fetch) {
    if (!apiKey) throw new Error("ALPHAVANTAGE_API_KEY is required");
  }

  async fetchDaily(inst: Instrument): Promise<Bar[]> {
    const q = new URLSearchParams({ function: "TIME_SERIES_DAILY", symbol: `${inst.symbol}.LON`, outputsize: "compact", apikey: this.apiKey });
    const res = await this.fetchImpl(`https://www.alphavantage.co/query?${q}`);
    if (!res.ok) throw new Error(`Alpha Vantage HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const series = body["Time Series (Daily)"] as Record<string, Record<string, string>> | undefined;
    if (!series) {
      const msg = String(body["Error Message"] ?? body["Note"] ?? body["Information"] ?? "unexpected response");
      throw new Error(`Alpha Vantage: ${msg.slice(0, 160)}`);
    }
    const div = inst.priceUnit === "GBX" ? 100 : 1;
    return Object.entries(series)
      .map(([date, v]) => ({
        t: Date.parse(`${date}T16:30:00Z`),
        o: Number(v["1. open"]) / div,
        h: Number(v["2. high"]) / div,
        l: Number(v["3. low"]) / div,
        c: Number(v["4. close"]) / div,
        v: Number(v["5. volume"]),
      }))
      .filter((b) => Number.isFinite(b.t) && b.c > 0)
      .sort((a, b) => a.t - b.t);
  }
}
