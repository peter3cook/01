import type { AuditEntry } from "../core/types";

export interface Notifier {
  readonly name: string;
  send(title: string, body: string, urgent?: boolean): Promise<void>;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/** ntfy.sh (free iPhone app). Use a long random topic, or a token on a private server. */
export class NtfyNotifier implements Notifier {
  readonly name = "ntfy";
  constructor(private readonly url: string, private readonly token?: string, private readonly fetchImpl: Fetch = fetch as unknown as Fetch) {}
  async send(title: string, body: string, urgent = false) {
    const res = await this.fetchImpl(this.url, {
      method: "POST",
      headers: { Title: title.replace(/[^\x20-\x7E]/g, ""), Priority: urgent ? "high" : "default", ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      body,
    });
    if (!res.ok) throw new Error(`ntfy ${res.status}`);
  }
}

/** Telegram bot message to your own chat. */
export class TelegramNotifier implements Notifier {
  readonly name = "Telegram";
  constructor(private readonly token: string, private readonly chatId: string, private readonly fetchImpl: Fetch = fetch as unknown as Fetch) {}
  async send(title: string, body: string) {
    const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: `${title}\n${body}` }),
    });
    if (!res.ok) throw new Error(`Telegram ${res.status}`);
  }
}

// Audit events that go to your phone, and whether they're urgent.
const NOTIFY: Record<string, { title: string; urgent?: boolean }> = {
  PROPOSAL_CREATED: { title: "New trade idea" },
  ORDER_ACCEPTED: { title: "Buy order placed" },
  ORDER_FILLED: { title: "Bought" },
  ORDER_REJECTED: { title: "Order rejected", urgent: true },
  ORDER_BLOCKED: { title: "Order blocked by risk check" },
  ORDER_UNCERTAIN: { title: "Checking an order", urgent: true },
  ORDER_NOT_PLACED: { title: "Order not placed" },
  ENTRY_NOT_FILLED: { title: "Buy not filled" },
  STOP_PLACED: { title: "Stop-loss set" },
  STOP_NOT_PLACED: { title: "STOP-LOSS NOT SET", urgent: true },
  STOP_LOST: { title: "Stop-loss replaced", urgent: true },
  POSITION_CLOSED: { title: "Sold" },
  EXIT_ABORTED: { title: "Sell aborted", urgent: true },
  EXIT_NOT_FILLED: { title: "Sell not filled", urgent: true },
  EMERGENCY_STOP_ON: { title: "EMERGENCY STOP", urgent: true },
  EMERGENCY_STOP_OFF: { title: "Emergency stop released" },
  AUTO_MODE_ON: { title: "Auto mode ON", urgent: true },
  AUTO_MODE_OFF: { title: "Auto mode off" },
  SYNC_FAILED: { title: "Broker sync failed", urgent: true },
  EXTERNAL_POSITION: { title: "Unmanaged holding found" },
  POSITION_VANISHED: { title: "Position missing", urgent: true },
  DATA_PROBLEM: { title: "Price data problem", urgent: true },
};

/** Turns audit entries into phone notifications. Repeated identical alerts are throttled. */
export function auditNotifier(notifier: Notifier | undefined, prefix: string, log: (msg: string) => void) {
  const recent = new Map<string, number>();
  return (e: AuditEntry) => {
    const n = NOTIFY[e.type];
    if (!notifier || !n) return;
    const key = `${e.type}:${e.message}`;
    const last = recent.get(key) ?? 0;
    if (e.at - last < 30 * 60_000) return;
    recent.set(key, e.at);
    notifier.send(`${prefix}${n.title}`, e.message, n.urgent).catch((err) => log(`notification failed: ${(err as Error).message}`));
  };
}
