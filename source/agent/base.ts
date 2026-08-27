import { ConversationState } from "../session/conversation-state.ts";
import type { SessionStore } from "../session/store.ts";
import { createToolContext, type ToolContext } from "../tools/context.ts";
import { runTool } from "../tools/registry.ts";
import type { Conversation } from "./conversation.ts";

export interface AgentBaseOptions {
  ctx?: ToolContext;
  print?: (text: string) => void;
  /** Shared canonical history. A private state is created for compatibility. */
  conversation?: ConversationState;
  /** @deprecated Persistence is owned by ConversationState. */
  store?: SessionStore;
}

export interface NormalizedToolCall {
  id: string;
  name: string;
  input?: unknown;
  inputError?: string;
  /** @deprecated Prefer an already normalized `input`. */
  decodeInput?: () => unknown;
}

/** Provider-independent lifecycle; subclasses own only active wire protocol. */
export abstract class AgentBase<Response, ToolResult> implements Conversation {
  protected readonly ctx: ToolContext;
  protected readonly conversation: ConversationState;
  private readonly print: (text: string) => void;

  protected constructor(options: AgentBaseOptions = {}) {
    this.ctx = options.ctx ?? createToolContext();
    this.print = options.print ?? ((text) => console.log(text));
    this.conversation = options.conversation ?? new ConversationState(options.store);
  }

  protected abstract appendUser(userMessage: string): void;
  protected abstract request(): Promise<Response>;
  protected abstract remember(response: Response): void;
  protected abstract responseText(response: Response): string;
  protected abstract toolCalls(response: Response): Iterable<NormalizedToolCall>;
  protected abstract encodeToolResult(call: NormalizedToolCall, content: string, isError: boolean): ToolResult;
  protected abstract appendToolResults(results: ToolResult[]): void;

  protected async executeToolCalls(calls: Iterable<NormalizedToolCall>): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const original of calls) {
      let input = original.input;
      let inputError = original.inputError;
      if (!("input" in original) && original.decodeInput) {
        try {
          input = original.decodeInput();
        } catch (error) {
          inputError = error instanceof Error ? error.message : String(error);
          input = null;
        }
      }
      const call = { ...original, input, inputError };
      this.conversation.append({ type: "tool_call", id: call.id, name: call.name, input });

      let content: string;
      let isError = false;
      try {
        if (inputError) throw new Error(inputError);
        const output = await runTool(call.name, input, this.ctx);
        content = JSON.stringify(output);
      } catch (error) {
        isError = true;
        const detail = error instanceof Error ? error.message : String(error);
        content = JSON.stringify({ error: detail });
      }
      this.conversation.append({ type: "tool_result", callId: call.id, content, isError });
      results.push(this.encodeToolResult(call, content, isError));
    }
    return results;
  }

  async runTurn(userMessage: string): Promise<void> {
    this.conversation.append({ type: "user", content: userMessage });
    this.appendUser(userMessage);
    while (true) {
      const response = await this.request();
      this.remember(response);
      const text = this.responseText(response);
      if (text) {
        this.print(text);
        this.conversation.append({ type: "assistant", content: text });
      }
      const toolResults = await this.executeToolCalls([...this.toolCalls(response)]);
      if (toolResults.length === 0) return;
      this.appendToolResults(toolResults);
    }
  }
}
