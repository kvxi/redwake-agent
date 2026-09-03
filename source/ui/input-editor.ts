export interface EditorSelection { start: number; end: number }

export type EditorAction =
  | { type: "insert"; text: string }
  | { type: "left" | "right" | "home" | "end" | "backspace" | "delete" | "kill-start" | "kill-end" | "select-all" }
  | { type: "submit" | "cancel" | "eof" };

export interface EditorState { value: string; cursor: number; selection?: EditorSelection }
export interface EditorResult extends EditorState { outcome?: "submit" | "cancel" | "eof" }

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function boundaries(value: string): number[] {
  return [...segmenter.segment(value)].map((part) => part.index).concat(value.length);
}

function normalizedSelection(state: EditorState): EditorSelection | undefined {
  if (!state.selection) return undefined;
  const start = Math.min(state.value.length, Math.max(0, Math.min(state.selection.start, state.selection.end)));
  const end = Math.min(state.value.length, Math.max(0, Math.max(state.selection.start, state.selection.end)));
  return start === end ? undefined : { start, end };
}

/** A small, grapheme-aware editor with a conventional replaceable selection. */
export function editInput(state: EditorState, action: EditorAction): EditorResult {
  const value = state.value;
  const points = boundaries(value);
  const requested = Math.min(Math.max(0, state.cursor), value.length);
  const cursor = points.findLast((point) => point <= requested) ?? 0;
  const pointIndex = points.indexOf(cursor);
  const previous = points[Math.max(0, pointIndex - 1)] ?? 0;
  const next = points[Math.min(points.length - 1, pointIndex + 1)] ?? value.length;
  const selection = normalizedSelection(state);
  const withoutSelection = selection
    ? { value: value.slice(0, selection.start) + value.slice(selection.end), cursor: selection.start }
    : { value, cursor };

  switch (action.type) {
    case "insert": {
      const text = action.text.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
      return {
        value: withoutSelection.value.slice(0, withoutSelection.cursor) + text + withoutSelection.value.slice(withoutSelection.cursor),
        cursor: withoutSelection.cursor + text.length,
      };
    }
    case "select-all": return value ? { value, cursor: value.length, selection: { start: 0, end: value.length } } : { value, cursor: 0 };
    case "left": return { value, cursor: selection ? selection.start : previous };
    case "right": return { value, cursor: selection ? selection.end : next };
    case "home": return { value, cursor: 0 };
    case "end": return { value, cursor: value.length };
    case "backspace": return selection ? withoutSelection : cursor ? { value: value.slice(0, previous) + value.slice(cursor), cursor: previous } : { value, cursor };
    case "delete": return selection ? withoutSelection : { value: value.slice(0, cursor) + value.slice(next), cursor };
    case "kill-start": return selection ? withoutSelection : { value: value.slice(cursor), cursor: 0 };
    case "kill-end": return selection ? withoutSelection : { value: value.slice(0, cursor), cursor };
    case "submit": return { value, cursor, ...(selection ? { selection } : {}), outcome: "submit" };
    case "cancel": return { value, cursor, ...(selection ? { selection } : {}), outcome: "cancel" };
    case "eof": return value ? { value, cursor, ...(selection ? { selection } : {}) } : { value, cursor, outcome: "eof" };
  }
}
