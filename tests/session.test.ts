import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationState, type SessionEvent } from "../source/session/conversation-state.ts";
import { createSessionStore, type SessionRecord } from "../source/session/store.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "redwake-sessions-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function readSession(path: string): Promise<SessionRecord[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

const events: SessionEvent[] = [
  { type: "user", content: "hi" },
  { type: "tool_call", id: "c1", name: "read", input: { file_path: "a" } },
  { type: "tool_result", callId: "c1", content: "result", isError: false },
  { type: "assistant", content: "done" },
];

describe("ConversationState", () => {
  test("preserves order, protects its event array, and persists once", async () => {
    const store = createSessionStore("/proj/state", root);
    const state = new ConversationState(store);
    for (const event of events) state.append(event);
    const view = state.events as SessionEvent[];
    view.push({ type: "user", content: "mutation" });
    expect(state.events).toEqual(events);
    expect(store.load()).toEqual(events);
    expect(await readSession(store.path)).toHaveLength(events.length);
  });

  test("provides exact and compacted snapshots", () => {
    const state = new ConversationState(undefined, events);
    expect(state.snapshot().recentEvents).toEqual(events);
    const compact = state.snapshot(100);
    expect(compact.coveredEventCount).toBeGreaterThan(0);
    expect(compact.summary).toContain("omitted");
  });
});

describe("SessionStore", () => {
  test("appends all canonical event types in a linked parent chain", async () => {
    const store = createSessionStore("/proj/chain", root);
    for (const event of events) store.append(event);
    const lines = await readSession(store.path);
    expect(lines.map((line) => line.id)).toEqual([0, 1, 2, 3]);
    expect(lines.map((line) => line.parent)).toEqual([null, 0, 1, 2]);
    expect(lines.map((line) => line.event)).toEqual(events);
  });

  test("loads valid lines, legacy text, and safely skips malformed records", async () => {
    const store = createSessionStore("/proj/load", root);
    store.append(events[0]!);
    await appendFile(store.path, [
      "not-json",
      JSON.stringify({ id: 1, parent: 0, event: { type: "bad" } }),
      JSON.stringify({ id: 2, parent: 0, role: "assistant", message: "legacy" }),
      "",
    ].join("\n"));
    expect(store.load()).toEqual([
      { type: "user", content: "hi" },
      { type: "assistant", content: "legacy" },
    ]);
  });

  test("supports a persistence redaction hook", () => {
    const store = createSessionStore("/proj/redact", root, {
      prepareEvent: (event) => event.type === "tool_result"
        ? { ...event, content: "[redacted]" }
        : event,
    });
    store.append(events[2]!);
    expect(store.load()[0]).toMatchObject({ content: "[redacted]" });
  });
});

describe("createSessionStore", () => {
  test("keys by cwd and increments the session number", async () => {
    const first = createSessionStore("/proj/a", root);
    first.append({ type: "user", content: "x" });
    const second = createSessionStore("/proj/a", root);
    expect(first.path.endsWith("session-1.jsonl")).toBe(true);
    expect(second.path.endsWith("session-2.jsonl")).toBe(true);
    expect(await readdir(join(root, encodeURIComponent("/proj/a")))).toContain("session-1.jsonl");
  });

  test("uses separate directories per cwd", () => {
    const a = createSessionStore("/proj/a", root);
    const b = createSessionStore("/proj/b", root);
    expect(a.path).toContain(encodeURIComponent("/proj/a"));
    expect(b.path).toContain(encodeURIComponent("/proj/b"));
  });
});
