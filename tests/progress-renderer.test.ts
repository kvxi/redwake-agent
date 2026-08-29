import { describe, expect, test } from "bun:test";
import { ProgressRenderer } from "../source/ui/progress-renderer.ts";
import { formatDuration, summarizeToolCall } from "../source/ui/tool-summary.ts";

function capture(isTTY = false) {
  const writes: string[] = [];
  const timers = new Set<unknown>();
  const renderer = new ProgressRenderer({
    write: (text) => writes.push(text),
    isTTY,
    setInterval: ((fn: () => void) => {
      const token = { fn };
      timers.add(token);
      return token;
    }) as unknown as typeof globalThis.setInterval,
    clearInterval: ((token: unknown) => { timers.delete(token); }) as typeof globalThis.clearInterval,
  });
  return { renderer, writes, timers };
}

describe("ProgressRenderer", () => {
  test("writes stable non-TTY progress and ordered text without ANSI", () => {
    const { renderer, writes } = capture();
    renderer.handle({ type: "request_start" });
    renderer.handle({ type: "text_delta", delta: "hel" });
    renderer.handle({ type: "text_delta", delta: "lo" });
    renderer.handle({ type: "text_end" });
    renderer.handle({ type: "tool_start", callId: "1", name: "bash", input: { command: "echo hi" } });
    renderer.handle({ type: "tool_finish", callId: "1", name: "bash", durationMs: 2400, isError: false });

    const output = writes.join("");
    expect(output).toBe("Thinking…\nhello\n● Running: echo hi\n✓ bash (2.4 s)\n");
    expect(output).not.toContain("\x1b");
  });

  test("adds no extra newline when a response already ends with one", () => {
    const { renderer, writes } = capture();
    renderer.handle({ type: "text_delta", delta: "done\n" });
    renderer.handle({ type: "text_end" });
    expect(writes.join("")).toBe("done\n");
  });

  test("clears TTY spinner before writing text and clears timers", () => {
    const { renderer, writes, timers } = capture(true);
    renderer.handle({ type: "request_start" });
    expect(timers.size).toBe(1);
    renderer.handle({ type: "text_delta", delta: "answer" });
    expect(timers.size).toBe(0);
    expect(writes.join("")).toContain("\r\x1b[2Kanswer");
    renderer.handle({ type: "request_start" });
    renderer.handle({ type: "turn_end" });
    expect(timers.size).toBe(0);
    renderer.dispose();
  });

  test("renders failures and safely summarizes only known fields", () => {
    const { renderer, writes } = capture();
    renderer.handle({ type: "tool_finish", callId: "1", name: "read", durationMs: 84.4, isError: true });
    expect(writes.join("")).toBe("✗ read (84 ms)\n");
    expect(summarizeToolCall("search", { query: "one\n\ttwo" })).toBe("Searching: one two");
    expect(summarizeToolCall("unknown", { secret: "do-not-print" })).toBe("Running unknown");
    expect(summarizeToolCall("bash", { command: "x".repeat(200) }).length).toBeLessThan(135);
    expect(formatDuration(-1)).toBe("0 ms");
  });
});
