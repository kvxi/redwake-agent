import type { SessionStore } from "./store.ts";

export type SessionEvent =
  | { type: "user"; content: string }
  | { type: "assistant"; content: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      callId: string;
      content: string;
      isError: boolean;
    };

/** A provider-independent, context-budgeted view of a conversation. */
export interface ConversationSnapshot {
  summary?: string;
  facts: string[];
  recentEvents: SessionEvent[];
  /** Number of leading source events represented by `summary`. */
  coveredEventCount: number;
}

export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  switch (event.type) {
    case "user":
    case "assistant":
      return typeof event.content === "string";
    case "tool_call":
      return typeof event.id === "string" && typeof event.name === "string" && "input" in event;
    case "tool_result":
      return (
        typeof event.callId === "string" &&
        typeof event.content === "string" &&
        typeof event.isError === "boolean"
      );
    default:
      return false;
  }
}

function eventSize(event: SessionEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 1_000;
  }
}

/**
 * Canonical owner of session history. Returned arrays and events are cloned so
 * callers cannot mutate the authoritative transcript.
 */
export class ConversationState {
  private readonly transcript: SessionEvent[];

  constructor(
    private readonly store?: SessionStore,
    initialEvents: readonly SessionEvent[] = [],
  ) {
    this.transcript = structuredClone([...initialEvents]);
  }

  get events(): readonly SessionEvent[] {
    return structuredClone(this.transcript);
  }

  append(event: SessionEvent): void {
    if (!isSessionEvent(event)) throw new TypeError("Invalid session event");
    const copy = structuredClone(event);
    this.transcript.push(copy);
    this.store?.append(copy);
  }

  /**
   * Return exact history when it fits. The summary branch is deliberately a
   * deterministic extension point; a semantic summarizer can replace it
   * without changing provider adapters.
   */
  snapshot(maxCharacters = Number.POSITIVE_INFINITY): ConversationSnapshot {
    const events = this.events as SessionEvent[];
    let size = 0;
    let start = events.length;
    while (start > 0) {
      const next = eventSize(events[start - 1]!);
      if (size + next > maxCharacters && start < events.length) break;
      if (next > maxCharacters && start === events.length) break;
      size += next;
      start -= 1;
    }
    if (start === 0) return { facts: [], recentEvents: events, coveredEventCount: 0 };
    return {
      summary: `[${start} earlier conversation events omitted to fit the target model context.]`,
      facts: [],
      recentEvents: events.slice(start),
      coveredEventCount: start,
    };
  }
}
