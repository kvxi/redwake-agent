import { expect, test } from "bun:test";
import { TuiApp } from "../source/ui/tui-app.ts";
import type { Frame } from "../source/ui/layout.ts";

class FakeScreen {
  columns = 60; rows = 16; frames: Frame[] = []; started = false; disposed = false;
  start() { this.started = true; }
  render(frame: Frame) { this.frames.push(frame); }
  dispose() { this.disposed = true; }
}

test("TUI app translates progress and runtime identity state", () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "old", cwd: "/tmp", sessionName: "session-1.jsonl", sessionNumber: 1, eventCount: 0 }, screen, color: false });
  app.handleProgress({ type: "request_start" });
  expect(app.state.activity.kind).toBe("thinking");
  app.handleProgress({ type: "text_delta", delta: "hello" });
  app.handleProgress({ type: "text_end" });
  expect(app.state.transcript.some((block) => block.kind === "assistant" && block.text === "hello")).toBe(true);
  app.handleProgress({ type: "tool_start", callId: "1", name: "read", input: { file_path: "/tmp/a" } });
  expect(app.state.activity.kind).toBe("running");
  app.handleProgress({ type: "tool_finish", callId: "1", name: "read", durationMs: 20, isError: false });
  app.handleProgress({ type: "turn_end" });
  app.updateRuntime({ model: "new", eventCount: 4 });
  expect(app.state.activity.kind).toBe("idle");
  expect(app.state.identity).toMatchObject({ model: "new", eventCount: 4 });
  app.close(); app.close();
  expect(screen.disposed).toBe(true);
});
