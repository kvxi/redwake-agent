import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import type { FunctionTool as OpenAIFunctionTool } from "openai/resources/responses/responses";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ToolError, type AnyTool, type ToolContext } from "./context.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { searchTool } from "./search.ts";
import { fetchTool } from "./fetch.ts";

/** The complete tool set, in the order presented to the model. */
export const tools: readonly AnyTool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  searchTool,
  fetchTool,
];

const toolsByName: Record<string, AnyTool> = Object.fromEntries(
  tools.map((tool) => [tool.name, tool]),
);

/** Anthropic tool schemas derived from each tool's Zod schema (single source of truth). */
export function toAnthropicTools(): AnthropicTool[] {
  return tools.map((tool) => {
    const jsonSchema = zodToJsonSchema(tool.schema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: jsonSchema as AnthropicTool.InputSchema,
    };
  });
}

/** OpenAI Responses function tools derived from each Zod schema. */
export function toOpenAITools(): OpenAIFunctionTool[] {
  return tools.map((tool) => {
    const parameters = zodToJsonSchema(tool.schema, {
      $refStrategy: "none",
    }) as Record<string, unknown>;
    delete parameters.$schema;
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters,
      // Existing schemas expose optional/defaulted fields, which strict mode
      // rejects. runTool remains the authoritative input validator.
      strict: false,
    };
  });
}

/** Validate raw model input against the tool's schema, then run the handler. */
export function runTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<unknown> | unknown {
  const tool = toolsByName[name];
  if (!tool) {
    throw new ToolError(`Unknown tool name: ${name}`);
  }
  const handler = tool.handler as (
    input: unknown,
    ctx: ToolContext,
  ) => Promise<unknown> | unknown;
  return handler(tool.schema.parse(rawInput), ctx);
}
