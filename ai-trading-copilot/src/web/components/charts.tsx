import { useMemo, useState } from "react";
import type { EquityPoint } from "../../core/types";
import { gbp, time } from "./format";

/** Equity curve with a dashed starting-capital baseline. Touch/drag to inspect. */
export function EquityChart({ points, baseline }: { points: EquityPoint[]; baseline: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 340, H = 150, P = 6;
  const geo = useMemo(() => {
    const pts = points.length >= 2 ? points : [...points, ...points];
    const vals = pts.map((p) => p.equity).concat(baseline);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.15, baseline * 0.004);
    lo -= pad; hi += pad;
    const t0 = pts[0]!.t, t1 = pts[pts.length - 1]!.t || t0 + 1;
    const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * P);
    const y = (v: number) => P + (1 - (v - lo) / (hi - lo)) * (H - 2 * P);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${H}L${x(t0).toFixed(1)},${H}Z`;
    return { pts, x, y, line, area, base: y(baseline) };
  }, [points, baseline]);

  const last = geo.pts[geo.pts.length - 1]!;
  const up = last.equity >= baseline;
  const color = up ? "var(--up)" : "var(--down)";
  const h = hover !== null ? geo.pts[hover] : undefined;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const fx = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    geo.pts.forEach((p, i) => { const d = Math.abs(geo.x(p.t) - fx); if (d < bd) { bd = d; best = i; } });
    setHover(best);
  };

  return (
    <div>
      <div className="chart-legend" style={{ marginTop: 0 }}>
        <span>{h ? `${gbp(h.equity)} · ${time(h.t)}` : ""}</span>
        <span>– – start {gbp(baseline)}</span>
      </div>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Equity history chart">
        <defs>
          <linearGradient id="eqfill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={up ? "#3ee6a8" : "#ff6b6b"} stopOpacity="0.28" />
            <stop offset="1" stopColor={up ? "#3ee6a8" : "#ff6b6b"} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={0} x2={W} y1={geo.base} y2={geo.base} stroke="var(--line-2)" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />
        <path d={geo.area} fill="url(#eqfill)" />
        <path d={geo.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        {h && <line x1={geo.x(h.t)} x2={geo.x(h.t)} y1={0} y2={H} stroke="var(--text-3)" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      </svg>
      <div className="chart-legend">
        <span>{time(geo.pts[0]!.t)}</span>
        <span>now</span>
      </div>
    </div>
  );
}

export function Sparkline({ values, w = 64, h = 26 }: { values: number[]; w?: number; h?: number }) {
  if (values.length < 2) return <svg width={w} height={h} />;
  const lo = Math.min(...values), hi = Math.max(...values);
  const span = hi - lo || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / span) * (h - 4)).toFixed(1)}`).join("");
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth={1.6} strokeLinejoin="round" />
    </svg>
  );
}
