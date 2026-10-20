let counter = 0;

/** Unique, sortable-ish id. Uses crypto.randomUUID when available (Node 20+, modern browsers). */
export function newId(prefix: string): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rand = c?.randomUUID ? c.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}_${rand}`;
}
