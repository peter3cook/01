import type { FeeModel } from "../fees/feeModel";
import type { MarketDataProvider } from "../marketdata/provider";
import type { BrokerOrderResult, OrderRequest } from "../types";
import type { BrokerAdapter } from "./broker";

/**
 * Paper broker. Fills market orders at the simulated ask (buys) or bid (sells),
 * so spread cost is realistic. Every result is flagged simulated: true.
 * It refuses to fill on stale data rather than inventing a price.
 */
export class SimulatedBroker implements BrokerAdapter {
  readonly name = "Simulated paper broker";
  readonly environment = "SIMULATED" as const;
  private seq = 0;

  constructor(
    private readonly md: MarketDataProvider,
    private readonly fees: FeeModel,
    private readonly maxDataAgeMs = 60_000,
  ) {}

  async placeOrder(req: OrderRequest, now: number): Promise<BrokerOrderResult> {
    const inst = this.md.instrument(req.symbol);
    const q = this.md.quote(req.symbol);
    if (!inst || !q) return { status: "REJECTED", reason: "Unknown instrument", simulated: true };
    if (!this.md.health(now).ok || now - q.asOf > this.maxDataAgeMs) {
      return { status: "REJECTED", reason: "Stale market data – order not filled", simulated: true };
    }
    if (!(req.quantity > 0)) return { status: "REJECTED", reason: "Invalid quantity", simulated: true };
    const price = req.side === "BUY" ? q.ask : q.bid;
    if (req.type === "LIMIT" && req.limitPrice !== undefined) {
      const crosses = req.side === "BUY" ? price <= req.limitPrice : price >= req.limitPrice;
      if (!crosses) return { status: "REJECTED", reason: "Limit not marketable (simulator does not rest orders)", simulated: true };
    }
    const fees = this.fees.oneSide(inst, req.quantity * price, req.side);
    return {
      status: "FILLED",
      brokerOrderId: `SIM-${++this.seq}-${now}`,
      fill: { price, quantity: req.quantity, at: now, fees },
      simulated: true,
    };
  }
}
