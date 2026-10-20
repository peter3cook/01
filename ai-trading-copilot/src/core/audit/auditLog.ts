import type { AuditActor, AuditEntry } from "../types";
import { sha256Hex } from "../util/sha256";

const GENESIS = "0".repeat(64);
const MAX_ENTRIES = 5000;

function digest(e: Omit<AuditEntry, "hash">): string {
  return sha256Hex(JSON.stringify([e.seq, e.at, e.actor, e.type, e.message, e.data ?? null, e.prevHash]));
}

/** Append-only, hash-chained audit log. Editing or deleting an entry breaks the chain. */
export function appendAudit(
  log: AuditEntry[],
  at: number,
  actor: AuditActor,
  type: string,
  message: string,
  data?: Record<string, unknown>,
): AuditEntry {
  const prev = log[log.length - 1];
  const base = { seq: (prev?.seq ?? 0) + 1, at, actor, type, message, data, prevHash: prev?.hash ?? GENESIS };
  const entry: AuditEntry = { ...base, hash: digest(base) };
  log.push(entry);
  // Keep the in-memory log bounded. The server also appends every entry to an
  // on-disk JSONL file that is never truncated.
  if (log.length > MAX_ENTRIES) log.splice(0, log.length - MAX_ENTRIES);
  return entry;
}

export function verifyAudit(log: AuditEntry[]): { ok: boolean; brokenAt?: number } {
  for (let i = 0; i < log.length; i++) {
    const e = log[i]!;
    if (i > 0 && e.prevHash !== log[i - 1]!.hash) return { ok: false, brokenAt: e.seq };
    const { hash, ...rest } = e;
    if (digest(rest) !== hash) return { ok: false, brokenAt: e.seq };
  }
  return { ok: true };
}
