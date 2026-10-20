import type { DashboardSnapshot } from "../../core/engine";
import type { RiskLimits } from "../../core/types";

export type AppState = DashboardSnapshot & { authRequired?: boolean; outage: boolean; notifications?: string | null };

/** How the app is connected, for labels. */
export function modeInfo(s: Pick<AppState, "mode">) {
  if (s.mode === "live") return { key: "live", badge: "Live · Real money", cls: "bad", simulated: false };
  if (s.mode === "paper") return { key: "paper", badge: "Practice · Trading 212", cls: "accent", simulated: false };
  return { key: "sim", badge: "Demo · Simulated", cls: "sim", simulated: true };
}

/** What the UI can ask for. The UI never talks to a broker or holds credentials. */
export interface CopilotApi {
  readonly kind: "server" | "standalone";
  state(): Promise<AppState>;
  approve(id: string): Promise<unknown>;
  reject(id: string): Promise<unknown>;
  closePosition(symbol: string): Promise<unknown>;
  closeAll(): Promise<unknown>;
  emergencyStop(active: boolean, confirm?: string): Promise<unknown>;
  tightenLimits(patch: Partial<RiskLimits>): Promise<unknown>;
  scan(): Promise<unknown>;
  setOutage(active: boolean): Promise<unknown>;
  setAutoTrade(enabled: boolean, confirm?: string): Promise<unknown>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TOKEN_KEY = "copilot.token";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(t: string) {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode – token kept for this session only */
  }
}

/** Talks to the Copilot server. The only secret it holds is the app access token. */
export class HttpApi implements CopilotApi {
  readonly kind = "server" as const;

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const token = getToken();
    const res = await fetch(`./api${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? (method === "POST" ? "{}" : undefined) : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(data.error ?? `Request failed (${res.status})`, res.status);
    return data as T;
  }

  state() { return this.call<AppState>("GET", "/state"); }
  approve(id: string) { return this.call("POST", `/proposals/${encodeURIComponent(id)}/approve`); }
  reject(id: string) { return this.call("POST", `/proposals/${encodeURIComponent(id)}/reject`); }
  closePosition(s: string) { return this.call("POST", `/positions/${encodeURIComponent(s)}/close`); }
  closeAll() { return this.call("POST", "/positions/close-all"); }
  emergencyStop(active: boolean, confirm?: string) { return this.call("POST", "/emergency-stop", { active, confirm }); }
  tightenLimits(patch: Partial<RiskLimits>) { return this.call("POST", "/limits", patch); }
  scan() { return this.call("POST", "/scan"); }
  setOutage(active: boolean) { return this.call("POST", "/sim/outage", { active }); }
  setAutoTrade(enabled: boolean, confirm?: string) { return this.call("POST", "/auto-trade", { enabled, confirm }); }
}
