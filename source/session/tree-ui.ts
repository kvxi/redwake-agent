import { emitKeypressEvents } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { ConversationEntry } from "./conversation-state.ts";

const ANSI_ESCAPE = /\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;

export interface TreeRowOptions {
  width?: number;
  selected?: boolean;
}

function safeStringify(value: unknown): string {
  try {
    const result = JSON.stringify(value);
    return result === undefined ? "[unserializable input]" : result;
  } catch {
    return "[unserializable input]";
  }
}

function cleanPreview(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

const BOLD_RED = "\x1b[1;31m";
const BOLD_BLUE = "\x1b[1;34m";
const RESET_STYLE = "\x1b[0m";

/** Format one inert, single-line event preview suitable for terminal painting. */
export function formatTreeRow(entry: ConversationEntry, options: TreeRowOptions = {}): string {
  const width = Math.max(0, options.width ?? 80);
  const marker = options.selected ? "❯ " : "  ";
  const event = entry.event;
  let label: string;
  let preview: string;
  switch (event.type) {
    case "user":
      label = "user";
      preview = event.content;
      break;
    case "assistant":
      label = "assistant";
      preview = event.content;
      break;
    case "tool_call":
      label = `tool ${event.name}`;
      preview = safeStringify(event.input);
      break;
    case "tool_result":
      label = `result (${event.isError ? "error" : "ok"})`;
      preview = event.content;
      break;
  }
  const row = truncate(`${marker}${label}: ${cleanPreview(preview)}`, width);
  if (row.length <= marker.length) return row;

  // Keep the selection marker outside the role styling so it remains visually stable.
  // ANSI sequences are added after truncation and therefore do not consume display width.
  const style = event.type === "user"
    ? BOLD_RED
    : event.type === "assistant"
      ? BOLD_BLUE
      : null;
  if (!style) return row;
  return `${row.slice(0, marker.length)}${style}${row.slice(marker.length)}${RESET_STYLE}`;
}

export type TreeSelectionKey = "up" | "down" | "enter" | "escape" | "ctrl-c";
export interface TreeSelectionState {
  selected: number;
  offset: number;
  itemCount: number;
  /** Number of event rows visible at once. */
  rowCount: number;
}
export interface TreeSelectionResult extends TreeSelectionState {
  outcome: "confirm" | "cancel" | null;
}

/** Pure keyboard/viewport reducer used by the interactive selector. */
export function nextSelection(state: TreeSelectionState, key: TreeSelectionKey): TreeSelectionResult {
  const itemCount = Math.max(0, state.itemCount);
  const rowCount = Math.max(1, state.rowCount);
  let selected = itemCount === 0 ? 0 : Math.min(Math.max(0, state.selected), itemCount - 1);
  let outcome: TreeSelectionResult["outcome"] = null;
  if (key === "up") selected = Math.max(0, selected - 1);
  else if (key === "down") selected = Math.min(Math.max(0, itemCount - 1), selected + 1);
  else if (key === "enter") outcome = "confirm";
  else if (key === "escape" || key === "ctrl-c") outcome = "cancel";

  const maxOffset = Math.max(0, itemCount - rowCount);
  let offset = Math.min(Math.max(0, state.offset), maxOffset);
  if (selected < offset) offset = selected;
  if (selected >= offset + rowCount) offset = selected - rowCount + 1;
  return { selected, offset, itemCount, rowCount, outcome };
}

interface Keypress {
  name?: string;
  ctrl?: boolean;
}

export interface TreeSelectorIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  write?: (text: string) => void;
  pause?: () => void;
  resume?: () => void;
  columns?: number;
  rows?: number;
}

function keyName(key: Keypress): TreeSelectionKey | null {
  if (key.ctrl && key.name === "c") return "ctrl-c";
  if (key.name === "up") return "up";
  if (key.name === "down") return "down";
  if (key.name === "return" || key.name === "enter") return "enter";
  if (key.name === "escape") return "escape";
  return null;
}

export type ListActivation<T, R> =
  | { type: "select"; value: R | null }
  | { type: "update"; items: readonly T[]; selected?: number };

export interface ListSelectorOptions<T, R> {
  format: (item: T, options: TreeRowOptions) => string;
  value: (item: T) => R;
  footer: string;
  /** Optionally turn Enter into an in-place list update instead of selection. */
  activate?: (item: T, index: number) => ListActivation<T, R>;
}

/** Shared raw-terminal list selector used by both /tree and /sessions. */
export async function selectListItem<T, R>(
  items: readonly T[],
  options: ListSelectorOptions<T, R>,
  io: TreeSelectorIO = {},
): Promise<R | null> {
  if (items.length === 0) return null;
  const input = io.input ?? defaultInput;
  const output = io.output ?? defaultOutput;
  const write = io.write ?? ((text: string) => output.write(text));
  if (!input.isTTY) return null;

  const columns = Math.max(20, io.columns ?? output.columns ?? 80);
  const terminalRows = Math.max(4, io.rows ?? output.rows ?? 24);
  const rowCount = Math.max(1, terminalRows - 2);
  let currentItems = [...items];
  let state: TreeSelectionState = {
    selected: currentItems.length - 1,
    offset: Math.max(0, currentItems.length - rowCount),
    itemCount: currentItems.length,
    rowCount,
  };
  let paintedLines = 0;

  const paint = () => {
    if (paintedLines > 0) write(`\x1b[${paintedLines}F`);
    write("\x1b[0m");
    const visible = currentItems.slice(state.offset, state.offset + rowCount);
    const lines = visible.map((item, index) =>
      `\x1b[2K${options.format(item, { width: columns, selected: state.offset + index === state.selected })}`,
    );
    lines.push(`\x1b[2K${options.footer}`);
    write(`${lines.join("\n")}\n`);
    paintedLines = lines.length;
  };

  const wasRaw = Boolean(input.isRaw);
  io.pause?.();
  emitKeypressEvents(input);
  input.setRawMode?.(true);
  input.resume();
  write("\x1b[?25l");

  try {
    paint();
    return await new Promise<R | null>((resolve) => {
      const finish = (value: R | null) => {
        input.off("keypress", onKeypress);
        resolve(value);
      };
      const onKeypress = (_text: string, key: Keypress) => {
        const name = keyName(key);
        if (!name) return;
        const next = nextSelection(state, name);
        state = next;
        if (next.outcome === "confirm") {
          const item = currentItems[next.selected];
          if (item === undefined) {
            finish(null);
          } else {
            const activation = options.activate?.(item, next.selected);
            if (!activation) {
              finish(options.value(item));
            } else if (activation.type === "select") {
              finish(activation.value);
            } else {
              currentItems = [...activation.items];
              const selected = Math.min(
                Math.max(0, activation.selected ?? next.selected),
                Math.max(0, currentItems.length - 1),
              );
              const normalized = nextSelection({
                ...state,
                selected,
                itemCount: currentItems.length,
              }, "enter");
              state = normalized;
              paint();
            }
          }
        } else if (next.outcome === "cancel") finish(null);
        else paint();
      };
      input.on("keypress", onKeypress);
    });
  } finally {
    input.setRawMode?.(wasRaw);
    write("\x1b[?25h\x1b[0m");
    input.pause();
    io.resume?.();
  }
}

export type TreeDisplayRow =
  | { kind: "event"; entry: ConversationEntry; nested: boolean }
  | {
      kind: "tool_group";
      startIndex: number;
      entries: readonly ConversationEntry[];
      callCount: number;
      expanded: boolean;
    };

function isToolEntry(entry: ConversationEntry): boolean {
  return entry.event.type === "tool_call" || entry.event.type === "tool_result";
}

/** Collapse each consecutive run of tool events into one expandable row. */
export function buildTreeRows(
  entries: readonly ConversationEntry[],
  expandedGroups: ReadonlySet<number> = new Set(),
): TreeDisplayRow[] {
  const rows: TreeDisplayRow[] = [];
  for (let cursor = 0; cursor < entries.length;) {
    const entry = entries[cursor]!;
    if (!isToolEntry(entry)) {
      rows.push({ kind: "event", entry, nested: false });
      cursor += 1;
      continue;
    }

    const group: ConversationEntry[] = [];
    while (cursor < entries.length && isToolEntry(entries[cursor]!)) {
      group.push(entries[cursor]!);
      cursor += 1;
    }
    const startIndex = group[0]!.index;
    const expanded = expandedGroups.has(startIndex);
    rows.push({
      kind: "tool_group",
      startIndex,
      entries: group,
      callCount: group.filter((item) => item.event.type === "tool_call").length,
      expanded,
    });
    if (expanded) {
      rows.push(...group.map((item) => ({ kind: "event" as const, entry: item, nested: true })));
    }
  }
  return rows;
}

export function formatTreeDisplayRow(row: TreeDisplayRow, options: TreeRowOptions = {}): string {
  const width = Math.max(0, options.width ?? 80);
  if (row.kind === "event") {
    if (!row.nested) return formatTreeRow(row.entry, options);
    const formatted = formatTreeRow(row.entry, { ...options, width: Math.max(0, width - 2) });
    return formatted.length <= 2 ? formatted : `${formatted.slice(0, 2)}  ${formatted.slice(2)}`;
  }

  const marker = options.selected ? "❯ " : "  ";
  const disclosure = row.expanded ? "▼" : "▶";
  const count = row.callCount || row.entries.length;
  const noun = row.callCount === 0
    ? `tool event${count === 1 ? "" : "s"}`
    : `tool call${count === 1 ? "" : "s"}`;
  return truncate(`${marker}${disclosure} ${count} ${noun}`, width);
}

/** Display the current path and resolve to a transcript index, or null on cancel. */
export async function selectTreeNode(
  entries: readonly ConversationEntry[],
  io: TreeSelectorIO = {},
): Promise<number | null> {
  if (entries.length === 0) {
    const output = io.output ?? defaultOutput;
    (io.write ?? ((text: string) => output.write(text)))("Session tree is empty.\n");
    return null;
  }

  const expandedGroups = new Set<number>();
  let rows = buildTreeRows(entries, expandedGroups);
  return selectListItem(rows, {
    format: formatTreeDisplayRow,
    // Group rows are handled by activate and never selected as branch targets.
    value: (row) => row.kind === "event" ? row.entry.index : row.startIndex,
    activate: (row) => {
      if (row.kind === "event") return { type: "select", value: row.entry.index };
      if (expandedGroups.has(row.startIndex)) expandedGroups.delete(row.startIndex);
      else expandedGroups.add(row.startIndex);
      rows = buildTreeRows(entries, expandedGroups);
      return {
        type: "update",
        items: rows,
        selected: rows.findIndex(
          (candidate) => candidate.kind === "tool_group" && candidate.startIndex === row.startIndex,
        ),
      };
    },
    footer: "↑/↓ navigate · enter expand/branch · esc cancel",
  }, io);
}
