import { ConversationState } from "../session/conversation-state.ts";
import type { SessionStore } from "../session/store.ts";
import { createToolContext, type ToolContext } from "../tools/context.ts";
import { runTool } from "../tools/registry.ts";
import type { Conversation } from "./conversation.ts";
import type { AgentProgressEvent, AgentProgressHandler } from "./progress.ts";

export interface AgentBaseOptions {
  ctx?: ToolContext;
  /** Resolved invocation workspace used by tools and prompt identity. */
  workspaceRoot?: string;
  print?: (text: string) => void;
  progress?: AgentProgressHandler;
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
  protected readonly workspaceRoot: string;
  private readonly print: (text: string) => void;
  private readonly progress?: AgentProgressHandler;
  private requestStreamedText = false;

  protected constructor(options: AgentBaseOptions = {}) {
    this.ctx = options.ctx ?? createToolContext({ workspaceRoot: options.workspaceRoot });
    this.workspaceRoot = options.workspaceRoot ?? process.cwd();
    this.print = options.print ?? ((text) => console.log(text));
    this.progress = options.progress;
    this.conversation = options.conversation ?? new ConversationState(options.store);
  }

  protected abstract appendUser(userMessage: string): void;
  protected abstract request(signal?: AbortSignal): Promise<Response>;
  protected abstract remember(response: Response): void;
  protected abstract responseText(response: Response): string;
  protected abstract toolCalls(response: Response): Iterable<NormalizedToolCall>;
  protected abstract encodeToolResult(call: NormalizedToolCall, content: string, isError: boolean): ToolResult;
  protected abstract appendToolResults(results: ToolResult[]): void;

  /** Renderer failures are deliberately isolated from the model/tool turn. */
  protected emit(event: AgentProgressEvent): void {
    if (!this.progress) return;
    try {
      this.progress(event);
    } catch {
      // Progress is best-effort and must never corrupt canonical history.
    }
  }

  protected emitTextDelta(delta: string): void {
    if (!delta) return;
    this.requestStreamedText = true;
    this.emit({ type: "text_delta", delta });
  }

  protected throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
  }

  protected async executeToolCalls(calls: Iterable<NormalizedToolCall>, signal?: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    for (const original of calls) {
      this.throwIfAborted(signal);
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

      const startedAt = performance.now();
      this.emit({ type: "tool_start", callId: call.id, name: call.name, input });
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
      } finally {
        this.emit({
          type: "tool_finish",
          callId: call.id,
          name: call.name,
          durationMs: Math.max(0, performance.now() - startedAt),
          isError,
        });
      }
      this.conversation.append({ type: "tool_result", callId: call.id, content, isError });
      results.push(this.encodeToolResult(call, content, isError));
      this.throwIfAborted(signal);
    }
    return results;
  }

  async runTurn(userMessage: string, signal?: AbortSignal): Promise<void> {
    this.conversation.append({ type: "user", content: userMessage });
    this.appendUser(userMessage);
    let interruptionRecorded = false;
    try {
      while (true) {
        this.throwIfAborted(signal);
        this.requestStreamedText = false;
        this.emit({ type: "request_start" });
        const response = await this.request(signal);
        // Do not accept a response that lost a race with cancellation.
        this.throwIfAborted(signal);
        this.remember(response);
        const text = this.responseText(response);
        if (text) {
          if (this.progress) {
            if (!this.requestStreamedText) this.emitTextDelta(text);
            this.emit({ type: "text_end" });
          } else {
            // Legacy print remains one complete response per invocation.
            this.print(text);
          }
          this.conversation.append({ type: "assistant", content: text });
        }
        const toolResults = await this.executeToolCalls([...this.toolCalls(response)], signal);
        this.throwIfAborted(signal);
        if (toolResults.length === 0) return;
        this.appendToolResults(toolResults);
      }
    } catch (error) {
      if (signal?.aborted && !interruptionRecorded) {
        interruptionRecorded = true;
        this.conversation.append({ type: "turn_interrupted" });
        this.emit({ type: "turn_interrupted" });
      }
      throw error;
    } finally {
      this.emit({ type: "turn_end" });
    }
  }
}
