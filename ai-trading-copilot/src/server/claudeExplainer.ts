import Anthropic from "@anthropic-ai/sdk";
import type { ExplanationInput, TradeExplainer } from "../core/ai/explainer";
import type { Explanation } from "../core/types";

// USD per million tokens (input, output). Used only to track and cap AI spend.
const PRICING: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};
const USD_TO_GBP = 0.8;

const SYSTEM = `You explain proposed ETF trades to a UK retail investor using a small simulated demo account.
You receive the exact facts of a trade that a rules-based strategy has ALREADY proposed and an independent risk engine has ALREADY checked.
Your job is only to explain it in plain English. You cannot change the trade, its size, its stop or its target, and you must not suggest different numbers.
Rules:
- Use only the facts provided. Do not invent news, fundamentals, forecasts or live prices. The prices are simulated.
- Never promise or imply a likely profit. Be balanced and mention the main risks.
- No jargon without a short explanation. British English. Amounts in £.
- Keep it short: summary under 70 words, at most 3 bullet points per list, each under 25 words.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "whyNow", "risks", "invalidation"],
  properties: {
    summary: { type: "string" },
    whyNow: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    invalidation: { type: "string" },
  },
} as const;

const clip = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Claude-written explanation of a proposed trade. Server-side only: the API key
 * never reaches the browser. Output is treated as display text – it is
 * length-limited and has no influence on orders or risk.
 */
export class ClaudeExplainer implements TradeExplainer {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
    this.name = `Claude (${model})`;
  }

  async explain(i: ExplanationInput, now: number): Promise<Explanation> {
    const facts = {
      instrument: { symbol: i.instrument.symbol, name: i.instrument.name, category: i.instrument.category },
      dataSource: i.dataSource,
      plan: {
        side: "BUY",
        quantity: i.quantity,
        entryPrice: i.entryPrice,
        stopPrice: i.stopPrice,
        targetPrice: i.targetPrice,
        positionValueGBP: i.notionalGBP,
        lossAtStopInclCostsGBP: i.riskGBP,
        gainAtTargetAfterCostsGBP: i.rewardGBP,
        estimatedCostsGBP: i.estCostsGBP,
      },
      strategy: i.signal.strategy,
      rules: i.signal.rules.map((r) => ({ rule: r.label, passed: r.passed, value: r.detail })),
      accountEquityGBP: i.accountEquityGBP,
    };

    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 2000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: `Explain this proposed trade:\n${JSON.stringify(facts, null, 2)}` }],
    });

    if (res.stop_reason === "refusal") throw new Error("model declined");
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const parsed = JSON.parse(text) as { summary?: unknown; whyNow?: unknown; risks?: unknown; invalidation?: unknown };
    const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, 3).map((x) => clip(x, 200)) : []);

    const [pin, pout] = PRICING[res.model] ?? PRICING[this.model] ?? [4, 20];
    const usd = (res.usage.input_tokens * pin + res.usage.output_tokens * pout) / 1_000_000;

    return {
      source: "CLAUDE",
      model: res.model,
      summary: clip(parsed.summary, 600),
      whyNow: list(parsed.whyNow),
      risks: list(parsed.risks),
      invalidation: clip(parsed.invalidation, 300),
      generatedAt: now,
      costGBP: Math.round(usd * USD_TO_GBP * 1e6) / 1e6,
    };
  }
}
