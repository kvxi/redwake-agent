import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { TerminalScreen, type TerminalMouseEvent } from "../source/ui/terminal-screen.ts";

function fakeTerminal() {
  const input = new EventEmitter() as EventEmitter & { isRaw: boolean; isTTY: boolean; setRawMode(value: boolean): void; resume(): void; pause(): void };
  input.isRaw = false; input.isTTY = true; input.setRawMode = (value) => { input.isRaw = value; }; input.resume = () => {}; input.pause = () => {};
  const output = new EventEmitter() as EventEmitter & { columns: number; rows: number; writes: string[]; write(text: string): boolean };
  output.columns = 40; output.rows = 10; output.writes = []; output.write = (text) => { output.writes.push(text); return true; };
  return { input, output };
}

test("terminal screen owns and idempotently restores terminal lifecycle", () => {
  const { input, output } = fakeTerminal();
  const screen = new TerminalScreen({ input: input as never, output: output as never });
  screen.start();
  expect(input.isRaw).toBe(true);
  expect(output.writes[0]).toContain("\x1b[>25u");
  expect(output.writes[0]).toContain("\x1b[>4;2m");
  expect(output.writes[0]).toContain("\x1b[?2004h");
  expect(output.writes[0]).toContain("\x1b[?1000h");
  expect(output.writes[0]).toContain("\x1b[?1006h");
  screen.render({ lines: ["one"], cursor: { row: 1, column: 2 } });
  screen.render({ lines: ["one"], cursor: { row: 1, column: 2 } });
  expect(output.writes[1]).toContain("\x1b[2Kone");
  expect(output.writes[2]).not.toContain("\x1b[2Kone");
  screen.dispose(); screen.dispose();
  expect(input.isRaw).toBe(false);
  expect(output.writes.filter((text) => text.includes("?1049l"))).toHaveLength(1);
  expect(output.writes.at(-1)).toContain("\x1b[<u");
  expect(output.writes.at(-1)).toContain("\x1b[>4;0m");
  expect(output.writes.at(-1)).toContain("\x1b[?2004l");
  expect(output.writes.at(-1)).toContain("\x1b[?1000l");
  expect(output.writes.at(-1)).toContain("\x1b[?1006l");
});

test("terminal screen buffers bracketed paste as one event", () => {
  const { input, output } = fakeTerminal();
  const keys: string[] = [];
  const pastes: string[] = [];
  const screen = new TerminalScreen({
    input: input as never,
    output: output as never,
    onKey: (text) => keys.push(text),
    onPaste: (text) => pastes.push(text),
  });
  screen.start();

  input.emit("data", "before");
  const encoded = Buffer.from("\x1b[200~first\n界second\u0003\x1b[201~");
  const unicodeByte = encoded.indexOf(Buffer.from("界"));
  input.emit("data", encoded.subarray(0, 4));
  input.emit("data", encoded.subarray(4, unicodeByte + 1));
  input.emit("data", encoded.subarray(unicodeByte + 1));
  input.emit("data", "after");

  expect(pastes).toEqual(["first\n界second\u0003"]);
  expect(keys.join("")).toBe("beforeafter");
  screen.dispose();
});

test("terminal screen decodes SGR clicks, releases, and wheel reports", () => {
  const { input, output } = fakeTerminal();
  const keys: string[] = [];
  const mouse: TerminalMouseEvent[] = [];
  const screen = new TerminalScreen({
    input: input as never,
    output: output as never,
    onKey: (text) => keys.push(text),
    onMouse: (event) => mouse.push(event),
  });
  screen.start();
  input.emit("data", Buffer.from("\x1b"));
  input.emit("data", Buffer.from("[<0;12"));
  input.emit("data", Buffer.from(";7M"));
  input.emit("data", Buffer.from("\x1b[<0;12;7m"));
  input.emit("data", Buffer.from("\x1b[<64;3;4M"));
  input.emit("data", Buffer.from("\x1b[<65;5;6M"));
  input.emit("data", Buffer.from("\x1b[<brokenM"));
  input.emit("data", Buffer.from("\x1b[<32;1;1M"));

  expect(mouse).toEqual([
    { action: "press", button: "left", row: 7, column: 12, shift: false, meta: false, ctrl: false },
    { action: "release", button: "left", row: 7, column: 12, shift: false, meta: false, ctrl: false },
    { action: "wheel", wheel: "up", row: 4, column: 3, shift: false, meta: false, ctrl: false },
    { action: "wheel", wheel: "down", row: 6, column: 5, shift: false, meta: false, ctrl: false },
  ]);
  expect(keys).toEqual([]);
  screen.dispose();
});

test("terminal screen decodes progressive modified-key reports", () => {
  const { input, output } = fakeTerminal();
  const keys: Array<{ text: string; name?: string; ctrl?: boolean; shift?: boolean }> = [];
  const screen = new TerminalScreen({
    input: input as never,
    output: output as never,
    onKey: (text, key) => keys.push({ text, name: key.name, ctrl: key.ctrl, shift: key.shift }),
  });
  screen.start();
  input.emit("data", Buffer.from("\x1b[97;5u"));
  input.emit("data", Buffer.from("\x1b[97;2;65u"));
  input.emit("data", Buffer.from("\x1b[13u"));
  input.emit("data", Buffer.from("\x1b[13;2u"));
  input.emit("data", Buffer.from("\x1b[27;2;"));
  input.emit("data", Buffer.from("13~"));
  expect(keys).toEqual([
    { text: "a", name: "a", ctrl: true, shift: false },
    { text: "A", name: "a", ctrl: false, shift: true },
    { text: "", name: "return", ctrl: false, shift: false },
    { text: "", name: "return", ctrl: false, shift: true },
    { text: "", name: "return", ctrl: false, shift: true },
  ]);
  screen.dispose();
});
