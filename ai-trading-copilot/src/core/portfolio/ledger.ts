import type { MarketDataProvider } from "../marketdata/provider";
import type { BrokerFill, EngineState, Position, Trade, TradeReason } from "../types";
import { round } from "../util/math";

export interface PositionView extends Position {
  name: string;
  markPrice: number; // bid – what you could actually sell for
  marketValue: number;
  unrealisedPnl: number;
  unrealisedPct: number;
}

/** Apply a CONFIRMED broker fill to cash and positions. Nothing else changes holdings. */
export function applyFill(
  state: EngineState,
  args: { orderId: string; symbol: string; side: "BUY" | "SELL"; fill: BrokerFill; reason: TradeReason; stop?: number; target?: number; proposalId?: string; simulated: boolean; tradeId: string },
): Trade {
  const { fill } = args;
  const value = round(fill.quantity * fill.price);
  const fees = fill.fees;
  state.costs.commission = round(state.costs.commission + fees.commission);
  state.costs.fxFee = round(state.costs.fxFee + fees.fxFee);
  state.costs.stampDuty = round(state.costs.stampDuty + fees.stampDuty);
  state.costs.spreadCost = round(state.costs.spreadCost + fees.spreadCost);

  let realisedPnl: number | undefined;
  if (args.side === "BUY") {
    state.cash = round(state.cash - value - fees.explicitTotal);
    const existing = state.positions.find((p) => p.symbol === args.symbol);
    if (existing) {
      const qty = existing.quantity + fill.quantity;
      existing.costBasis = round(existing.costBasis + value + fees.explicitTotal);
      existing.avgPrice = round(existing.costBasis / qty);
      existing.quantity = round(qty, 6);
      existing.feesPaid = round(existing.feesPaid + fees.explicitTotal);
    } else {
      state.positions.push({
        symbol: args.symbol,
        quantity: fill.quantity,
        avgPrice: round((value + fees.explicitTotal) / fill.quantity),
        costBasis: round(value + fees.explicitTotal),
        stopPrice: args.stop ?? 0,
        targetPrice: args.target ?? 0,
        openedAt: fill.at,
        proposalId: args.proposalId,
        feesPaid: fees.explicitTotal,
      });
    }
  } else {
    const pos = state.positions.find((p) => p.symbol === args.symbol);
    if (!pos || pos.quantity + 1e-9 < fill.quantity) throw new Error(`Cannot sell ${fill.quantity} ${args.symbol}: not held`);
    const fraction = fill.quantity / pos.quantity;
    const basis = round(pos.costBasis * fraction);
    const proceeds = round(value - fees.explicitTotal);
    realisedPnl = round(proceeds - basis);
    state.cash = round(state.cash + proceeds);
    pos.quantity = round(pos.quantity - fill.quantity, 6);
    pos.costBasis = round(pos.costBasis - basis);
    if (pos.quantity <= 1e-9) state.positions = state.positions.filter((p) => p !== pos);
  }

  const trade: Trade = {
    id: args.tradeId,
    orderId: args.orderId,
    symbol: args.symbol,
    side: args.side,
    quantity: fill.quantity,
    price: fill.price,
    value,
    fees,
    realisedPnl,
    reason: args.reason,
    at: fill.at,
    simulated: args.simulated,
  };
  state.trades.push(trade);
  return trade;
}

export function positionViews(state: EngineState, md: MarketDataProvider): PositionView[] {
  return state.positions.map((p) => {
    const q = md.quote(p.symbol);
    const mark = q?.bid ?? p.avgPrice;
    const marketValue = round(p.quantity * mark);
    const unrealisedPnl = round(marketValue - p.costBasis);
    return {
      ...p,
      name: md.instrument(p.symbol)?.name ?? p.symbol,
      markPrice: mark,
      marketValue,
      unrealisedPnl,
      unrealisedPct: p.costBasis > 0 ? round((unrealisedPnl / p.costBasis) * 100, 2) : 0,
    };
  });
}

export function equityOf(state: EngineState, md: MarketDataProvider): number {
  return round(state.cash + positionViews(state, md).reduce((s, p) => s + p.marketValue, 0));
}

export function realisedTotal(state: EngineState): number {
  return round(state.trades.reduce((s, t) => s + (t.realisedPnl ?? 0), 0));
}
