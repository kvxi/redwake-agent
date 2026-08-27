import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSIONS_ROOT } from "../config.ts";
import { isSessionEvent, type SessionEvent } from "./conversation-state.ts";

/** Persisted envelope. Parent links retain a path toward future branching. */
export interface SessionRecord {
  id: number;
  parent: number | null;
  event: SessionEvent;
}
export type SessionMessage = SessionRecord;

export interface SessionStoreOptions {
  /** Optional redaction/truncation hook applied just before writing to disk. */
  prepareEvent?: (event: SessionEvent) => SessionEvent;
}

/** Append-only canonical JSONL store for one session. */
export class SessionStore {
  private nextId = 0;
  private lastId: number | null = null;
  private readonly prepareEvent: (event: SessionEvent) => SessionEvent;

  constructor(readonly path: string, options: SessionStoreOptions = {}) {
    this.prepareEvent = options.prepareEvent ?? ((event) => event);
    const records = this.loadRecords(false);
    if (records.length) {
      this.nextId = Math.max(...records.map((record) => record.id)) + 1;
      this.lastId = records.at(-1)!.id;
    }
  }

  append(event: SessionEvent): void {
    const prepared = this.prepareEvent(structuredClone(event));
    if (!isSessionEvent(prepared)) {
      process.stderr.write("session: refused to persist invalid prepared event\n");
      return;
    }
    const record: SessionRecord = { id: this.nextId, parent: this.lastId, event: prepared };
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
      this.lastId = record.id;
      this.nextId += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`session: failed to persist event: ${detail}\n`);
    }
  }

  /** Load valid events in file order; malformed lines are skipped safely. */
  load(): SessionEvent[] {
    return this.loadRecords(true).map((record) => structuredClone(record.event));
  }

  private loadRecords(reportErrors: boolean): SessionRecord[] {
    if (!existsSync(this.path)) return [];
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (reportErrors) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`session: failed to load events: ${detail}\n`);
      }
      return [];
    }
    const records: SessionRecord[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        let event = value.event;
        // Compatibility with text-only files created by earlier releases.
        if (!event && (value.role === "user" || value.role === "assistant") && typeof value.message === "string") {
          event = { type: value.role, content: value.message };
        }
        if (!Number.isInteger(value.id) || !(value.parent === null || Number.isInteger(value.parent)) || !isSessionEvent(event)) {
          throw new TypeError("invalid record shape");
        }
        records.push({ id: value.id as number, parent: value.parent as number | null, event });
      } catch (error) {
        if (reportErrors) {
          const detail = error instanceof Error ? error.message : String(error);
          process.stderr.write(`session: skipped malformed line ${index + 1}: ${detail}\n`);
        }
      }
    }
    return records;
  }
}

export function createSessionStore(
  cwd: string = process.cwd(),
  root: string = SESSIONS_ROOT,
  options: SessionStoreOptions = {},
): SessionStore {
  const dir = join(root, encodeURIComponent(resolve(cwd)));
  mkdirSync(dir, { recursive: true });
  let max = 0;
  for (const name of readdirSync(dir)) {
    const match = /^session-(\d+)\.jsonl$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return new SessionStore(join(dir, `session-${max + 1}.jsonl`), options);
}
