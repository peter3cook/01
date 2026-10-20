import type { BrokerOrderResult, OrderRequest } from "../types";

/**
 * Order-execution boundary. The engine never talks to a broker directly.
 * Implementations: SimulatedBroker (Phase 1 default) and the prepared
 * Trading212DemoBroker (server-side only, demo endpoint only).
 */
export interface BrokerAdapter {
  readonly name: string;
  readonly environment: "SIMULATED" | "T212_DEMO";
  placeOrder(req: OrderRequest, now: number): Promise<BrokerOrderResult>;
}
