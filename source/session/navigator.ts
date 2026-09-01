import { basename, resolve } from "node:path";
import { SESSIONS_ROOT } from "../paths.ts";
import type { SessionEvent } from "./conversation-state.ts";
import { ConversationState } from "./conversation-state.ts";
import { listSessionFiles, SessionStore, type SessionRecord } from "./store.ts";

export interface SessionSummary {
  path: string;
  name: string;
  number: number;
  eventCount: number;
  preview?: SessionEvent;
  active: boolean;
}

export interface SessionActivation {
  status: "switched" | "already-active";
  eventCount: number;
}

function normalized(path: string): string {
  return resolve(path);
}

function previewOf(records: readonly SessionRecord[]): SessionEvent | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const event = records[index]!.event;
    if (event.type === "user" || event.type === "assistant") return structuredClone(event);
  }
  const event = records.at(-1)?.event;
  return event ? structuredClone(event) : undefined;
}

/** Discovers and activates sessions for one resolved workspace. */
export class SessionNavigator {
  private activeStore: SessionStore;

  constructor(
    private readonly conversation: ConversationState,
    currentStore: SessionStore,
    private readonly cwd: string = process.cwd(),
    private readonly root: string = SESSIONS_ROOT,
  ) {
    this.activeStore = currentStore;
  }

  get activePath(): string {
    return normalized(this.activeStore.path);
  }

  list(): SessionSummary[] {
    const activePath = this.activePath;
    const files = listSessionFiles(this.cwd, this.root);
    if (!files.some((file) => normalized(file.path) === activePath)) {
      const match = /^session-(\d+)\.jsonl$/.exec(basename(activePath));
      const number = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
      files.push({ path: activePath, name: basename(activePath), number });
      files.sort((a, b) => a.number - b.number);
    }

    const summaries: SessionSummary[] = [];
    for (const file of files) {
      const store = normalized(file.path) === activePath ? this.activeStore : new SessionStore(file.path);
      const records = store.pathTo(store.leaf);
      // Do not offer a corrupt graph for activation. Keep a corrupt current
      // session visible using its compatibility path so the UI remains honest.
      if (records === null && normalized(file.path) !== activePath) continue;
      const pathRecords = records ?? store.loadPathRecords();
      summaries.push({
        ...file,
        path: normalized(file.path),
        eventCount: pathRecords.length,
        preview: previewOf(pathRecords),
        active: normalized(file.path) === activePath,
      });
    }
    return structuredClone(summaries);
  }

  activate(path: string): SessionActivation {
    const chosen = normalized(path);
    if (chosen === this.activePath) {
      const records = this.activeStore.pathTo(this.activeStore.leaf) ?? this.activeStore.loadPathRecords();
      return { status: "already-active", eventCount: records.length };
    }

    const allowed = new Set(listSessionFiles(this.cwd, this.root).map((file) => normalized(file.path)));
    if (!allowed.has(chosen)) throw new Error("Session is outside this workspace or no longer exists.");

    const store = new SessionStore(chosen);
    const records = store.pathTo(store.leaf);
    if (records === null) throw new Error("Session has an inconsistent history path.");
    this.conversation.replaceSession(store, records);
    this.activeStore = store;
    return { status: "switched", eventCount: records.length };
  }
}
