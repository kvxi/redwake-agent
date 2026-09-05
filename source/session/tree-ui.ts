import type { ConversationEntry } from "./conversation-state.ts";
import { sanitizeSingleLine, truncateEnd } from "../ui/terminal-text.ts";

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

function cleanPreview(text: string): string { return sanitizeSingleLine(text); }

function truncate(text: string, width: number): string { return truncateEnd(text, width); }

const BOLD_RED = "\x1b[1;31m";
const BOLD_BLUE = "\x1b[1;33m";
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
    case "turn_interrupted":
      label = "interrupted";
      preview = "turn stopped by user";
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

export interface TreeSelectorIO {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  write?: (text: string) => void;
  pause?: () => void;
  resume?: () => void;
  columns?: number;
  rows?: number;
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

/** Legacy compatibility shim. Interactive list ownership now belongs to TuiApp. */
export async function selectListItem<T, R>(
  _items: readonly T[],
  _options: ListSelectorOptions<T, R>,
  _io: TreeSelectorIO = {},
): Promise<R | null> {
  // PlainReplIO provides a deterministic numbered selection; TuiApp hosts the
  // interactive overlay. Session modules no longer acquire raw terminal state.
  return null;
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
    (io.write ?? ((text: string) => io.output?.write(text)))("Session tree is empty.\n");
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
