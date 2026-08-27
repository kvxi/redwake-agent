import { describe, expect, test } from "bun:test";
import { ConversationState } from "../source/session/conversation-state.ts";
import { toAnthropicHistory, toOpenAIHistory } from "../source/agent/history.ts";

const state = new ConversationState(undefined, [
  { type: "user", content: "change the parser" },
  { type: "assistant", content: "I will inspect it." },
  { type: "tool_call", id: "provider-specific-id", name: "read", input: { file_path: "parser.ts" } },
  { type: "tool_result", callId: "provider-specific-id", content: "source", isError: false },
  { type: "assistant", content: "The parser uses zod." },
]);

describe("provider history adapters", () => {
  test("translates text and completed tool history for Anthropic without native IDs", () => {
    const history = toAnthropicHistory(state.snapshot());
    expect(history[0]).toEqual({ role: "user", content: "change the parser" });
    expect(JSON.stringify(history)).toContain("Previous tool interaction");
    expect(JSON.stringify(history)).not.toContain("provider-specific-id");
    expect(JSON.stringify(history)).not.toContain("tool_use_id");
    expect(JSON.stringify(history)).not.toContain('"type":"tool_use"');
  });

  test("translates history for OpenAI without unmatched function calls", () => {
    const history = toOpenAIHistory(state.snapshot());
    expect(history[0]).toEqual({ role: "user", content: "change the parser" });
    expect(JSON.stringify(history)).toContain("Result: source");
    expect(JSON.stringify(history)).not.toContain("function_call_output");
  });

  test("marks tool errors and unmatched results as ordinary context", () => {
    const errorState = new ConversationState(undefined, [
      { type: "tool_result", callId: "lost", content: "denied", isError: true },
    ]);
    const text = JSON.stringify(toAnthropicHistory(errorState.snapshot()));
    expect(text).toContain("unmatched tool result");
    expect(text).toContain("error");
  });
});
