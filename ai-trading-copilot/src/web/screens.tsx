import { useState } from "react";
import type { RiskLimits } from "../core/types";
import type { AppState } from "./api/client";
import { EquityChart, Sparkline } from "./components/charts";
import { Check, Score } from "./components/controls";
import { ago, dateTime, gbp, pct, price, qty, signedGbp, time, tone } from "./components/format";
import { ProposalCard } from "./components/ProposalCard";
import { useConfirm } from "./components/confirm";

type Act = (label: string, f: () => Promise<unknown>, busyId?: string) => Promise<void>;

function Delta({ v, p }: { v: number; p?: number }) {
  const t = tone(v);
  return (
    <span className={`delta ${t}`}>
      <span className="num">{signedGbp(v)}</span>
      {p !== undefined && <span className="num" style={{ opacity: 0.8 }}>{pct(p)}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ Home

export function Home({ s, go, act, close }: { s: AppState; go: (t: string) => void; act: Act; close: (symbol: string) => Promise<unknown> }) {
  const ask = useConfirm();
  const a = s.account;
  const [pounds, pence] = a.equity.toFixed(2).split(".");
  return (
    <>
      <section className="card">
        <div className="hero-label">Account value · simulated</div>
        <div className="hero-value num">£{Number(pounds).toLocaleString("en-GB")}<span className="pence">.{pence}</span></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Delta v={a.totalPnl} p={a.totalPnlPct} />
          <span className="faint" style={{ fontSize: 13 }}>all time</span>
          <span className="faint" style={{ fontSize: 13, marginLeft: "auto" }}>Today <span className={`num ${tone(a.dayPnl)}`}>{signedGbp(a.dayPnl)}</span></span>
        </div>
        <EquityChart points={s.equityHistory} baseline={a.startingCapital} />
        <div className="stats">
          <div className="stat"><div className="k">Cash</div><div className="v num">{gbp(a.cash)}</div></div>
          <div className="stat"><div className="k">Invested</div><div className="v num">{gbp(a.invested)}</div></div>
          <div className="stat"><div className="k">Realised P&amp;L</div><div className={`v num ${tone(a.realisedPnl)}`}>{signedGbp(a.realisedPnl)}</div></div>
          <div className="stat"><div className="k">Unrealised P&amp;L</div><div className={`v num ${tone(a.unrealisedPnl)}`}>{signedGbp(a.unrealisedPnl)}</div></div>
        </div>
      </section>

      {s.pending.length > 0 && (
        <button className="card tight" onClick={() => go("approvals")} style={{ width: "100%", textAlign: "left", cursor: "pointer", borderColor: "rgba(62,230,168,.35)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span className="pill ok"><span className="dot pulse" /> {s.pending.length} waiting</span>
            <span style={{ flex: 1 }}>Trade{s.pending.length > 1 ? "s" : ""} ready for your approval</span>
            <span className="muted">›</span>
          </div>
        </button>
      )}

      <section className="card">
        <div className="card-title"><span>Holdings</span><span className="faint">{s.positions.length} open</span></div>
        {s.positions.length === 0 ? (
          <div className="empty"><div className="big">◌</div>No open positions. Approved trades appear here.</div>
        ) : (
          <div className="list">
            {s.positions.map((p) => (
              <div className="row" key={p.symbol}>
                <div className="ticker">{p.symbol}</div>
                <div className="grow">
                  <div className="t1">{p.symbol}</div>
                  <div className="t2 num">{qty(p.quantity)} @ {price(p.avgPrice)} · stop {price(p.stopPrice)} · target {price(p.targetPrice)}</div>
                </div>
                <div className="right">
                  <div className="num" style={{ fontWeight: 650 }}>{gbp(p.marketValue)}</div>
                  <div className={`num ${tone(p.unrealisedPnl)}`} style={{ fontSize: 12.5 }}>{signedGbp(p.unrealisedPnl)} ({pct(p.unrealisedPct)})</div>
                  <button className="btn small ghost" style={{ marginTop: 6 }} onClick={async () => { if (await ask({ title: `Close ${p.symbol}?`, body: "Sells the whole position at the current simulated bid.", confirmLabel: "Sell all", danger: true })) void act(`Closed ${p.symbol}`, () => close(p.symbol)); }}>Close</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-title"><span>Goal</span><span className="faint">aspiration, not a forecast</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 8 }}>
          <span className="num">{gbp(a.startingCapital, 0)}</span>
          <span className="num muted">{a.goalProgressPct.toFixed(2)}%</span>
          <span className="num">{gbp(a.goalGBP, 0)}</span>
        </div>
        <div className="progress"><span style={{ width: `${a.goalProgressPct}%` }} /></div>
        <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>
          Risk per trade stays fixed at {gbp(s.limits.maxRiskPerTradeGBP)} whatever the balance. The app never increases risk to reach this goal.
        </p>
      </section>

      <section className="card tight">
        <div className="card-title" style={{ marginBottom: 6 }}><span>Costs so far</span><button className="btn small ghost" onClick={() => go("activity:costs")}>Details</button></div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
          <span className="muted">Trading costs</span><span className="num">{gbp(s.costs.tradingTotal, 3)} <span className="faint">({s.costs.tradingPctOfCapital.toFixed(2)}% of capital)</span></span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, marginTop: 4 }}>
          <span className="muted">AI explanations</span><span className="num">{gbp(s.costs.aiCostGBP, 3)} <span className="faint">({s.costs.aiCalls} calls)</span></span>
        </div>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ Approvals

export function Approvals({ s, now, busy, act, api }: { s: AppState; now: number; busy: string | null; act: Act; api: { approve(id: string): Promise<unknown>; reject(id: string): Promise<unknown>; scan(): Promise<unknown> } }) {
  return (
    <>
      <h2 className="section-title">Approvals</h2>
      <p className="sub">Every new trade needs your explicit approval. Requests expire automatically.</p>
      {s.pending.length === 0 ? (
        <section className="card">
          <div className="empty">
            <div className="big">✓</div>
            Nothing waiting. The scanner checks {s.scanner.length} ETFs every {Math.round((s.nextScanAt - s.lastScanAt) / 1000)}s.
            <div style={{ marginTop: 6, fontSize: 12.5 }}>{s.halted.active ? `New trades paused: ${s.halted.reasons[0]}` : `Last scan ${ago(s.lastScanAt, now)}`}</div>
            <button className="btn small" style={{ marginTop: 14 }} onClick={() => void act("Scan complete", () => api.scan())}>Scan now</button>
          </div>
        </section>
      ) : (
        s.pending.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            now={now}
            busy={busy === p.id}
            onApprove={() => void act(`Approved ${p.symbol}`, () => api.approve(p.id), p.id)}
            onReject={() => void act(`Rejected ${p.symbol}`, () => api.reject(p.id), p.id)}
          />
        ))
      )}

      <section className="card">
        <div className="card-title"><span>Recent decisions</span></div>
        {s.recentProposals.length === 0 ? <div className="empty">No decisions yet.</div> : (
          <div className="list">
            {s.recentProposals.slice(0, 15).map((p) => (
              <div className="row" key={p.id}>
                <div className="ticker">{p.symbol}</div>
                <div className="grow">
                  <div className="t1">Buy {qty(p.quantity)} {p.symbol} <StatusChip status={p.status} /></div>
                  <div className="t2">{p.statusReason ?? `${gbp(p.notionalGBP)} · risk ${gbp(p.riskGBP)}`}</div>
                </div>
                <div className="right faint" style={{ fontSize: 12 }}>{p.decidedAt ? ago(p.decidedAt, now) : ""}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function StatusChip({ status }: { status: string }) {
  const cls = status === "EXECUTED" ? "signal" : status === "REJECTED" || status === "EXPIRED" || status === "CANCELLED" ? "none" : status === "BLOCKED" ? "bad" : "accent";
  return <span className={`chip ${cls}`}>{status.toLowerCase()}</span>;
}

// ------------------------------------------------------------------ Markets

export function Markets({ s }: { s: AppState }) {
  const [open, setOpen] = useState<string | null>(null);
  const order = { SIGNAL: 0, WATCH: 1, NO_SETUP: 2, INSUFFICIENT_DATA: 3 } as const;
  const rows = [...s.scanner].sort((a, b) => order[a.signal.status] - order[b.signal.status] || b.signal.score - a.signal.score);
  return (
    <>
      <h2 className="section-title">Market scanner</h2>
      <p className="sub">Liquid UK-listed ETFs · <span style={{ color: "var(--warn)" }}>simulated prices</span> · long-only trend rules</p>
      <section className="card">
        <div className="list">
          {rows.map((r) => {
            const sig = r.signal;
            const chip = sig.status === "SIGNAL" ? "signal" : sig.status === "WATCH" ? "watch" : "none";
            const isOpen = open === r.instrument.symbol;
            return (
              <div key={r.instrument.symbol}>
                <button className="row" style={{ width: "100%", background: "none", border: 0, borderTop: "1px solid var(--line)", cursor: "pointer", textAlign: "left" }} onClick={() => setOpen(isOpen ? null : r.instrument.symbol)} aria-expanded={isOpen}>
                  <div className="ticker">{r.instrument.symbol}</div>
                  <div className="grow">
                    <div className="t1">{r.instrument.symbol} <span className={`chip ${chip}`}>{sig.status === "NO_SETUP" ? "no setup" : sig.status.toLowerCase()}</span></div>
                    <div className="t2">{r.instrument.name}</div>
                    <div style={{ marginTop: 4 }}><Score score={sig.score} /></div>
                  </div>
                  <Sparkline values={r.sparkline} />
                  <div className="right" style={{ minWidth: 64 }}>
                    <div className="num" style={{ fontWeight: 650 }}>{r.quote ? price(r.quote.mid) : "–"}</div>
                    <div className={`num ${tone(r.changePct)}`} style={{ fontSize: 12.5 }}>{pct(r.changePct)}</div>
                  </div>
                </button>
                {isOpen && (
                  <div style={{ padding: "4px 0 14px 52px" }}>
                    <div className="checks">{sig.rules.map((c) => <Check key={c.id} passed={c.passed} label={c.label} detail={c.detail} />)}</div>
                    {sig.status === "SIGNAL" && <p className="faint" style={{ fontSize: 12.5, margin: "10px 0 0" }}>Suggested stop {price(sig.stop)} · target {price(sig.target)}{r.blockedReason ? ` · Not proposed: ${r.blockedReason}` : ""}</p>}
                    <p className="faint" style={{ fontSize: 12, margin: "8px 0 0" }}>{r.instrument.category} · spread ~{r.instrument.spreadBps}bps · T212 ticker {r.instrument.t212Ticker} (to verify)</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <p className="faint" style={{ fontSize: 12, padding: "0 4px" }}>
        Rules: 20-bar average above 50-bar and rising, price above the 20-bar average, RSI 50–70, calm volatility, adequate liquidity. All six must pass. The stop is 2× ATR below entry and the target 3× ATR above.
      </p>
    </>
  );
}

// ------------------------------------------------------------------ Activity

export function Activity({ s, initial }: { s: AppState; initial?: string }) {
  const [tab, setTab] = useState(initial ?? "trades");
  return (
    <>
      <h2 className="section-title">Activity</h2>
      <div className="seg" role="tablist">
        {["trades", "audit", "costs"].map((t) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)} role="tab" aria-selected={tab === t}>{t[0]!.toUpperCase() + t.slice(1)}</button>)}
      </div>

      {tab === "trades" && (
        <section className="card">
          {s.trades.length === 0 ? <div className="empty">No trades yet. Trades only happen after you approve.</div> : (
            <div className="list">
              {s.trades.map((t) => (
                <div className="row" key={t.id}>
                  <div className="ticker" style={{ color: t.side === "BUY" ? "var(--up)" : "var(--accent)" }}>{t.side}</div>
                  <div className="grow">
                    <div className="t1">{t.symbol} <span className="chip none">{t.reason.replace("_", " ").toLowerCase()}</span></div>
                    <div className="t2 num">{qty(t.quantity)} @ {price(t.price)} · {dateTime(t.at)}{t.simulated ? " · simulated" : ""}</div>
                  </div>
                  <div className="right">
                    <div className="num">{gbp(t.value)}</div>
                    {t.realisedPnl !== undefined && <div className={`num ${tone(t.realisedPnl)}`} style={{ fontSize: 12.5 }}>{signedGbp(t.realisedPnl)}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "audit" && (
        <section className="card">
          <div className="card-title">
            <span>Audit log</span>
            <span className={`pill ${s.auditIntegrity.ok ? "ok" : "bad"}`}>{s.auditIntegrity.ok ? "Hash chain intact" : `Broken at #${s.auditIntegrity.brokenAt}`}</span>
          </div>
          {s.audit.map((e) => (
            <div className="audit-row" key={e.seq}>
              <div className="audit-meta"><span className="mono">#{e.seq}</span><span>{time(e.at)}</span><span className="chip none">{e.actor}</span><span className="mono">{e.type}</span></div>
              <div>{e.message}</div>
            </div>
          ))}
        </section>
      )}

      {tab === "costs" && (
        <>
          <section className="card">
            <div className="card-title"><span>Trading costs</span><span className="faint">Trading 212 Invest assumptions</span></div>
            {[
              ["Commission", s.costs.commission, "£0 on Trading 212 Invest"],
              ["FX fee", s.costs.fxFee, "0.15% only on non-GBP instruments – all ETFs here are GBP"],
              ["Stamp duty", s.costs.stampDuty, "ETFs are exempt"],
              ["Spread (implicit)", s.costs.spreadCost, "Buying at the ask and selling at the bid"],
            ].map(([k, v, note]) => (
              <div className="row" key={k as string}>
                <div className="grow"><div className="t1" style={{ fontSize: 14 }}>{k}</div><div className="t2">{note}</div></div>
                <div className="num">{gbp(v as number, 4)}</div>
              </div>
            ))}
            <div className="row"><div className="grow t1">Total</div><div className="num" style={{ fontWeight: 700 }}>{gbp(s.costs.tradingTotal, 4)}</div></div>
          </section>
          <section className="card">
            <div className="card-title"><span>Operating costs</span></div>
            <div className="row"><div className="grow"><div className="t1" style={{ fontSize: 14 }}>Claude explanations</div><div className="t2">{s.costs.aiCalls} calls · daily cap applies · {s.explainer}</div></div><div className="num">{gbp(s.costs.aiCostGBP, 4)}</div></div>
            <p className="faint" style={{ fontSize: 12.5, margin: "8px 0 0" }}>Without an API key the app uses free rules-based explanations. See the deployment guide for hosting cost estimates.</p>
          </section>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ Risk

const EDITABLE: { key: keyof RiskLimits; label: string; unit: "gbp" | "n" | "min" }[] = [
  { key: "maxRiskPerTradeGBP", label: "Max risk per trade", unit: "gbp" },
  { key: "maxPositionValueGBP", label: "Max position size", unit: "gbp" },
  { key: "maxDailyLossGBP", label: "Daily loss limit", unit: "gbp" },
  { key: "maxOpenPositions", label: "Max open positions", unit: "n" },
  { key: "maxTradesPerDay", label: "Max new trades per day", unit: "n" },
  { key: "equityFloorGBP", label: "Equity floor (auto stop)", unit: "gbp" },
  { key: "proposalTtlMs", label: "Approval window", unit: "min" },
];

export function Risk({ s, act, api }: { s: AppState; act: Act; api: { emergencyStop(a: boolean, c?: string): Promise<unknown>; tightenLimits(p: Partial<RiskLimits>): Promise<unknown>; closeAll(): Promise<unknown>; setOutage(a: boolean): Promise<unknown> } }) {
  const ask = useConfirm();
  const [edit, setEdit] = useState<keyof RiskLimits | null>(null);
  const [val, setVal] = useState("");
  const es = s.emergencyStop;
  const fmt = (k: keyof RiskLimits, unit: string, v: number) => (unit === "gbp" ? gbp(v) : unit === "min" ? `${Math.round(v / 60000)} min` : String(v));

  return (
    <>
      <h2 className="section-title">Risk &amp; safety</h2>
      <button
        className={`estop ${es.active ? "on" : ""}`}
        onClick={async () => {
          if (!es.active) {
            if (await ask({ title: "Engage emergency stop?", body: "All pending approvals are cancelled and no new orders will be sent until you release it.", confirmLabel: "Stop trading", danger: true })) void act("Emergency stop engaged", () => api.emergencyStop(true));
          } else {
            const c = await ask({ title: "Release emergency stop?", body: "New proposals and approvals will be allowed again.", confirmLabel: "Release", typeToConfirm: "RESUME" });
            if (c) void act("Emergency stop released", () => api.emergencyStop(false, c.trim()));
          }
        }}
      >
        {es.active ? "Emergency stop is ON — tap to release" : "Emergency stop"}
        <small>{es.active ? `${es.reason ?? ""}${es.since ? ` · since ${time(es.since)}` : ""}` : "Halts all new orders and cancels pending approvals"}</small>
      </button>
      {es.active && s.positions.length > 0 && (
        <button className="btn danger block" style={{ marginTop: 10 }} onClick={async () => { if (await ask({ title: "Close all positions?", body: "Sells every holding at the current simulated bid.", confirmLabel: "Sell all", danger: true })) void act("Closing all positions", () => api.closeAll()); }}>Close all positions</button>
      )}

      <section className="card" style={{ marginTop: 14 }}>
        <div className="card-title"><span>Trading status</span><span className={`pill ${s.halted.active ? "bad" : "ok"}`}>{s.halted.active ? "Paused" : "Active"}</span></div>
        {s.halted.active ? <div className="checks">{s.halted.reasons.map((r) => <Check key={r} passed={false} label={r} />)}</div> : <Check passed label="All safety conditions met – new proposals allowed" />}
        <div style={{ marginTop: 12 }} className="checks">
          <Check passed label="Demo mode only – live trading disabled" detail="No real-money endpoint is configured or reachable from this build" />
          <Check passed label="No leverage, CFDs, margin or shorting" detail="Cash-only, buy-only ETF entries" />
          <Check passed={s.dataHealth.ok} label={`Market data: ${s.dataHealth.source.toLowerCase()}`} detail={s.dataHealth.detail} />
        </div>
      </section>

      <section className="card">
        <div className="card-title"><span>Limits</span><span className="faint">tighten-only in app</span></div>
        <div className="list">
          {EDITABLE.map(({ key, label, unit }) => (
            <div className="row" key={key} style={{ flexWrap: "wrap" }}>
              <div className="grow"><div className="t1" style={{ fontSize: 14 }}>{label}</div><div className="t2">{key === "equityFloorGBP" ? "Can only be raised in the app" : `Hard ceiling ${fmt(key, unit, s.ceilings[key])}`}</div></div>
              <div className="num" style={{ fontWeight: 650 }}>{fmt(key, unit, s.limits[key])}</div>
              <button className="btn small ghost" onClick={() => { setEdit(edit === key ? null : key); setVal(""); }}>Tighten</button>
              {edit === key && (
                <div className="field" style={{ width: "100%" }}>
                  <input className="input" inputMode="decimal" placeholder={unit === "min" ? "minutes" : unit === "gbp" ? "£" : "number"} value={val} onChange={(e) => setVal(e.target.value)} />
                  <button className="btn small" onClick={() => {
                    const n = Number(val);
                    if (!Number.isFinite(n)) return;
                    const v = unit === "min" ? n * 60000 : n;
                    void act("Limit tightened", () => api.tightenLimits({ [key]: v })).then(() => setEdit(null));
                  }}>Save</button>
                </div>
              )}
            </div>
          ))}
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Stale data cut-off</div><div className="num">{s.limits.maxDataAgeMs / 1000}s</div></div>
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Max price move before execution</div><div className="num">{s.limits.maxPriceDriftBps}bps</div></div>
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Costs as share of risk</div><div className="num">≤ {Math.round(s.limits.maxCostToRiskRatio * 100)}%</div></div>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: "10px 0 0" }}>Limits are fixed £ amounts. They never rise automatically as the balance grows. Loosening needs a reviewed server config change, and can never exceed the hard ceilings.</p>
      </section>

      <section className="card">
        <div className="card-title"><span>System</span></div>
        <div className="list">
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Mode</div><span className="pill sim">{s.mode} · simulated</span></div>
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Broker</div><span className="muted" style={{ fontSize: 13 }}>{s.broker.name}</span></div>
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>Explanations</div><span className="muted" style={{ fontSize: 13 }}>{s.explainer}</span></div>
          <div className="row"><div className="grow t1" style={{ fontSize: 14 }}>New trades today</div><span className="num">{s.entriesToday} / {s.limits.maxTradesPerDay}</span></div>
          <div className="row">
            <div className="grow"><div className="t1" style={{ fontSize: 14 }}>Simulate data outage</div><div className="t2">Test the stale-data safeguard</div></div>
            <button className={`btn small ${s.outage ? "danger" : ""}`} onClick={() => void act(s.outage ? "Data feed restored" : "Data outage simulated", () => api.setOutage(!s.outage))}>{s.outage ? "Restore feed" : "Start outage"}</button>
          </div>
        </div>
      </section>
    </>
  );
}
