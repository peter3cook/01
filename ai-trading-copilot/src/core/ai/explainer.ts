import type { Explanation, Instrument, RiskDecision, Signal } from "../types";

/** Facts handed to the explainer. The explainer can only describe the trade – it cannot change it. */
export interface ExplanationInput {
  instrument: Instrument;
  signal: Signal;
  quantity: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  notionalGBP: number;
  riskGBP: number;
  rewardGBP: number;
  estCostsGBP: number;
  risk: RiskDecision;
  accountEquityGBP: number;
  dataSource: string;
}

export interface TradeExplainer {
  readonly name: string;
  explain(input: ExplanationInput, now: number): Promise<Explanation>;
}

export interface AiBudget {
  /** Called before a paid call; return false to skip (falls back to template). */
  allow(now: number): boolean;
  record(costGBP: number, now: number): void;
}

/**
 * Wraps a paid explainer (Claude) with a daily budget, a timeout and a
 * deterministic fallback, so AI cost and availability never block the workflow.
 */
export class FallbackExplainer implements TradeExplainer {
  readonly name: string;
  constructor(
    private readonly primary: TradeExplainer | undefined,
    private readonly fallback: TradeExplainer,
    private readonly budget: AiBudget,
    private readonly timeoutMs = 15_000,
  ) {
    this.name = primary ? `${primary.name} → ${fallback.name}` : fallback.name;
  }

  async explain(input: ExplanationInput, now: number): Promise<Explanation> {
    if (!this.primary) return this.fallback.explain(input, now);
    if (!this.budget.allow(now)) {
      const e = await this.fallback.explain(input, now);
      return { ...e, note: "Daily AI budget reached – rules-based explanation shown." };
    }
    try {
      const e = await withTimeout(this.primary.explain(input, now), this.timeoutMs);
      this.budget.record(e.costGBP, now);
      return e;
    } catch (err) {
      const e = await this.fallback.explain(input, now);
      return { ...e, note: `AI explanation unavailable (${(err as Error).message.slice(0, 80)}) – rules-based explanation shown.` };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
