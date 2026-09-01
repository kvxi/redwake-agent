import { appendFileSync, chmodSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensurePrivateDirectory, SESSIONS_ROOT } from "../paths.ts";
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

interface ScanResult {
  records: SessionRecord[];
  leaf: number | null;
  maxId: number | null;
}

/** Append-only canonical JSONL store for one session. */
export class SessionStore {
  private nextId = 0;
  private lastId: number | null = null;
  private warnedAboutPath = false;
  private readonly prepareEvent: (event: SessionEvent) => SessionEvent;

  constructor(readonly path: string, options: SessionStoreOptions = {}) {
    this.prepareEvent = options.prepareEvent ?? ((event) => event);
    if (existsSync(path)) chmodSync(path, 0o600);
    const scan = this.scan(false);
    this.nextId = scan.maxId === null ? 0 : scan.maxId + 1;
    this.lastId = scan.leaf;
  }

  get leaf(): number | null {
    return this.lastId;
  }

  append(event: SessionEvent): SessionRecord | null {
    const prepared = this.prepareEvent(structuredClone(event));
    if (!isSessionEvent(prepared)) {
      process.stderr.write("session: refused to persist invalid prepared event\n");
      return null;
    }
    const record: SessionRecord = { id: this.nextId, parent: this.lastId, event: prepared };
    try {
      ensurePrivateDirectory(dirname(this.path));
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
      this.lastId = record.id;
      this.nextId += 1;
      return structuredClone(record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`session: failed to persist event: ${detail}\n`);
      return null;
    }
  }

  /** Load valid events in file order; malformed lines are skipped safely. */
  load(): SessionEvent[] {
    return this.loadRecords(true).map((record) => structuredClone(record.event));
  }

  /** Return valid persisted records in file order. */
  records(): SessionRecord[] {
    return structuredClone(this.loadRecords(true));
  }

  /** Resolve a root-to-node path. Corrupt pointer graphs are rejected. */
  pathTo(id: number | null): SessionRecord[] | null {
    if (id === null) return [];
    const records = this.loadRecords(false);
    const byId = new Map<number, SessionRecord>();
    for (const record of records) {
      if (byId.has(record.id)) return null;
      byId.set(record.id, record);
    }

    const reversed: SessionRecord[] = [];
    const visited = new Set<number>();
    let current: number | null = id;
    while (current !== null) {
      if (visited.has(current)) return null;
      visited.add(current);
      const record = byId.get(current);
      if (!record) return null;
      reversed.push(record);
      current = record.parent;
    }
    return structuredClone(reversed.reverse());
  }

  /** Resolve the active path, degrading to the historical file-order behavior on corruption. */
  activePath(): SessionRecord[] {
    const path = this.pathTo(this.lastId);
    if (path) return path;
    if (!this.warnedAboutPath) {
      process.stderr.write("session: active history path is inconsistent; falling back to file order\n");
      this.warnedAboutPath = true;
    }
    return this.records();
  }

  loadPathRecords(): SessionRecord[] {
    return this.activePath();
  }

  loadPath(): SessionEvent[] {
    return this.activePath().map((record) => structuredClone(record.event));
  }

  /** Move the append parent without deleting abandoned records. */
  checkout(id: number | null): boolean {
    if (id !== null && this.pathTo(id) === null) return false;
    this.lastId = id;
    try {
      ensurePrivateDirectory(dirname(this.path));
      appendFileSync(this.path, `${JSON.stringify({ head: id })}\n`, { mode: 0o600 });
      chmodSync(this.path, 0o600);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`session: failed to persist checkout: ${detail}\n`);
    }
    return true;
  }

  private loadRecords(reportErrors: boolean): SessionRecord[] {
    return this.scan(reportErrors).records;
  }

  private scan(reportErrors: boolean): ScanResult {
    if (!existsSync(this.path)) return { records: [], leaf: null, maxId: null };
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if (reportErrors) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`session: failed to load events: ${detail}\n`);
      }
      return { records: [], leaf: null, maxId: null };
    }

    const records: SessionRecord[] = [];
    let leaf: number | null = null;
    let maxId: number | null = null;
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new TypeError("invalid record shape");
        }
        const object = value as Record<string, unknown>;
        if (Number.isInteger(object.id)) {
          const id = object.id as number;
          maxId = maxId === null ? id : Math.max(maxId, id);
        }

        if ("head" in object) {
          if (!(object.head === null || Number.isInteger(object.head))) {
            throw new TypeError("invalid head shape");
          }
          leaf = object.head as number | null;
          continue;
        }

        let event = object.event;
        // Compatibility with text-only files created by earlier releases.
        if (!event && (object.role === "user" || object.role === "assistant") && typeof object.message === "string") {
          event = { type: object.role, content: object.message };
        }
        if (!Number.isInteger(object.id) || !(object.parent === null || Number.isInteger(object.parent)) || !isSessionEvent(event)) {
          throw new TypeError("invalid record shape");
        }
        const record = { id: object.id as number, parent: object.parent as number | null, event };
        records.push(record);
        leaf = record.id;
      } catch (error) {
        if (reportErrors) {
          const detail = error instanceof Error ? error.message : String(error);
          process.stderr.write(`session: skipped malformed line ${index + 1}: ${detail}\n`);
        }
      }
    }
    return { records, leaf, maxId };
  }
}

export interface SessionFile {
  path: string;
  name: string;
  number: number;
}

export function sessionDirectory(
  cwd: string = process.cwd(),
  root: string = SESSIONS_ROOT,
): string {
  return join(root, encodeURIComponent(resolve(cwd)));
}

function parseSessionName(name: string): number | null {
  const match = /^session-(\d+)\.jsonl$/.exec(name);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

/** Discover this workspace's canonical session files in numeric order. */
export function listSessionFiles(
  cwd: string = process.cwd(),
  root: string = SESSIONS_ROOT,
): SessionFile[] {
  const dir = sessionDirectory(cwd, root);
  if (!existsSync(dir)) return [];
  const files: SessionFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const number = parseSessionName(entry.name);
    if (number !== null) files.push({ path: resolve(dir, entry.name), name: entry.name, number });
  }
  return files.sort((a, b) => a.number - b.number);
}

export function createSessionStore(
  cwd: string = process.cwd(),
  root: string = SESSIONS_ROOT,
  options: SessionStoreOptions = {},
): SessionStore {
  const dir = sessionDirectory(cwd, root);
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(dir);
  const files = listSessionFiles(cwd, root);
  const max = files.reduce((value, file) => Math.max(value, file.number), 0);
  return new SessionStore(join(dir, `session-${max + 1}.jsonl`), options);
}
