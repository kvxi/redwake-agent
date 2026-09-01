import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { MAX_TOKENS, MODEL } from "../config.ts";
import { toAnthropicTools } from "../tools/registry.ts";
import {
  AgentBase,
  type AgentBaseOptions,
  type NormalizedToolCall,
} from "./base.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { toAnthropicHistory } from "./history.ts";

export interface AnthropicAgentOptions extends AgentBaseOptions {
  client?: Anthropic;
  model?: string;
}

export function textFromMessage(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export class AnthropicAgent extends AgentBase<Message, ToolResultBlockParam> {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly anthropicTools = toAnthropicTools();
  private readonly messages: MessageParam[];

  constructor(options: AnthropicAgentOptions = {}) {
    super(options);
    this.client = options.client ?? new Anthropic();
    this.model = options.model ?? MODEL;
    // Roughly 150k tokens, leaving room for system, tools, and output.
    this.messages = toAnthropicHistory(this.conversation.snapshot(600_000));
  }

  private messageParams(system?: string): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: MAX_TOKENS,
      messages: this.messages,
      system: system ?? buildSystemPrompt({ cwd: this.workspaceRoot }),
      tools: this.anthropicTools,
    };
  }

  createMessage(system?: string): Promise<Message> {
    return this.client.messages.create(this.messageParams(system));
  }

  protected appendUser(userMessage: string): void {
    this.messages.push({ role: "user", content: userMessage });
  }

  protected request(): Promise<Message> {
    // Keep compatibility with lightweight clients that implement only create().
    if (typeof this.client.messages.stream !== "function") return this.createMessage();
    const stream = this.client.messages.stream(this.messageParams());
    stream.on("text", (delta) => this.emitTextDelta(delta));
    return stream.finalMessage();
  }

  protected remember(message: Message): void {
    this.messages.push({ role: "assistant", content: message.content });
  }

  protected responseText(message: Message): string {
    return textFromMessage(message);
  }

  protected *toolCalls(message: Message): Iterable<NormalizedToolCall> {
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      yield {
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
  }

  protected encodeToolResult(
    call: NormalizedToolCall,
    content: string,
    isError: boolean,
  ): ToolResultBlockParam {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content,
      is_error: isError,
    };
  }

  protected appendToolResults(results: ToolResultBlockParam[]): void {
    this.messages.push({ role: "user", content: results });
  }

  async runTools(message: Message): Promise<ToolResultBlockParam[]> {
    return this.executeToolCalls(this.toolCalls(message));
  }
}
