import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../source/session/navigator.ts";
import { formatSessionRow, selectSession } from "../source/session/sessions-ui.ts";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    path: "/sessions/session-1.jsonl",
    name: "session-1.jsonl",
    number: 1,
    eventCount: 2,
    active: false,
    preview: { type: "user", content: "hello" },
    ...overrides,
  };
}

describe("sessions UI", () => {
  test("formats active state and sanitizes persisted terminal controls", () => {
    const row = formatSessionRow(summary({
      active: true,
      preview: { type: "assistant", content: "done\nnow\x1b[2J" },
    }), { selected: true, width: 80 });
    expect(row).toContain("❯ session-1.jsonl · 2 events · active · assistant: done now");
    expect(row).not.toContain("\x1b[2J");
  });

  test("truncates rows to the terminal width", () => {
    const row = formatSessionRow(summary({ preview: { type: "user", content: "x".repeat(100) } }), { width: 24 });
    expect(row).toHaveLength(24);
    expect(row.endsWith("…")).toBe(true);
  });

  test("empty selection returns without terminal output", async () => {
    let output = "";
    expect(await selectSession([], { write: (text) => { output += text; } })).toBeNull();
    expect(output).toBe("");
  });
});
