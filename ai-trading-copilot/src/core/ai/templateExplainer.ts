import type { Explanation } from "../types";
import type { ExplanationInput, TradeExplainer } from "./explainer";

const gbp = (x: number) => `£${x.toFixed(2)}`;
const px = (x: number) => (x >= 100 ? x.toFixed(2) : x >= 10 ? x.toFixed(3) : x.toFixed(4));

/** Deterministic, offline explanation built only from the rule results. Zero cost. */
export class TemplateExplainer implements TradeExplainer {
  readonly name = "Rules template";

  async explain(i: ExplanationInput, now: number): Promise<Explanation> {
    const ind = i.signal.indicators;
    const passed = i.signal.rules.filter((r) => r.passed);
    const rr = i.riskGBP > 0 ? i.rewardGBP / i.riskGBP : 0;
    return {
      source: "TEMPLATE",
      summary:
        `${i.instrument.name} (${i.instrument.symbol}) passed all ${passed.length} trend and momentum rules on ${i.dataSource.toLowerCase()} data. ` +
        `The plan buys ${i.quantity} units (about ${gbp(i.notionalGBP)}) with a stop at ${px(i.stopPrice)} and a target at ${px(i.targetPrice)}. ` +
        `If the stop is hit the expected loss is about ${gbp(i.riskGBP)} including costs; the target would make about ${gbp(i.rewardGBP)} (${rr.toFixed(1)}:1).`,
      whyNow: [
        `Short-term average (${px(ind.smaFast ?? 0)}) is above the longer one (${px(ind.smaSlow ?? 0)}) and rising.`,
        `RSI ${ind.rsi} shows positive momentum without being stretched.`,
        `Volatility is calm (ATR ${ind.atrPct}% of price), so the stop is tight.`,
      ],
      risks: [
        "Trend signals often fail; most trades of this type are small losses.",
        "Prices can gap through the stop, so the loss can exceed the plan.",
        `Estimated costs of ${gbp(i.estCostsGBP)} are a meaningful share of a small trade.`,
      ],
      invalidation: `The idea is wrong if price closes below ${px(i.stopPrice)} or the short-term average falls below the long-term one.`,
      generatedAt: now,
      costGBP: 0,
    };
  }
}
