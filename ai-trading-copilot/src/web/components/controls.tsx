import { useEffect, useRef, useState } from "react";

/** Press-and-hold to confirm. Prevents accidental approvals from a stray tap. */
export function HoldButton({ label, onConfirm, disabled, ms = 900 }: { label: string; onConfirm: () => void; disabled?: boolean; ms?: number }) {
  const [p, setP] = useState(0);
  const raf = useRef<number>();
  const start = useRef(0);
  const fired = useRef(false);

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = undefined;
    if (!fired.current) setP(0);
  };
  const begin = (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    fired.current = false;
    start.current = performance.now();
    const step = () => {
      const v = Math.min(1, (performance.now() - start.current) / ms);
      setP(v);
      if (v >= 1) {
        fired.current = true;
        navigator.vibrate?.(20);
        onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
  };
  useEffect(() => () => stop(), []);

  return (
    <button
      className="btn hold"
      disabled={disabled}
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => { if (e.key === "Enter" && !disabled && window.confirm(`${label}?`)) onConfirm(); }}
      aria-label={`${label} – press and hold to confirm`}
    >
      <span className="fill" style={{ transform: `scaleX(${p})` }} />
      <span className="label">{p > 0 && p < 1 ? "Keep holding…" : label}</span>
    </button>
  );
}

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Check({ passed, label, detail }: { passed: boolean; label: string; detail?: string }) {
  return (
    <div className={`check ${passed ? "pass" : "fail"}`}>
      <span className="ic">{passed ? "✓" : "✕"}</span>
      <div>
        <div>{label}</div>
        {detail && <div className="d">{detail}</div>}
      </div>
    </div>
  );
}

export function Score({ score, n = 6 }: { score: number; n?: number }) {
  const on = Math.round(score * n);
  return (
    <span className="score" aria-label={`${on} of ${n} rules`}>
      {Array.from({ length: n }, (_, i) => <i key={i} className={i < on ? "on" : ""} />)}
    </span>
  );
}
