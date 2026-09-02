import { expect, test } from "bun:test";
import { renderFrame } from "../source/ui/layout.ts";
import { displayWidth, stripAnsi } from "../source/ui/terminal-text.ts";
import { createTheme } from "../source/ui/theme.ts";
import { createTuiState } from "../source/ui/tui-state.ts";

test("notices preserve newlines, clickable complete URLs, and copy without visual padding", () => {
  const width = 32;
  const url = "https://auth.example.test/authorize?client_id=codex&state=" + "a".repeat(90);
  const initial = createTuiState({ provider: "openai-codex", model: "codex", cwd: "/tmp", sessionName: "new", eventCount: 0 }, width, 14);
  const state = {
    ...initial,
    transcript: [{ id: 1, revision: 0, kind: "notice" as const, tone: "info" as const, text: `First line\n${url}\nLast line\x1b]8;;https://evil.test\x1b\\` }],
  };
  const frame = renderFrame(state, createTheme(false));
  const visible = frame.lines.map(stripAnsi);

  expect(visible).toContain("First line");
  expect(visible).toContain("Last line");
  expect(frame.lines.some((line) => line.includes(`\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\`))).toBe(true);
  expect(visible.join("")).toContain(url);
  expect(visible.find((line) => line === "First line")).toBe("First line");
  expect(frame.softWrapRows?.length).toBeGreaterThan(0);
  expect(frame.lines.join("")).not.toContain("evil.test");
});

for (const width of [30, 60, 89, 90, 120]) {
  test(`TUI frame remains bounded at ${width} columns`, () => {
    const state = createTuiState({ provider: "anthropic", model: "claude", cwd: "/a/very/long/界/workspace", sessionName: "session-46.jsonl", sessionNumber: 46, eventCount: 12 }, width, 20);
    const frame = renderFrame(state, createTheme(true));
    expect(frame.lines).toHaveLength(20);
    expect(frame.lines.every((line) => displayWidth(line) <= width)).toBe(true);
    expect(stripAnsi(frame.lines.join("\n"))).toContain("REDWAKE");
    expect(stripAnsi(frame.lines.at(-1)!)).toContain("idle");
  });
}
