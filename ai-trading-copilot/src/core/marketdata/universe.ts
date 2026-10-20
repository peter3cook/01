import type { Instrument } from "../types";

// Liquid, GBP-denominated, LSE-listed UCITS ETFs. Spread and liquidity figures are
// SIMULATION ASSUMPTIONS, not market data. Trading 212 tickers follow the
// "<SYMBOL>l_EQ" convention for LSE lines and MUST be verified against
// GET /api/v0/equity/metadata/instruments before any broker integration.
export const ETF_UNIVERSE: Instrument[] = [
  { symbol: "VUSA", t212Ticker: "VUSAl_EQ", name: "Vanguard S&P 500 UCITS ETF", type: "ETF", currency: "GBP", exchange: "LSE", category: "US equity", spreadBps: 4, avgDailyValueGBPm: 60, qtyDecimals: 4 },
  { symbol: "VWRP", t212Ticker: "VWRPl_EQ", name: "Vanguard FTSE All-World (Acc)", type: "ETF", currency: "GBP", exchange: "LSE", category: "Global equity", spreadBps: 6, avgDailyValueGBPm: 45, qtyDecimals: 4 },
  { symbol: "ISF", t212Ticker: "ISFl_EQ", name: "iShares Core FTSE 100", type: "ETF", currency: "GBP", exchange: "LSE", category: "UK equity", spreadBps: 5, avgDailyValueGBPm: 55, qtyDecimals: 4 },
  { symbol: "VMID", t212Ticker: "VMIDl_EQ", name: "Vanguard FTSE 250", type: "ETF", currency: "GBP", exchange: "LSE", category: "UK mid-cap", spreadBps: 10, avgDailyValueGBPm: 12, qtyDecimals: 4 },
  { symbol: "EQQQ", t212Ticker: "EQQQl_EQ", name: "Invesco EQQQ Nasdaq-100", type: "ETF", currency: "GBP", exchange: "LSE", category: "US tech", spreadBps: 6, avgDailyValueGBPm: 40, qtyDecimals: 4 },
  { symbol: "CSP1", t212Ticker: "CSP1l_EQ", name: "iShares Core S&P 500 (Acc)", type: "ETF", currency: "GBP", exchange: "LSE", category: "US equity", spreadBps: 4, avgDailyValueGBPm: 70, qtyDecimals: 4 },
  { symbol: "SGLN", t212Ticker: "SGLNl_EQ", name: "iShares Physical Gold", type: "ETF", currency: "GBP", exchange: "LSE", category: "Gold", spreadBps: 8, avgDailyValueGBPm: 25, qtyDecimals: 4 },
  { symbol: "IGLT", t212Ticker: "IGLTl_EQ", name: "iShares Core UK Gilts", type: "ETF", currency: "GBP", exchange: "LSE", category: "UK gilts", spreadBps: 5, avgDailyValueGBPm: 20, qtyDecimals: 4 },
  { symbol: "INRG", t212Ticker: "INRGl_EQ", name: "iShares Global Clean Energy", type: "ETF", currency: "GBP", exchange: "LSE", category: "Thematic", spreadBps: 25, avgDailyValueGBPm: 6, qtyDecimals: 4 },
];

/** Starting prices and per-bar volatility for the SIMULATOR only. Not real prices. */
export const SIM_PARAMS: Record<string, { seedPrice: number; vol: number }> = {
  VUSA: { seedPrice: 90, vol: 0.0012 },
  VWRP: { seedPrice: 115, vol: 0.001 },
  ISF: { seedPrice: 8.5, vol: 0.0011 },
  VMID: { seedPrice: 33, vol: 0.0015 },
  EQQQ: { seedPrice: 420, vol: 0.0016 },
  CSP1: { seedPrice: 510, vol: 0.0012 },
  SGLN: { seedPrice: 48, vol: 0.0013 },
  IGLT: { seedPrice: 10.5, vol: 0.0006 },
  INRG: { seedPrice: 6, vol: 0.0028 },
};
