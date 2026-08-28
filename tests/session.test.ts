import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationState, type SessionEvent } from "../source/session/conversation-state.ts";
import { createSessionStore, listSessionFiles, SessionStore, sessionDirectory, type SessionRecord } from "../source/session/store.ts";
import { SessionNavigator } from "../source/session/navigator.ts";

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

  test("discovers only files and sorts session numbers numerically", async () => {
    const cwd = "/proj/discover";
    const dir = sessionDirectory(cwd, root);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "session-10.jsonl"), "");
    await writeFile(join(dir, "session-2.jsonl"), "");
    await writeFile(join(dir, "notes.txt"), "");
    await mkdir(join(dir, "session-3.jsonl"));
    expect(listSessionFiles(cwd, root).map((file) => file.number)).toEqual([2, 10]);
  });
});

describe("SessionNavigator", () => {
  test("includes an unwritten current session and continues a selected active leaf", async () => {
    const cwd = "/proj/navigate";
    const selected = createSessionStore(cwd, root);
    selected.append({ type: "user", content: "old" });
    selected.append({ type: "assistant", content: "answer" });
    const selectedLeaf = selected.leaf;
    const current = createSessionStore(cwd, root);
    const conversation = new ConversationState(current);
    const navigator = new SessionNavigator(conversation, current, cwd, root);

    expect(navigator.list().map((item) => item.name)).toEqual(["session-1.jsonl", "session-2.jsonl"]);
    expect(navigator.activate(selected.path)).toEqual({ status: "switched", eventCount: 2 });
    expect(conversation.events).toEqual([
      { type: "user", content: "old" },
      { type: "assistant", content: "answer" },
    ]);

    conversation.append({ type: "user", content: "continue" });
    const appended = new SessionStore(selected.path).records().at(-1)!;
    expect(appended.parent).toBe(selectedLeaf);
    expect(appended.event).toEqual({ type: "user", content: "continue" });
  });

  test("honors checkout heads and rejects paths outside the workspace", () => {
    const cwd = "/proj/branches";
    const selected = createSessionStore(cwd, root);
    selected.append({ type: "user", content: "root" });
    const rootId = selected.leaf;
    selected.append({ type: "assistant", content: "abandoned" });
    expect(selected.checkout(rootId)).toBe(true);
    const current = createSessionStore(cwd, root);
    const conversation = new ConversationState(current);
    const navigator = new SessionNavigator(conversation, current, cwd, root);

    navigator.activate(selected.path);
    expect(conversation.events).toEqual([{ type: "user", content: "root" }]);
    conversation.append({ type: "user", content: "new branch" });
    expect(new SessionStore(selected.path).records().at(-1)?.parent).toBe(rootId);
    expect(() => navigator.activate(join(root, "session-999.jsonl"))).toThrow("outside this workspace");
  });
});
