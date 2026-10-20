export const gbp = (x: number, dp = 2) =>
  (x < 0 ? "-£" : "£") + Math.abs(x).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
/** Shows sub-penny amounts with 3dp so tiny P&L isn't displayed as "£0.00". */
export const signedGbp = (x: number, dp = 2) => {
  const d = x !== 0 && Math.abs(x) < 0.005 ? 3 : dp;
  return (x > 0 ? "+" : "") + gbp(x, d);
};
export const pct = (x: number, dp = 2) => `${x > 0 ? "+" : ""}${x.toFixed(dp)}%`;
export const price = (x: number) => (x >= 100 ? x.toFixed(2) : x >= 10 ? x.toFixed(3) : x.toFixed(4));
export const qty = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
export const tone = (x: number) => (x > 0.00005 ? "up" : x < -0.00005 ? "down" : "flat");
export const time = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
export const dateTime = (t: number) =>
  new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export function ago(t: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
