import type { SessionEvent } from "./conversation-state.ts";
import type { SessionSummary } from "./navigator.ts";
import { selectListItem, type TreeRowOptions, type TreeSelectorIO } from "./tree-ui.ts";

const ANSI_ESCAPE = /\x1B(?:[@-_]|\[[0-?]*[ -/]*[@-~])/g;

function clean(text: string): string {
  return text
    .replace(ANSI_ESCAPE, "")
    .replace(/[\n\r\t]+/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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
  }
}

function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width === 1) return "…";
  return `${text.slice(0, width - 1)}…`;
}

export function formatSessionRow(summary: SessionSummary, options: TreeRowOptions = {}): string {
  const marker = options.selected ? "❯ " : "  ";
  const active = summary.active ? " · active" : "";
  const preview = summary.preview ? ` · ${eventPreview(summary.preview)}` : "";
  const body = clean(`${summary.name} · ${summary.eventCount} events${active}${preview}`);
  return truncate(`${marker}${body}`, Math.max(0, options.width ?? 80));
}

export async function selectSession(
  sessions: readonly SessionSummary[],
  io: TreeSelectorIO = {},
): Promise<string | null> {
  return selectListItem(sessions, {
    format: formatSessionRow,
    value: (session) => session.path,
    footer: "↑/↓ navigate · enter continue · esc cancel",
  }, io);
}
