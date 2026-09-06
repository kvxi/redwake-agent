import { expect, test } from "bun:test";
import { editInput } from "../source/ui/input-editor.ts";

test("input editor supports insertion, movement, deletion, and paste normalization", () => {
  let state = editInput({ value: "ac", cursor: 1 }, { type: "insert", text: "b\n" });
  expect(state).toEqual({ value: "ab c", cursor: 3 });
  state = editInput(state, { type: "backspace" });
  expect(state).toEqual({ value: "abc", cursor: 2 });
  expect(editInput(state, { type: "kill-start" })).toEqual({ value: "c", cursor: 0 });
});

test("bracketed paste preserves lines, normalizes CRLF, and replaces a selection", () => {
  const state = editInput(
    { value: "replace me", cursor: 10, selection: { start: 0, end: 10 } },
    { type: "paste", text: "const x = 1;\r\n\treturn x;\x1b\x03" },
  );
  expect(state).toEqual({ value: "const x = 1;\n\treturn x;", cursor: 23 });
});

test("direct cursor placement is grapheme-safe and clears selections", () => {
  const value = "a👩‍💻éz";
  expect(editInput(
    { value, cursor: value.length, selection: { start: 0, end: value.length } },
    { type: "set-cursor", cursor: 3 },
  )).toEqual({ value, cursor: 1 });
  expect(editInput({ value, cursor: 0 }, { type: "set-cursor", cursor: 999 })).toEqual({ value, cursor: value.length });
});

test("newline inserts a line break at the cursor and replaces a selection", () => {
  expect(editInput({ value: "firstsecond", cursor: 5 }, { type: "newline" })).toEqual({ value: "first\nsecond", cursor: 6 });
  expect(editInput(
    { value: "first middle second", cursor: 12, selection: { start: 5, end: 12 } },
    { type: "newline" },
  )).toEqual({ value: "first\n second", cursor: 6 });
});

test("Ctrl-D exits only on empty input", () => {
  expect(editInput({ value: "", cursor: 0 }, { type: "eof" }).outcome).toBe("eof");
  expect(editInput({ value: "x", cursor: 1 }, { type: "eof" }).outcome).toBeUndefined();
});

test("select all creates a replaceable user-input selection", () => {
  const selected = editInput({ value: "whole prompt", cursor: 3 }, { type: "select-all" });
  expect(selected).toEqual({ value: "whole prompt", cursor: 12, selection: { start: 0, end: 12 } });
  expect(editInput(selected, { type: "insert", text: "new" })).toEqual({ value: "new", cursor: 3 });
  expect(editInput(selected, { type: "backspace" })).toEqual({ value: "", cursor: 0 });
});
