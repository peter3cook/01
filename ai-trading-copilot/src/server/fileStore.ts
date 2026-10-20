import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateStore } from "../core/engine";
import type { AuditEntry, EngineState } from "../core/types";

/** JSON state file with atomic writes (write temp file, then rename). */
export class FileStore implements StateStore {
  private readonly file: string;
  constructor(private readonly dir: string, name = "state.json") {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, name);
  }
  load(): EngineState | undefined {
    if (!existsSync(this.file)) return undefined;
    return JSON.parse(readFileSync(this.file, "utf8")) as EngineState;
  }
  save(state: EngineState): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.file);
  }
  readJson<T>(name: string): T | undefined {
    const f = join(this.dir, name);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
  }
  writeJson(name: string, value: unknown): void {
    const f = join(this.dir, name);
    writeFileSync(`${f}.tmp`, JSON.stringify(value));
    renameSync(`${f}.tmp`, f);
  }
}

/** Never-truncated, append-only audit trail on disk (one JSON entry per line). */
export function auditAppender(dir: string): (e: AuditEntry) => void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "audit.jsonl");
  return (e) => appendFileSync(file, JSON.stringify(e) + "\n");
}
