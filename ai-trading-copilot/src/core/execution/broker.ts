import type { BrokerAccount, BrokerOrderResult, BrokerOrderUpdate, BrokerPosition, OrderRequest } from "../types";

/**
 * Order-execution boundary. The engine never talks to a broker directly.
 *  - SimulatedBroker: fills instantly at simulated prices.
 *  - Trading212Broker (server only): orders are ACCEPTED, then confirmed later
 *    through getOrderUpdate. Holdings change only on confirmed fills.
 */
export interface BrokerAdapter {
  readonly name: string;
  readonly environment: "SIMULATED" | "T212_DEMO" | "T212_LIVE";
  placeOrder(req: OrderRequest, now: number): Promise<BrokerOrderResult>;

  // Optional capabilities of real brokers:
  getOrderUpdate?(brokerOrderId: string, req: OrderRequest, submittedAt: number): Promise<BrokerOrderUpdate>;
  cancelOrder?(brokerOrderId: string): Promise<void>;
  /** After a timeout we don't know whether the order exists. Look for it (never re-send blindly). */
  findOrder?(req: OrderRequest, submittedAt: number): Promise<{ brokerOrderId: string } | undefined>;
  getAccount?(): Promise<BrokerAccount>;
  getPositions?(): Promise<BrokerPosition[]>;
  /** Sells filled after `since` for a ticker (to record exits made by a broker-side stop or in the broker's app). */
  getSellFills?(symbol: string, since: number): Promise<Array<{ brokerOrderId: string; type: string; price: number; quantity: number; at: number; feesGBP: number }>>;
}

export function isAsyncBroker(b: BrokerAdapter): boolean {
  return typeof b.getOrderUpdate === "function";
}
