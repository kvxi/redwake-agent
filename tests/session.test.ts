import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import {
  createSessionStore,
  type SessionMessage,
} from "../source/session/store.ts";
import { runRepl } from "../source/main.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "redwake-sessions-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function readSession(path: string): Promise<SessionMessage[]> {
  const text = await readFile(path, "utf-8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as SessionMessage);
}

describe("SessionStore", () => {
  test("appends a linked parent chain", async () => {
    const store = createSessionStore("/proj/chain", root);
    store.append({ role: "user", content: "hi" });
    store.append({ role: "assistant", content: "yo" });
    store.append({ role: "user", content: "bye" });

    const lines = await readSession(store.path);
    expect(lines.map((l) => l.id)).toEqual([0, 1, 2]);
    expect(lines.map((l) => l.parent)).toEqual([null, 0, 1]);
    expect(lines[0]).toEqual({
      id: 0,
      parent: null,
      role: "user",
      message: "hi",
    });
    expect(lines[1]!.role).toBe("assistant");
  });

  test("preserves structured (block) content", async () => {
    const store = createSessionStore("/proj/blocks", root);
    const content: MessageParam["content"] = [
      { type: "tool_result", tool_use_id: "t1", content: "{}", is_error: false },
    ];
    store.append({ role: "user", content });

    const [line] = await readSession(store.path);
    expect(line!.message).toEqual(content);
  });
});

describe("createSessionStore", () => {
  test("keys by cwd and increments the session number", async () => {
    const first = createSessionStore("/proj/a", root);
    first.append({ role: "user", content: "x" }); // creates the file
    const second = createSessionStore("/proj/a", root);

    expect(first.path.endsWith("session-1.jsonl")).toBe(true);
    expect(second.path.endsWith("session-2.jsonl")).toBe(true);

    const dir = join(root, encodeURIComponent("/proj/a"));
    expect(await readdir(dir)).toContain("session-1.jsonl");
  });

  test("uses separate directories per cwd", () => {
    const a = createSessionStore("/proj/a", root);
    const b = createSessionStore("/proj/b", root);
    expect(a.path).toContain(encodeURIComponent("/proj/a"));
    expect(b.path).toContain(encodeURIComponent("/proj/b"));
    expect(a.path.endsWith("session-1.jsonl")).toBe(true);
    expect(b.path.endsWith("session-1.jsonl")).toBe(true);
  });
});

describe("runRepl persistence", () => {
  test("records user, assistant and tool_result in order", async () => {
    const store = createSessionStore("/proj/int", root);
    const fakeMessage = {} as unknown as Message;
    const agent = {
      // simulate what Agent.runTurn appends via the shared store
      runTurn: async (_messages: MessageParam[]) => {
        store.append({ role: "assistant", content: "answer" });
        store.append({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t", content: "{}", is_error: false },
          ],
        });
        return fakeMessage;
      },
    };

    let asked = 0;
    const io = {
      question: async () => (asked++ === 0 ? "hello" : ""),
      close: () => {},
    };

    await runRepl(agent, io, store);

    const lines = await readSession(store.path);
    expect(lines.map((l) => [l.role, l.parent])).toEqual([
      ["user", null],
      ["assistant", 0],
      ["user", 1],
    ]);
    expect(lines[0]!.message).toBe("hello");
  });
});
