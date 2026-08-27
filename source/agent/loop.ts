import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { MAX_TOKENS, MODEL } from "../config.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { runTool, toAnthropicTools } from "../tools/registry.ts";
import { createToolContext, type ToolContext } from "../tools/context.ts";

/** Minimal REPL-facing surface, so the CLI can be driven with a fake agent. */
export interface Conversation {
  runTurn(messages: MessageParam[]): Promise<Message>;
}

export interface AgentOptions {
  client?: Anthropic;
  ctx?: ToolContext;
  print?: (text: string) => void;
}

export function textFromMessage(message: Message): string {
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export class Agent implements Conversation {
  private readonly client: Anthropic;
  private readonly ctx: ToolContext;
  private readonly print: (text: string) => void;
  private readonly anthropicTools = toAnthropicTools();

  constructor(options: AgentOptions = {}) {
    this.client = options.client ?? new Anthropic();
    this.ctx = options.ctx ?? createToolContext();
    this.print = options.print ?? ((text) => console.log(text));
  }

  createMessage(messages: MessageParam[], system?: string): Promise<Message> {
    return this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages,
      system: system ?? buildSystemPrompt(),
      tools: this.anthropicTools,
    });
  }

  async runTools(message: Message): Promise<ToolResultBlockParam[]> {
    const results: ToolResultBlockParam[] = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      try {
        const output = await runTool(block.name, block.input, this.ctx);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(output),
          is_error: false,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: detail }),
          is_error: true,
        });
      }
    }
    return results;
  }

  async runTurn(messages: MessageParam[]): Promise<Message> {
    while (true) {
      const response = await this.createMessage(messages);
      messages.push({ role: "assistant", content: response.content });

      const text = textFromMessage(response);
      if (text) this.print(text);

      if (response.stop_reason !== "tool_use") return response;

      messages.push({ role: "user", content: await this.runTools(response) });
    }
  }
}
