import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, getToken, modeInfo, setToken, type AppState, type CopilotApi } from "./api/client";
import { useNow } from "./components/controls";
import { IconBell, IconHome, IconList, IconRadar, IconShield, Logo } from "./components/icons";
import { Activity, Approvals, Home, Markets, Risk } from "./screens";

type Tab = "home" | "approvals" | "markets" | "activity" | "risk";

export function App({ api }: { api: CopilotApi }) {
  const [s, setS] = useState<AppState | null>(null);
  const [tab, setTab] = useState<Tab>("home");
  const [activityTab, setActivityTab] = useState<string | undefined>();
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [needToken, setNeedToken] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow(1000);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const refresh = useCallback(async () => {
    try {
      const st = await api.state();
      setS(st);
      setErr(null);
      setNeedToken(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setNeedToken(true);
      else setErr("Can't reach the server. Nothing will be traded while disconnected.");
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 2500);
    return () => clearInterval(t);
  }, [refresh]);

  const show = (msg: string, bad = false) => {
    setToast({ msg, bad });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  };

  const act = async (label: string, f: () => Promise<unknown>, busyId?: string) => {
    if (busyId) setBusy(busyId);
    try {
      const r = (await f()) as { status?: string; statusReason?: string } | undefined;
      if (r && r.status === "BLOCKED") show(`Blocked: ${r.statusReason ?? "risk check failed"}`, true);
      else show(label);
    } catch (e) {
      show((e as Error).message, true);
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const go = (t: string) => {
    const [main, sub] = t.split(":");
    setActivityTab(sub);
    setTab(main as Tab);
    window.scrollTo({ top: 0 });
  };

  if (needToken) return <TokenScreen onSave={(t) => { setToken(t); void refresh(); }} />;

  if (!s) {
    return (
      <div className="app"><div className="empty" style={{ marginTop: "30vh" }}>{err ?? "Loading…"}</div></div>
    );
  }

  const stale = !s.dataHealth.ok;
  const m = modeInfo(s);
  return (
    <>
      <div className="app">
        <header className="topbar">
          <div className="brand"><span className="brand-mark"><Logo /></span>Pete’s Trading</div>
          <div style={{ display: "flex", gap: 6 }}>
            <span className={`pill ${m.cls}`} title={m.badge}><span className="dot" />{m.short}</span>
            {s.autoTrade.enabled && <span className="pill accent">Auto</span>}
            {s.emergencyStop.active ? <span className="pill bad">Stopped</span> : stale ? <span className="pill bad">Data stale</span> : null}
          </div>
        </header>

        {err && <div className="banner bad"><strong>Offline.</strong> {err}</div>}
        {m.key === "live" && !s.emergencyStop.active && (
          <div className="banner bad"><span>£</span><span><strong>Real money.</strong> {s.autoTrade.enabled ? "Auto mode is ON – trades are placed without asking you." : "Every trade waits for your approval."}</span></div>
        )}
        {s.warnings.length > 0 && (
          <div className="banner warn"><span>⚠︎</span><span>{s.warnings.join(" · ")}</span></div>
        )}
        {s.emergencyStop.active && (
          <div className="banner bad"><span>⛔</span><span><strong>Emergency stop is on.</strong> No new orders will be sent. {s.emergencyStop.reason}</span></div>
        )}
        {stale && !s.emergencyStop.active && (
          <div className="banner warn"><span>⚠︎</span><span><strong>Market data is stale.</strong> Order submission is paused until fresh prices arrive. {s.dataHealth.detail}</span></div>
        )}
        {tab === "home" && api.kind === "standalone" && (
          <div className="banner warn"><span>ⓘ</span><span><strong>Preview.</strong> Runs entirely in your browser with simulated prices and a paper broker. No real money, no live data, no broker connection.</span></div>
        )}

        {tab === "home" && <Home s={s} go={go} act={act} close={(sym) => api.closePosition(sym)} />}
        {tab === "approvals" && <Approvals s={s} now={now} busy={busy} act={act} api={api} />}
        {tab === "markets" && <Markets s={s} />}
        {tab === "activity" && <Activity key={activityTab} s={s} initial={activityTab} />}
        {tab === "risk" && <Risk s={s} act={act} api={api} />}

        <p className="faint" style={{ fontSize: 11, textAlign: "center", margin: "18px 0 0" }}>
          {m.simulated ? "Simulated demo. Prices, fills and P&L are not real." : `Connected to ${s.broker.name}. Prices are end-of-day; fills come from the broker.`} Nothing here is financial advice.
        </p>
      </div>

      {toast && <div className={`toast ${toast.bad ? "bad" : ""}`} role="status">{toast.msg}</div>}

      <nav className="tabbar" aria-label="Main">
        <div className="tabbar-inner">
          {([
            ["home", "Home", <IconHome />],
            ["approvals", "Approvals", <IconBell />],
            ["markets", "Markets", <IconRadar />],
            ["activity", "Activity", <IconList />],
            ["risk", "Risk", <IconShield />],
          ] as const).map(([id, label, icon]) => (
            <button key={id} className={`tab ${tab === id ? "on" : ""}`} onClick={() => go(id)} aria-current={tab === id ? "page" : undefined}>
              {icon}
              {label}
              {id === "approvals" && s.pending.length > 0 && <span className="badge">{s.pending.length}</span>}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}

function TokenScreen({ onSave }: { onSave: (t: string) => void }) {
  const [t, setT] = useState(getToken());
  return (
    <div className="app login">
      <div className="card">
        <div className="brand" style={{ marginBottom: 14 }}><span className="brand-mark"><Logo /></span>Pete’s Trading</div>
        <p className="muted" style={{ fontSize: 14 }}>Enter your app access token. It is stored only on this device and is not a broker credential.</p>
        <div className="field">
          <input className="input" type="password" autoComplete="current-password" value={t} onChange={(e) => setT(e.target.value)} placeholder="Access token" />
          <button className="btn small" onClick={() => onSave(t.trim())}>Unlock</button>
        </div>
      </div>
    </div>
  );
}
