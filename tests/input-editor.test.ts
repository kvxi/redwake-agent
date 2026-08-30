import { expect, test } from "bun:test";
import { editInput } from "../source/ui/input-editor.ts";

test("input editor supports insertion, movement, deletion, and paste normalization", () => {
  let state = editInput({ value: "ac", cursor: 1 }, { type: "insert", text: "b\n" });
  expect(state).toEqual({ value: "ab c", cursor: 3 });
  state = editInput(state, { type: "backspace" });
  expect(state).toEqual({ value: "abc", cursor: 2 });
  expect(editInput(state, { type: "kill-start" })).toEqual({ value: "c", cursor: 0 });
});

test("Ctrl-D exits only on empty input", () => {
  expect(editInput({ value: "", cursor: 0 }, { type: "eof" }).outcome).toBe("eof");
  expect(editInput({ value: "x", cursor: 1 }, { type: "eof" }).outcome).toBeUndefined();
});
