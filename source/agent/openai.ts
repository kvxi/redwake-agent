import OpenAI from "openai";
import type {
  Response,
  ResponseInput,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { MAX_TOKENS, MODEL } from "../config.ts";
import { toOpenAITools } from "../tools/registry.ts";
import {
  AgentBase,
  type AgentBaseOptions,
  type NormalizedToolCall,
} from "./base.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { toOpenAIHistory } from "./history.ts";

export interface OpenAIAgentOptions extends AgentBaseOptions {
  client?: OpenAI;
  model?: string;
}

/** Runs an interactive conversation through the OpenAI Responses API. */
export class OpenAIAgent extends AgentBase<
  Response,
  ResponseInputItem.FunctionCallOutput
> {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly openAITools = toOpenAITools();
  private readonly input: ResponseInput;

  constructor(options: OpenAIAgentOptions = {}) {
    super(options);
    this.client = options.client ?? new OpenAI();
    this.model = options.model ?? MODEL;
    // Roughly 300k tokens, leaving room for system, tools, and output.
    this.input = toOpenAIHistory(this.conversation.snapshot(1_200_000));
  }

  createResponse(system?: string): Promise<Response> {
    return this.client.responses.create({
      model: this.model,
      max_output_tokens: MAX_TOKENS,
      input: this.input,
      instructions: system ?? buildSystemPrompt({ cwd: process.cwd() }),
      tools: this.openAITools,
    });
  }

  protected appendUser(userMessage: string): void {
    this.input.push({ role: "user", content: userMessage });
  }

  protected request(): Promise<Response> {
    return this.createResponse();
  }

  protected remember(response: Response): void {
    // Responses requires prior output items in the next input. The SDK's
    // output union is wider than ResponseInput despite that API contract.
    this.input.push(...(response.output as unknown as ResponseInput));
  }

  protected responseText(response: Response): string {
    return response.output_text;
  }

  protected *toolCalls(response: Response): Iterable<NormalizedToolCall> {
    for (const item of response.output) {
      if (item.type !== "function_call") continue;
      try {
        yield { id: item.call_id, name: item.name, input: JSON.parse(item.arguments) };
      } catch (error) {
        yield {
          id: item.call_id,
          name: item.name,
          input: item.arguments,
          inputError: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  protected encodeToolResult(
    call: NormalizedToolCall,
    content: string,
    _isError: boolean,
  ): ResponseInputItem.FunctionCallOutput {
    return {
      type: "function_call_output",
      call_id: call.id,
      output: content,
    };
  }

  protected appendToolResults(
    results: ResponseInputItem.FunctionCallOutput[],
  ): void {
    this.input.push(...results);
  }

  async runTools(
    response: Response,
  ): Promise<ResponseInputItem.FunctionCallOutput[]> {
    return this.executeToolCalls(this.toolCalls(response));
  }
}
