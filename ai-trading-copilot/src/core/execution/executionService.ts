import type { BrokerOrderResult, OrderRecord, OrderRequest } from "../types";
import type { BrokerAdapter } from "./broker";

/**
 * Submits orders exactly once per clientOrderId.
 *  - A second submit with the same key returns the original record (no resubmit),
 *    unless the broker definitively REJECTED it. An ERROR (e.g. timeout) is never
 *    retried automatically because the order may have reached the broker.
 *  - Concurrent submits with the same key share one in-flight promise.
 *  - Broker exceptions are recorded as ERROR, never as a fill.
 */
export class ExecutionService {
  private inFlight = new Map<string, Promise<OrderRecord>>();

  constructor(
    private readonly broker: BrokerAdapter,
    private readonly orders: () => OrderRecord[],
    private readonly onRecord: (rec: OrderRecord) => void,
    private readonly newId: () => string,
  ) {}

  get brokerName(): string {
    return this.broker.name;
  }

  existing(clientOrderId: string): OrderRecord | undefined {
    return this.orders().find((o) => o.request.clientOrderId === clientOrderId && o.status !== "REJECTED");
  }

  submit(req: OrderRequest, now: number): Promise<OrderRecord> {
    const prior = this.existing(req.clientOrderId);
    if (prior) return Promise.resolve(prior);
    const running = this.inFlight.get(req.clientOrderId);
    if (running) return running;

    const p = (async () => {
      let res: BrokerOrderResult;
      try {
        res = await this.broker.placeOrder(req, now);
      } catch (err) {
        res = { status: "ERROR", reason: (err as Error).message, simulated: this.broker.environment === "SIMULATED" };
      }
      const rec: OrderRecord = {
        id: this.newId(),
        request: req,
        status: res.status,
        brokerOrderId: res.brokerOrderId,
        broker: this.broker.name,
        submittedAt: now,
        fill: res.status === "FILLED" ? res.fill : undefined,
        reason: res.reason,
        simulated: res.simulated,
      };
      this.onRecord(rec);
      return rec;
    })();
    this.inFlight.set(req.clientOrderId, p);
    return p.finally(() => this.inFlight.delete(req.clientOrderId));
  }
}
