import type { SessionEvent } from "./conversation-state.ts";
import type { SessionSummary } from "./navigator.ts";
import { selectListItem, type TreeRowOptions, type TreeSelectorIO } from "./tree-ui.ts";
import { sanitizeSingleLine, truncateEnd } from "../ui/terminal-text.ts";

/** A value that cannot be confused with a session path. */
export const NEW_SESSION = Symbol("new-session");
export type SessionSelection = string | typeof NEW_SESSION;
export type SessionListItem = SessionSummary | { kind: "new-session" };

export function sessionListItems(sessions: readonly SessionSummary[]): SessionListItem[] {
  return [...sessions, { kind: "new-session" }];
}

function clean(text: string): string { return sanitizeSingleLine(text); }

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "[unserializable input]";
  } catch {
    return "[unserializable input]";
  }
}

function eventPreview(event: SessionEvent): string {
  switch (event.type) {
    case "user": return `user: ${event.content}`;
    case "assistant": return `assistant: ${event.content}`;
    case "tool_call": return `tool ${event.name}: ${safeStringify(event.input)}`;
    case "tool_result": return `result (${event.isError ? "error" : "ok"}): ${event.content}`;
    case "turn_interrupted": return "interrupted: turn stopped by user";
  }
}


export function formatSessionRow(summary: SessionSummary, options: TreeRowOptions = {}): string {
  const marker = options.selected ? "❯ " : "  ";
  const active = summary.active ? " · active" : "";
  const preview = summary.preview ? ` · ${eventPreview(summary.preview)}` : "";
  const body = clean(`${summary.name} · ${summary.eventCount} events${active}${preview}`);
  return truncateEnd(`${marker}${body}`, Math.max(0, options.width ?? 80));
}

export function formatSessionListItem(item: SessionListItem, options: TreeRowOptions = {}): string {
  if (!("kind" in item)) return formatSessionRow(item, options);
  const marker = options.selected ? "❯ " : "  ";
  return truncateEnd(`${marker}new session`, Math.max(0, options.width ?? 80));
}

export async function selectSession(
  sessions: readonly SessionSummary[],
  io: TreeSelectorIO = {},
): Promise<SessionSelection | null> {
  return selectListItem(sessionListItems(sessions), {
    format: formatSessionListItem,
    value: (item): SessionSelection => "kind" in item ? NEW_SESSION : item.path,
    footer: "↑/↓ navigate · enter select · esc cancel",
  }, io);
}
