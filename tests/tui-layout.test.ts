import { expect, test } from "bun:test";
import { renderFrame } from "../source/ui/layout.ts";
import { displayWidth, stripAnsi } from "../source/ui/terminal-text.ts";
import { createTheme } from "../source/ui/theme.ts";
import { createTuiState } from "../source/ui/tui-state.ts";

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
