import type { Theme } from "./theme.ts";
import type { TranscriptBlock, TuiState } from "./tui-state.ts";
import { compactPath, displayWidth, linkifyUrls, padDisplay, sanitizeSingleLine, sanitizeTerminalText, truncateEnd, truncateStart, wrapText } from "./terminal-text.ts";

export interface Frame { lines: string[]; cursor?: { row: number; column: number }; softWrapRows?: number[] }

// Internal placeholder for physical rows occupied by a terminal-soft-wrapped
// line. It is never written to the terminal.
const SOFT_WRAP_ROW = "\u0000soft-wrap-row";

const wrapCache = new WeakMap<object, Map<number, string[]>>();
function wrapped(block: object, text: string, width: number): string[] {
  let widths = wrapCache.get(block);
  if (!widths) { widths = new Map(); wrapCache.set(block, widths); }
  const cached = widths.get(width);
  if (cached) return cached;
  const lines = wrapText(text, width);
  widths.set(width, lines);
  return lines;
}

function box(lines: string[], width: number, theme: Theme): string[] {
  if (width < 20) return lines.map((line) => truncateEnd(line, width));
  const inner = width - 2;
  return [
    theme.border(`┌${"─".repeat(inner)}┐`),
    ...lines.map((line) => `${theme.border("│")}${padDisplay(line, inner)}${theme.border("│")}`),
    theme.border(`└${"─".repeat(inner)}┘`),
  ];
}

export function renderWelcome(state: TuiState, theme: Theme): string[] {
  const { columns: width, identity } = state;
  const workspace = compactPath(identity.cwd, Math.max(8, width > 90 ? 34 : width - 16));
  const session = `${identity.sessionNumber ? `session ${identity.sessionNumber}` : identity.sessionName} · ${identity.eventCount ? `${identity.eventCount} events` : "new"}`;
  if (width < 30) return [theme.accent("REDWAKE"), truncateEnd(`${identity.model} · ${session}`, width), "Commands: /model /tree", " /sessions /status"].map((x) => truncateEnd(x, width));
  const contentWidth = width - 4;
  const lines = [theme.accent(" REDWAKE")];
  if (width >= 90) {
    const half = Math.floor(contentWidth / 2);
    lines.push(`${padDisplay(` Model     ${identity.model}`, half)}${truncateEnd(` Provider  ${identity.provider}`, contentWidth - half)}`);
    lines.push(`${padDisplay(` Workspace ${workspace}`, half)}${truncateEnd(` Session   ${session}`, contentWidth - half)}`);
  } else {
    lines.push(` Model      ${identity.model} (${identity.provider})`);
    lines.push(` Workspace  ${workspace}`);
    lines.push(` Session    ${session}`);
  }
  lines.push(" Commands   /model · /api · /tree · /sessions · /status");
  return box(lines, width, theme);
}

function renderBlock(block: TranscriptBlock, state: TuiState, theme: Theme): string[] {
  const width = state.columns;
  if (block.kind === "welcome") return renderWelcome(state, theme);
  if (block.kind === "user") return wrapped(block, block.text, Math.max(1, width - 2)).map((line, i) => i === 0 ? `${theme.accent("›")} ${theme.primary(line)}` : `  ${theme.primary(line)}`);
  if (block.kind === "assistant") return wrapped(block, block.text, width);
  if (block.kind === "tool") {
    const mark = block.tone === "error" ? theme.error("✗") : block.tone === "success" ? theme.success("✓") : theme.secondary("●");
    return wrapText(`${mark} ${sanitizeSingleLine(block.text)}`, width);
  }
  const color = block.tone === "error" ? theme.error : block.tone === "success" ? theme.success : theme.warning;
  const lines: string[] = [];
  for (const sourceLine of sanitizeTerminalText(block.text).split("\n")) {
    // URLs are deliberately left as a single logical line. The terminal can
    // soft-wrap them without inserting copy-breaking newline characters.
    const hasUrl = /https?:\/\//.test(sourceLine);
    const rendered = hasUrl ? [linkifyUrls(sourceLine)] : wrapText(sourceLine, Math.max(1, width));
    lines.push(...rendered.map((line) => color(line)));
    if (hasUrl) {
      const continuationRows = Math.max(0, Math.ceil(displayWidth(sourceLine) / Math.max(1, width)) - 1);
      for (let index = 0; index < continuationRows; index += 1) lines.push(SOFT_WRAP_ROW);
    }
  }
  return lines;
}

function transcriptLines(state: TuiState, theme: Theme): string[] {
  const lines: string[] = [];
  for (const block of state.transcript) {
    if (lines.length) lines.push("");
    lines.push(...renderBlock(block, state, theme));
  }
  return lines;
}

interface InputRow { text: string; start: number; end: number }
interface InputLayout {
  boxed: boolean;
  before: string;
  rows: InputRow[];
  visibleStart: number;
  cursorRow: number;
  cursorColumn: number;
  promptRows: number;
  inner: number;
}

const inputSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Wrap editor text without dropping whitespace, so cursor/selection offsets stay exact. */
function wrapInput(value: string, firstWidth: number, continuationWidth: number): InputRow[] {
  const rows: InputRow[] = [];
  let start = 0;
  let text = "";
  let used = 0;
  let width = firstWidth;
  for (const part of inputSegmenter.segment(value)) {
    const index = part.index;
    const segment = part.segment;
    if (segment === "\n" || segment === "\r\n" || segment === "\r") {
      rows.push({ text, start, end: index });
      start = index + segment.length;
      text = "";
      used = 0;
      width = continuationWidth;
      continue;
    }
    const partWidth = displayWidth(segment);
    if (text && used + partWidth > width) {
      rows.push({ text, start, end: index });
      start = index;
      text = "";
      used = 0;
      width = continuationWidth;
    }
    // A double-width glyph cannot fit in a one-column terminal. Truncation is
    // preferable to letting the input box paint into its border.
    if (!text && partWidth > width) {
      rows.push({ text: truncateEnd(segment, width), start, end: index + segment.length });
      start = index + segment.length;
      width = continuationWidth;
      continue;
    }
    text += segment;
    used += partWidth;
  }
  rows.push({ text, start, end: value.length });
  return rows;
}

function inputLayout(state: TuiState): InputLayout {
  const terminalRows = Math.max(3, state.rows);
  const boxed = terminalRows >= 6 && state.columns >= 3;
  const inner = boxed ? Math.max(1, state.columns - 2) : Math.max(1, state.columns);
  const label = truncateEnd(state.input.label, Math.max(1, Math.floor(inner / 2)));
  const before = `${label} `;
  const firstWidth = Math.max(1, inner - displayWidth(before));
  const displayValue = state.input.secret ? "•".repeat(state.input.value.length) : state.input.value;
  const rows = wrapInput(displayValue, firstWidth, inner);
  let cursorRow = 0;
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]!.start <= state.input.cursor) cursorRow = index;
  }
  const cursor = Math.min(rows[cursorRow]!.end, Math.max(rows[cursorRow]!.start, state.input.cursor));
  const cursorColumn = (cursorRow === 0 ? displayWidth(before) : 0)
    + displayWidth(displayValue.slice(rows[cursorRow]!.start, cursor));

  // Always retain a transcript row and the status line. Very large prompts
  // become a cursor-following window, while ordinary wrapped prompts show in full.
  const maxContentRows = boxed ? Math.max(1, terminalRows - 4) : 1;
  const visibleCount = state.input.active ? Math.min(rows.length, maxContentRows) : 1;
  const visibleStart = Math.max(0, Math.min(cursorRow, rows.length - visibleCount));
  return {
    boxed,
    before,
    rows: rows.slice(visibleStart, visibleStart + visibleCount),
    visibleStart,
    cursorRow,
    cursorColumn,
    promptRows: boxed ? visibleCount + 2 : 1,
    inner,
  };
}

/** The scroll range used by both rendering and the keyboard handler. */
export function transcriptScrollRange(state: TuiState, theme: Theme): { viewportHeight: number; maxScroll: number } {
  const rows = Math.max(3, state.rows);
  const promptRows = inputLayout(state).promptRows;
  const viewportHeight = Math.max(1, rows - promptRows - 1);
  return { viewportHeight, maxScroll: Math.max(0, transcriptLines(state, theme).length - viewportHeight) };
}

function renderOverlay(state: TuiState, height: number, theme: Theme): string[] | undefined {
  const overlay = state.overlay;
  if (!overlay) return undefined;
  const width = state.columns;
  const bodyRows = Math.max(1, height - 4);
  const maxOffset = Math.max(0, overlay.rows.length - bodyRows);
  const offset = Math.min(overlay.offset, maxOffset);
  const visible = overlay.rows.slice(offset, offset + bodyRows).map((row, i) => {
    const selected = offset + i === overlay.selected;
    return `${selected ? theme.accent("❯") : " "} ${truncateEnd(row, Math.max(1, width - 4))}`;
  });
  while (visible.length < bodyRows) visible.push("");
  return box([theme.primary(` ${overlay.title}`), ...visible, theme.secondary(` ${overlay.footer}`)], width, theme).slice(0, height);
}

function statusText(state: TuiState): string {
  const pieces = [state.activity.label ?? state.activity.kind];
  if (!state.followOutput) pieces.push("history (End to follow)");
  pieces.push(state.identity.model);
  const session = state.identity.sessionNumber ? `s${state.identity.sessionNumber}` : state.identity.sessionName;
  pieces.push(`${session}:${state.identity.eventCount}`);
  pieces.push(compactPath(state.identity.cwd, 30));
  pieces.push(state.identity.provider);
  if (state.identity.reasoning) pieces.push(state.identity.reasoning);
  while (pieces.length > 1 && displayWidth(pieces.join(" · ")) > state.columns - 2) pieces.pop();
  return pieces.join(" · ");
}

export function renderFrame(state: TuiState, theme: Theme): Frame {
  const rows = Math.max(3, state.rows);
  const editor = inputLayout(state);
  const promptRows = editor.promptRows;
  const viewportHeight = Math.max(1, rows - promptRows - 1);
  const all = transcriptLines(state, theme);
  const maxScroll = Math.max(0, all.length - viewportHeight);
  // scrollOffset is an absolute transcript line while output is not being
  // followed. Keeping it absolute prevents streaming text from moving the
  // viewport out from under a user who is reading older output.
  const start = state.followOutput ? maxScroll : Math.min(maxScroll, Math.max(0, state.scrollOffset));
  let viewport = all.slice(start, start + viewportHeight);
  const overlay = renderOverlay(state, viewportHeight, theme);
  if (overlay) viewport = overlay;
  const softWrapRows: number[] = [];
  let hasVisibleSoftWrapSource = false;
  viewport = viewport.map((line, index) => {
    if (line === SOFT_WRAP_ROW) {
      if (hasVisibleSoftWrapSource) softWrapRows.push(index);
      return "";
    }
    hasVisibleSoftWrapSource = displayWidth(line) > state.columns;
    return line;
  });
  // Lines are cleared by TerminalScreen before being redrawn, so padding the
  // transcript to terminal width is unnecessary and pollutes mouse selection.
  while (viewport.length < viewportHeight) viewport.push("");

  const selection = state.input.selection;
  const selectedRow = (row: InputRow): string => {
    if (!selection || selection.start === selection.end || state.input.secret) return row.text;
    const start = Math.max(row.start, Math.min(selection.start, selection.end));
    const end = Math.min(row.end, Math.max(selection.start, selection.end));
    if (start >= end) return row.text;
    return row.text.slice(0, start - row.start)
      + theme.selection(row.text.slice(start - row.start, end - row.start))
      + row.text.slice(end - row.start);
  };
  const content = editor.rows.map((row, index) => padDisplay((editor.visibleStart + index === 0 ? editor.before : "") + selectedRow(row), editor.inner));
  let prompt: string[];
  if (editor.boxed) prompt = [
    theme.border(`┌${"─".repeat(editor.inner)}┐`),
    ...content.map((line) => `${theme.border("│")}${line}${theme.border("│")}`),
    theme.border(`└${"─".repeat(editor.inner)}┘`),
  ];
  else prompt = content;
  const status = theme.secondary(padDisplay(` ${statusText(state)}`, state.columns));
  const frame: Frame = { lines: [...viewport, ...prompt, status], ...(softWrapRows.length ? { softWrapRows } : {}) };
  if (state.input.active && !state.overlay) {
    const visibleCursorRow = editor.cursorRow - editor.visibleStart;
    frame.cursor = {
      row: viewportHeight + (editor.boxed ? 2 : 1) + visibleCursorRow,
      column: Math.min(state.columns, (editor.boxed ? 2 : 1) + editor.cursorColumn),
    };
  }
  return frame;
}
