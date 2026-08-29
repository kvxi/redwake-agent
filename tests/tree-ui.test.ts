import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "../source/session/conversation-state.ts";
import {
  buildTreeRows,
  formatTreeDisplayRow,
  formatTreeRow,
  nextSelection,
  selectTreeNode,
} from "../source/session/tree-ui.ts";

const entry = (event: ConversationEntry["event"], index = 0): ConversationEntry => ({
  index,
  event,
  recordId: index,
});

describe("tree selection logic", () => {
  test("clamps navigation and scrolls to keep the selection visible", () => {
    let state = { selected: 4, offset: 2, itemCount: 5, rowCount: 3 };
    state = nextSelection(state, "down");
    expect(state).toMatchObject({ selected: 4, offset: 2, outcome: null });
    state = nextSelection(state, "up");
    state = nextSelection(state, "up");
    state = nextSelection(state, "up");
    expect(state).toMatchObject({ selected: 1, offset: 1 });
    expect(nextSelection(state, "enter").outcome).toBe("confirm");
    expect(nextSelection(state, "escape").outcome).toBe("cancel");
    expect(nextSelection(state, "ctrl-c").outcome).toBe("cancel");
  });

  test("formats, sanitizes, and truncates every event type", () => {
    expect(formatTreeRow(entry({ type: "user", content: "hello\nworld\x1b[2J" })))
      .toContain("user: hello world");
    expect(formatTreeRow(entry({ type: "assistant", content: "done" }))).toContain("assistant: done");
    expect(formatTreeRow(entry({ type: "tool_call", id: "1", name: "read", input: { a: 1 } })))
      .toContain("tool read: {\"a\":1}");
    expect(formatTreeRow(entry({ type: "tool_result", callId: "1", content: "bad", isError: true })))
      .toContain("result (error): bad");
    const truncated = formatTreeRow(entry({ type: "user", content: "a".repeat(100) }), { width: 20 });
    expect(truncated.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(20);
  });

  test("bolds user rows red and assistant rows yellow", () => {
    expect(formatTreeRow(entry({ type: "user", content: "hello" })))
      .toBe("  \x1b[1;31muser: hello\x1b[0m");
    expect(formatTreeRow(entry({ type: "assistant", content: "hello" }), { selected: true }))
      .toBe("❯ \x1b[1;33massistant: hello\x1b[0m");
    expect(formatTreeRow(entry({ type: "tool_result", callId: "1", content: "ok", isError: false })))
      .not.toContain("\x1b[");
  });

  test("handles unserializable tool input without mutating it", () => {
    const input: Record<string, unknown> = {};
    input.self = input;
    const item = entry({ type: "tool_call", id: "1", name: "x", input });
    expect(formatTreeRow(item)).toContain("[unserializable input]");
    expect((item.event as { input: unknown }).input).toBe(input);
  });

  test("collapses consecutive tool activity and expands it into selectable events", () => {
    const entries = [
      entry({ type: "user", content: "inspect" }, 0),
      entry({ type: "assistant", content: "I'll check" }, 1),
      entry({ type: "tool_call", id: "a", name: "read", input: { file_path: "a.ts" } }, 2),
      entry({ type: "tool_result", callId: "a", content: "contents", isError: false }, 3),
      entry({ type: "tool_call", id: "b", name: "bash", input: { command: "test" } }, 4),
      entry({ type: "tool_result", callId: "b", content: "ok", isError: false }, 5),
      entry({ type: "assistant", content: "done" }, 6),
    ];

    const collapsed = buildTreeRows(entries);
    expect(collapsed).toHaveLength(4);
    expect(collapsed[2]).toMatchObject({ kind: "tool_group", startIndex: 2, callCount: 2, expanded: false });
    expect(formatTreeDisplayRow(collapsed[2]!)).toContain("▶ 2 tool calls");

    const expanded = buildTreeRows(entries, new Set([2]));
    expect(expanded).toHaveLength(8);
    expect(expanded[2]).toMatchObject({ kind: "tool_group", expanded: true });
    expect(expanded.slice(3, 7).every((row) => row.kind === "event" && row.nested)).toBe(true);
    expect(formatTreeDisplayRow(expanded[2]!)).toContain("▼ 2 tool calls");
    expect(formatTreeDisplayRow(expanded[3]!)).toContain("tool read:");
  });

  test("starts a new collapsed group after each user or assistant message", () => {
    const entries = [
      entry({ type: "tool_call", id: "a", name: "read", input: {} }, 0),
      entry({ type: "tool_result", callId: "a", content: "ok", isError: false }, 1),
      entry({ type: "assistant", content: "middle" }, 2),
      entry({ type: "tool_call", id: "b", name: "bash", input: {} }, 3),
    ];
    const rows = buildTreeRows(entries);
    expect(rows.map((row) => row.kind)).toEqual(["tool_group", "event", "tool_group"]);
  });

  test("empty selectors return without touching raw mode", async () => {
    let output = "";
    expect(await selectTreeNode([], { write: (text) => { output += text; } })).toBeNull();
    expect(output).toBe("Session tree is empty.\n");
  });
});
