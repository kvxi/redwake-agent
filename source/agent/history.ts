import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import type { ResponseInput } from "openai/resources/responses/responses";
import type { ConversationSnapshot, SessionEvent } from "../session/conversation-state.ts";

function printable(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable input]";
  }
}

/** Render historical tools as ordinary text, never as unmatched wire objects. */
export function toolHistoryText(events: readonly SessionEvent[]): Map<number, string> {
  const rendered = new Map<number, string>();
  const consumedResults = new Set<number>();
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type !== "tool_call") continue;
    const resultIndex = events.findIndex(
      (candidate, index) =>
        index > i &&
        !consumedResults.has(index) &&
        candidate.type === "tool_result" &&
        candidate.callId === event.id,
    );
    if (resultIndex >= 0) consumedResults.add(resultIndex);
    const result = resultIndex >= 0 ? events[resultIndex] : undefined;
    const resultLines =
      result?.type === "tool_result"
        ? `\n- Status: ${result.isError ? "error" : "success"}\n- Result: ${result.content}`
        : "\n- Result: [not recorded]";
    rendered.set(
      i,
      `Previous tool interaction:\n- Tool: ${event.name}\n- Input: ${printable(event.input)}${resultLines}`,
    );
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]!;
    if (event.type === "tool_result" && !consumedResults.has(i)) {
      rendered.set(
        i,
        `Previous unmatched tool result (${event.callId}, ${event.isError ? "error" : "success"}):\n${event.content}`,
      );
    }
  }
  return rendered;
}

function flattened(snapshot: ConversationSnapshot): Array<{ role: "user" | "assistant"; content: string }> {
  const output: Array<{ role: "user" | "assistant"; content: string }> = [];
  const push = (role: "user" | "assistant", content: string) => {
    if (!content) return;
    const prior = output.at(-1);
    if (prior?.role === role) prior.content += `\n\n${content}`;
    else output.push({ role, content });
  };
  if (snapshot.summary) push("user", `Conversation summary:\n${snapshot.summary}`);
  if (snapshot.facts.length) push("user", `Important facts:\n- ${snapshot.facts.join("\n- ")}`);
  const tools = toolHistoryText(snapshot.recentEvents);
  for (let i = 0; i < snapshot.recentEvents.length; i += 1) {
    const event = snapshot.recentEvents[i]!;
    if (event.type === "user" || event.type === "assistant") push(event.type, event.content);
    else if (event.type === "turn_interrupted") {
      push("assistant", "[Assistant turn interrupted by the user before completion. Do not continue it unless the user's next message asks you to.]");
    } else if (tools.has(i)) push("user", tools.get(i)!);
  }
  return output;
}

export function toAnthropicHistory(snapshot: ConversationSnapshot): MessageParam[] {
  return flattened(snapshot).map(({ role, content }) => ({ role, content }));
}

export function toOpenAIHistory(snapshot: ConversationSnapshot): ResponseInput {
  return flattened(snapshot).map(({ role, content }) => ({ role, content }));
}
