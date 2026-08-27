import { createToolContext, type ToolContext } from "../tools/context.ts";
import { runTool } from "../tools/registry.ts";
import type { SessionStore } from "../session/store.ts";
import type { Conversation } from "./conversation.ts";

export interface AgentBaseOptions {
  ctx?: ToolContext;
  print?: (text: string) => void;
  store?: SessionStore;
}

/** A provider call normalized enough for shared execution. */
export interface NormalizedToolCall {
  id: string;
  name: string;
  decodeInput: () => unknown;
}

/**
 * Provider-independent turn lifecycle. Subclasses own their wire protocol and
 * conversation history; this class owns persistence, output, and tool errors.
 */
export abstract class AgentBase<Response, ToolResult>
  implements Conversation
{
  protected readonly ctx: ToolContext;
  private readonly print: (text: string) => void;
  private readonly store: SessionStore | undefined;

  protected constructor(options: AgentBaseOptions = {}) {
    this.ctx = options.ctx ?? createToolContext();
    this.print = options.print ?? ((text) => console.log(text));
    this.store = options.store;
  }

  protected abstract appendUser(userMessage: string): void;
  protected abstract request(): Promise<Response>;
  protected abstract remember(response: Response): void;
  protected abstract responseText(response: Response): string;
  protected abstract toolCalls(response: Response): Iterable<NormalizedToolCall>;
  protected abstract encodeToolResult(
    call: NormalizedToolCall,
    content: string,
    isError: boolean,
  ): ToolResult;
  protected abstract appendToolResults(results: ToolResult[]): void;

  protected async executeToolCalls(
    calls: Iterable<NormalizedToolCall>,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const call of calls) {
      try {
        const output = await runTool(call.name, call.decodeInput(), this.ctx);
        results.push(this.encodeToolResult(call, JSON.stringify(output), false));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        results.push(
          this.encodeToolResult(
            call,
            JSON.stringify({ error: detail }),
            true,
          ),
        );
      }
    }
    return results;
  }

  async runTurn(userMessage: string): Promise<void> {
    this.appendUser(userMessage);
    this.store?.append({ role: "user", content: userMessage });

    while (true) {
      const response = await this.request();
      this.remember(response);

      const text = this.responseText(response);
      if (text) {
        this.print(text);
        this.store?.append({ role: "assistant", content: text });
      }

      const toolResults = await this.executeToolCalls(this.toolCalls(response));
      if (toolResults.length === 0) return;
      this.appendToolResults(toolResults);
    }
  }
}
