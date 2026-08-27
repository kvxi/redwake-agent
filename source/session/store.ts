import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { SESSIONS_ROOT } from "../config.ts";

/**
 * One persisted conversation message. `parent` links to the previous message's
 * `id`, forming a tree (one message may be the parent of several) so forked
 * histories are representable; the minimal store only writes a linear chain.
 */
export interface SessionMessage {
  id: number;
  parent: number | null;
  role: MessageParam["role"];
  message: MessageParam["content"];
}

/** Append-only JSONL writer for a single session file. */
export class SessionStore {
  private nextId = 0;
  private lastId: number | null = null;

  constructor(readonly path: string) {}

  /** Persist one message, chaining `parent` to the previously written message. */
  append(message: MessageParam): void {
    const record: SessionMessage = {
      id: this.nextId,
      parent: this.lastId,
      role: message.role,
      message: message.content,
    };
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
      this.lastId = record.id;
      this.nextId += 1;
    } catch (error) {
      // Persistence is best-effort: never let a disk error kill the session.
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`session: failed to persist message: ${detail}\n`);
    }
  }
}

/**
 * Open a new session file for `cwd`, keyed by its absolute path under `root`.
 * Picks the next `session-<n>.jsonl` after the highest existing one.
 */
export function createSessionStore(
  cwd: string = process.cwd(),
  root: string = SESSIONS_ROOT,
): SessionStore {
  const dir = join(root, encodeURIComponent(resolve(cwd)));
  mkdirSync(dir, { recursive: true });

  let max = 0;
  for (const name of readdirSync(dir)) {
    const match = /^session-(\d+)\.jsonl$/.exec(name);
    if (match) max = Math.max(max, Number(match[1]));
  }

  return new SessionStore(join(dir, `session-${max + 1}.jsonl`));
}
