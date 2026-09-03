import { expect, test } from "bun:test";
import { TuiApp } from "../source/ui/tui-app.ts";
import type { Frame } from "../source/ui/layout.ts";
import { NEW_SESSION } from "../source/session/sessions-ui.ts";

class FakeScreen {
  columns = 60; rows = 16; frames: Frame[] = []; started = false; disposed = false;
  start() { this.started = true; }
  render(frame: Frame) { this.frames.push(frame); }
  dispose() { this.disposed = true; }
}

test("output can be scrolled and remains anchored while a response streams", () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-1.jsonl", eventCount: 0 }, screen, color: false });
  app.handleKey("", { name: "pageup" });
  expect(app.state.followOutput).toBe(true); // Nothing to scroll yet.
  for (let index = 0; index < 30; index += 1) app.append({ text: `output ${index}` });

  // No readLine request is pending here, matching the state while the agent runs.
  app.handleKey("", { name: "pageup" });
  expect(app.state.followOutput).toBe(false);
  const anchoredOffset = app.state.scrollOffset;
  expect(anchoredOffset).toBeGreaterThan(0);

  app.handleProgress({ type: "text_delta", delta: "new streaming output\n" });
  expect(app.state.scrollOffset).toBe(anchoredOffset);
  expect(app.state.followOutput).toBe(false);

  app.handleKey("", { name: "end" });
  expect(app.state.followOutput).toBe(true);

  // Alternate-screen mouse wheels are delivered as Up/Down keypresses by
  // common terminal emulators.
  app.handleKey("", { name: "up" });
  expect(app.state.followOutput).toBe(false);
  const wheelOffset = app.state.scrollOffset;
  app.handleKey("", { name: "down" });
  expect(app.state.scrollOffset).toBe(wheelOffset + 1);
  expect(app.state.followOutput).toBe(true);
  app.close();
});

test("secret prompts mask pasted API keys", async () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-1.jsonl", eventCount: 0 }, screen, color: false });
  const answer = app.readLine({ kind: "choice", label: "API key:", initialText: "sk-secret", secret: true });
  const frame = screen.frames.at(-1)!;
  expect(frame.lines.join("\n")).not.toContain("sk-secret");
  expect(frame.lines.join("\n")).toContain("•••••••••");
  app.handleKey("", { name: "return" });
  expect(await answer).toBe("sk-secret");
  app.close();
});

test("Ctrl-A selects only the active user input and typing replaces it", async () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-1.jsonl", eventCount: 0 }, screen, color: false });
  const answer = app.readLine({ kind: "message", label: ">", initialText: "old prompt" });

  app.handleKey("\u0001", { name: "a", ctrl: true });
  expect(app.state.input.selection).toEqual({ start: 0, end: 10 });
  app.handleKey("replacement", { sequence: "replacement" });
  expect(app.state.input.value).toBe("replacement");
  app.handleKey("", { name: "return" });
  expect(await answer).toBe("replacement");
  app.close();
});

test("Ctrl-C interrupts an operation when no input prompt is active", () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-1.jsonl", eventCount: 0 }, screen, color: false });
  let interrupted = false;
  app.setInterruptHandler(() => { interrupted = true; });

  app.handleKey("\u0003", { name: "c", ctrl: true });

  expect(interrupted).toBe(true);
  app.close();
});

test("sessions overlay adds a new-session row one step below the existing list", async () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-1.jsonl", eventCount: 0 }, screen, color: false });
  const selection = app.showSessions([
    { path: "/tmp/session-1.jsonl", name: "session-1.jsonl", number: 1, eventCount: 0, active: true },
  ]);

  expect(app.state.overlay?.rows).toEqual([
    "  session-1.jsonl · 0 events · active",
    "  new session",
  ]);
  expect(app.state.overlay?.selected).toBe(0);
  app.handleKey("", { name: "down" });
  expect(app.state.overlay?.selected).toBe(1);
  app.handleKey("", { name: "return" });
  expect(await selection).toBe(NEW_SESSION);
  app.close();
});

test("loading a conversation replaces the display with persisted chat history", () => {
  const screen = new FakeScreen();
  const app = new TuiApp({ identity: { provider: "anthropic", model: "model", cwd: "/tmp", sessionName: "session-2.jsonl", eventCount: 4 }, screen, color: false });
  app.append({ text: "stale session notice" });
  app.setConversation([
    { index: 0, recordId: 10, event: { type: "user", content: "old question" } },
    { index: 1, recordId: 11, event: { type: "tool_call", id: "call-1", name: "read", input: { file_path: "/tmp/a" } } },
    { index: 2, recordId: 12, event: { type: "tool_result", callId: "call-1", content: "result", isError: false } },
    { index: 3, recordId: 13, event: { type: "assistant", content: "old answer" } },
  ]);

  expect(app.state.transcript.map((block) => block.kind === "welcome"
    ? "welcome"
    : `${block.kind}:${block.text}${block.kind === "tool" ? `:${block.tone ?? ""}` : ""}`)).toEqual([
    "welcome",
    "user:old question",
    "tool:Reading /tmp/a:",
    "tool:read (completed):success",
    "assistant:old answer",
  ]);
  expect(app.state.followOutput).toBe(true);
  expect(app.state.activity.kind).toBe("idle");
  app.close();
});

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
