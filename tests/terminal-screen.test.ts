import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { TerminalScreen } from "../source/ui/terminal-screen.ts";

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
  expect(output.writes[0]).toContain("\x1b[>1u");
  screen.render({ lines: ["one"], cursor: { row: 1, column: 2 } });
  screen.render({ lines: ["one"], cursor: { row: 1, column: 2 } });
  expect(output.writes[1]).toContain("\x1b[2Kone");
  expect(output.writes[2]).not.toContain("\x1b[2Kone");
  screen.dispose(); screen.dispose();
  expect(input.isRaw).toBe(false);
  expect(output.writes.filter((text) => text.includes("?1049l"))).toHaveLength(1);
  expect(output.writes.at(-1)).toContain("\x1b[<u");
});

test("terminal screen decodes progressive Ctrl-A keyboard reports", () => {
  const { input, output } = fakeTerminal();
  const keys: Array<{ text: string; name?: string; ctrl?: boolean }> = [];
  const screen = new TerminalScreen({
    input: input as never,
    output: output as never,
    onKey: (text, key) => keys.push({ text, name: key.name, ctrl: key.ctrl }),
  });
  screen.start();
  input.emit("keypress", "", { sequence: "\x1b[97;5u" });
  input.emit("keypress", "", { sequence: "\x1b[13u" });
  expect(keys).toEqual([
    { text: "a", name: "a", ctrl: true },
    { text: "", name: "return", ctrl: false },
  ]);
  screen.dispose();
});
