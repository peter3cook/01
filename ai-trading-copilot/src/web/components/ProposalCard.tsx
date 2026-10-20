import type { Proposal } from "../../core/types";
import { Check, HoldButton } from "./controls";
import { gbp, price, qty } from "./format";

export function ProposalCard({ p, now, busy, onApprove, onReject }: { p: Proposal; now: number; busy: boolean; onApprove: () => void; onReject: () => void }) {
  const total = p.expiresAt - p.createdAt;
  const left = Math.max(0, p.expiresAt - now);
  const frac = total > 0 ? left / total : 0;
  const mm = Math.floor(left / 60000);
  const ss = Math.floor((left % 60000) / 1000).toString().padStart(2, "0");
  const level = left < 30_000 ? "crit" : left < 120_000 ? "warn" : "";
  const expired = left <= 0;
  const rr = p.riskGBP > 0 ? p.rewardGBP / p.riskGBP : 0;
  const costs = p.estCosts.explicitTotal + p.estCosts.spreadCost;
  const e = p.explanation;

  return (
    <article className="card proposal" aria-label={`Proposed trade ${p.symbol}`}>
      <div className="proposal-head">
        <div className="ticker">{p.symbol}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3>Buy {p.symbol}</h3>
          <div className="faint" style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.instrumentName}</div>
        </div>
        <span className="pill sim">Simulated</span>
      </div>

      <div className="expiry">
        <span>{expired ? "Expired" : p.status === "APPROVED" ? "Executing…" : "Approval expires in"}</span>
        <span className="num" style={{ fontWeight: 650, color: level === "crit" ? "var(--down)" : level === "warn" ? "var(--warn)" : "var(--text)" }}>
          {expired ? "0:00" : `${mm}:${ss}`}
        </span>
      </div>
      <div className={`expiry-bar ${level}`}><span style={{ width: `${frac * 100}%` }} /></div>

      <div className="kv">
        <div><div className="k">Amount</div><div className="v num">{gbp(p.notionalGBP)}</div></div>
        <div><div className="k">Quantity</div><div className="v num">{qty(p.quantity)}</div></div>
        <div><div className="k">Entry</div><div className="v num">{price(p.entryPrice)}</div></div>
        <div><div className="k">Stop-loss</div><div className="v num down">{price(p.stopPrice)}</div></div>
        <div><div className="k">Target</div><div className="v num up">{price(p.targetPrice)}</div></div>
        <div><div className="k">Reward:risk</div><div className="v num">{rr.toFixed(1)}×</div></div>
        <div><div className="k">Max loss</div><div className="v num down">{gbp(p.riskGBP)}</div></div>
        <div><div className="k">At target</div><div className="v num up">{gbp(p.rewardGBP)}</div></div>
        <div><div className="k">Est. costs</div><div className="v num">{gbp(costs, 3)}</div></div>
      </div>

      <section className="ai" aria-label="Explanation">
        <div className="ai-head">
          <span>{e.source === "CLAUDE" ? "✦ Claude explanation" : "Rules-based explanation"}</span>
          <span className="faint" style={{ fontWeight: 500 }}>{e.source === "CLAUDE" ? e.model : "no AI cost"}</span>
        </div>
        <p>{e.summary}</p>
        {e.whyNow.length > 0 && (<><h4>Why now</h4><ul>{e.whyNow.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
        {e.risks.length > 0 && (<><h4>Risks</h4><ul>{e.risks.map((x, i) => <li key={i}>{x}</li>)}</ul></>)}
        {e.invalidation && (<><h4>What would prove it wrong</h4><ul><li>{e.invalidation}</li></ul></>)}
        {e.note && <div className="disclaimer">{e.note}</div>}
        <div className="disclaimer">Explanations describe the rules – they cannot change the trade. Not financial advice.</div>
      </section>

      <details className="more">
        <summary><span>Strategy rules · {p.signal.rules.filter((r) => r.passed).length}/{p.signal.rules.length} passed</span><span>›</span></summary>
        <div className="checks">{p.signal.rules.map((r) => <Check key={r.id} passed={r.passed} label={r.label} detail={r.detail} />)}</div>
      </details>
      <details className="more">
        <summary><span>Risk checks · {p.preTradeRisk.checks.filter((c) => c.passed).length}/{p.preTradeRisk.checks.length} passed</span><span>›</span></summary>
        <div className="checks">{p.preTradeRisk.checks.map((c) => <Check key={c.id} passed={c.passed} label={c.label} detail={c.detail} />)}</div>
        <p className="faint" style={{ fontSize: 12, marginBottom: 0 }}>All checks run again with a fresh price when you approve. If any fails, no order is sent.</p>
      </details>

      <div className="actions">
        <button className="btn" onClick={onReject} disabled={busy || expired || p.status !== "PENDING"}>Reject</button>
        <HoldButton label={busy || p.status === "APPROVED" ? "Sending…" : "Hold to approve"} onConfirm={onApprove} disabled={busy || expired || p.status !== "PENDING"} />
      </div>
      <p className="faint" style={{ fontSize: 11.5, margin: "10px 0 0", textAlign: "center" }}>
        Approving sends one simulated buy order. The stop-loss and target exits are part of this plan.
      </p>
    </article>
  );
}
