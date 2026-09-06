import { expect, test } from "bun:test";
import { inputOffsetAt, renderFrame } from "../source/ui/layout.ts";
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

test("active input box expands to show wrapped prompt rows", () => {
  const initial = createTuiState({ provider: "anthropic", model: "claude", cwd: "/tmp", sessionName: "new", eventCount: 0 }, 20, 10);
  const state = { ...initial, input: { ...initial.input, active: true, value: "a".repeat(35), cursor: 35 } };
  const frame = renderFrame(state, createTheme(false));
  const visible = frame.lines.map(stripAnsi);

  expect(frame.lines).toHaveLength(10);
  expect(visible.filter((line) => line.startsWith("│")).length).toBe(3);
  expect(frame.cursor?.row).toBe(8);
  expect(visible.join("")).toContain("a".repeat(16));
});

test("multiline pasted input uses distinct rows and follows the cursor", () => {
  const initial = createTuiState({ provider: "anthropic", model: "claude", cwd: "/tmp", sessionName: "new", eventCount: 0 }, 24, 10);
  const value = "first line\nsecond line";
  const state = { ...initial, input: { ...initial.input, active: true, value, cursor: value.length } };
  const frame = renderFrame(state, createTheme(false));
  const visible = frame.lines.map(stripAnsi);

  expect(visible.some((line) => line.includes("> first line"))).toBe(true);
  expect(visible.some((line) => line.includes("second line"))).toBe(true);
  expect(frame.cursor?.row).toBe(8);
  expect(frame.cursor?.column).toBe(13);
});

test("input hit-testing maps labels, text, wide glyphs, and non-input rows", () => {
  const initial = createTuiState({ provider: "anthropic", model: "claude", cwd: "/tmp", sessionName: "new", eventCount: 0 }, 20, 10);
  const state = { ...initial, input: { ...initial.input, active: true, value: "a界éz", cursor: 0 } };

  // The content row is 8: column 1 is the border, columns 2-3 are "> ",
  // and editable text starts at column 4.
  expect(inputOffsetAt(state, 8, 1)).toBeUndefined();
  expect(inputOffsetAt(state, 8, 2)).toBe(0);
  expect(inputOffsetAt(state, 8, 4)).toBe(0);
  expect(inputOffsetAt(state, 8, 5)).toBe(1); // first cell of 界
  expect(inputOffsetAt(state, 8, 6)).toBe(2); // second cell of 界
  expect(inputOffsetAt(state, 8, 7)).toBe(2); // before the combining grapheme
  expect(inputOffsetAt(state, 8, 8)).toBe(4);
  expect(inputOffsetAt(state, 8, 18)).toBe(state.input.value.length);
  expect(inputOffsetAt(state, 7, 4)).toBeUndefined(); // top border
  expect(inputOffsetAt(state, 10, 4)).toBeUndefined(); // status
});

test("input hit-testing follows wrapped, multiline, and cursor-windowed rows", () => {
  const initial = createTuiState({ provider: "anthropic", model: "claude", cwd: "/tmp", sessionName: "new", eventCount: 0 }, 20, 10);
  const wrapped = { ...initial, input: { ...initial.input, active: true, value: "a".repeat(35), cursor: 35 } };
  expect(inputOffsetAt(wrapped, 6, 4)).toBe(0);
  expect(inputOffsetAt(wrapped, 7, 2)).toBe(16);
  expect(inputOffsetAt(wrapped, 7, 19)).toBe(33);

  const multilineValue = "first\nsecond";
  const multiline = { ...initial, input: { ...initial.input, active: true, value: multilineValue, cursor: multilineValue.length } };
  expect(inputOffsetAt(multiline, 8, 2)).toBe(6);

  const short = createTuiState(initial.identity, 20, 6);
  const windowed = { ...short, input: { ...short.input, active: true, value: "x".repeat(50), cursor: 50 } };
  expect(inputOffsetAt(windowed, 3, 2)).toBe(16);
  expect(inputOffsetAt(windowed, 4, 2)).toBe(34);

  const compact = createTuiState(initial.identity, 10, 5);
  const unboxed = { ...compact, input: { ...compact.input, active: true, value: "abc", cursor: 0 } };
  expect(inputOffsetAt(unboxed, 4, 1)).toBe(0);
  expect(inputOffsetAt(unboxed, 4, 3)).toBe(0);
  expect(inputOffsetAt(unboxed, 5, 3)).toBeUndefined();
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
