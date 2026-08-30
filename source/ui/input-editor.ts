export type EditorAction =
  | { type: "insert"; text: string }
  | { type: "left" | "right" | "home" | "end" | "backspace" | "delete" | "kill-start" | "kill-end" }
  | { type: "submit" | "cancel" | "eof" };

export interface EditorState { value: string; cursor: number }
export interface EditorResult extends EditorState { outcome?: "submit" | "cancel" | "eof" }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function boundaries(value: string): number[] {
  return [...segmenter.segment(value)].map((part) => part.index).concat(value.length);
}

export function editInput(state: EditorState, action: EditorAction): EditorResult {
  const value = state.value;
  const points = boundaries(value);
  const requested = Math.min(Math.max(0, state.cursor), value.length);
  const cursor = points.findLast((point) => point <= requested) ?? 0;
  const pointIndex = points.indexOf(cursor);
  const previous = points[Math.max(0, pointIndex - 1)] ?? 0;
  const next = points[Math.min(points.length - 1, pointIndex + 1)] ?? value.length;
  switch (action.type) {
    case "insert": {
      const text = action.text.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
      return { value: value.slice(0, cursor) + text + value.slice(cursor), cursor: cursor + text.length };
    }
    case "left": return { value, cursor: previous };
    case "right": return { value, cursor: next };
    case "home": return { value, cursor: 0 };
    case "end": return { value, cursor: value.length };
    case "backspace": return cursor ? { value: value.slice(0, previous) + value.slice(cursor), cursor: previous } : { value, cursor };
    case "delete": return { value: value.slice(0, cursor) + value.slice(next), cursor };
    case "kill-start": return { value: value.slice(cursor), cursor: 0 };
    case "kill-end": return { value: value.slice(0, cursor), cursor };
    case "submit": return { value, cursor, outcome: "submit" };
    case "cancel": return { value, cursor, outcome: "cancel" };
    case "eof": return value ? { value, cursor } : { value, cursor, outcome: "eof" };
  }
}
