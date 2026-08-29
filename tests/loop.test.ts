import { describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicAgent, textFromMessage } from "../source/agent/anthropic.ts";
import { buildSystemPrompt } from "../source/agent/system-prompt.ts";
import {
  toAnthropicTools,
  toOpenAITools,
} from "../source/tools/registry.ts";
import { createToolContext } from "../source/tools/context.ts";
import { runRepl } from "../source/main.ts";
import { MAX_TOKENS, MODEL } from "../source/config.ts";

const TOOL_NAMES = ["bash", "edit", "fetch", "read", "search", "write"];

function fakeMessage(partial: Partial<Message>): Message {
  return {
    id: "msg",
    type: "message",
    role: "assistant",
    model: MODEL,
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
    content: [],
    ...partial,
  } as unknown as Message;
}

function fakeClient(responses: Message[]) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const create = mock(async (params: Anthropic.MessageCreateParams) => {
    calls.push(structuredClone(params));
    return responses.shift();
  });
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create, calls };
}

describe("registry", () => {
  test("derives Anthropic and OpenAI schemas from the same tools", () => {
    const anthropicSchemas = toAnthropicTools();
    expect(anthropicSchemas.map((s) => s.name).sort()).toEqual(TOOL_NAMES);
    const fetchSchema = anthropicSchemas.find((s) => s.name === "fetch");
    const properties = fetchSchema?.input_schema.properties as Record<
      string,
      { minimum?: number }
    >;
    expect(properties.offset?.minimum).toBe(0);

    const openAISchemas = toOpenAITools();
    expect(openAISchemas.map((s) => s.name).sort()).toEqual(TOOL_NAMES);
    expect(openAISchemas.every((schema) => schema.type === "function")).toBe(true);
    expect(openAISchemas.every((schema) => schema.strict === false)).toBe(true);
    expect(openAISchemas.find((schema) => schema.name === "fetch")?.parameters).toEqual(
      fetchSchema?.input_schema,
    );
  });
});

describe("AnthropicAgent.createMessage", () => {
  test("always supplies tool schemas, system, model and max_tokens", async () => {
    const { client, create } = fakeClient([fakeMessage({})]);
    const model = "claude-test";
    const agent = new AnthropicAgent({ client, model });
    await agent.createMessage();

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect((arg.tools ?? []).map((tool) => tool.name).sort()).toEqual(TOOL_NAMES);
    expect(typeof arg.system).toBe("string");
    expect((arg.system as string)).toContain(`Current working directory: ${process.cwd()}`);
    expect(arg.model).toBe(model);
    expect(arg.max_tokens).toBe(MAX_TOKENS);
  });
});

describe("buildSystemPrompt", () => {
  test("substitutes context placeholders and lists tools", () => {
    const prompt = buildSystemPrompt({ cwd: process.cwd() });
    expect(prompt).not.toContain("{cwd}");
    expect(prompt).not.toContain("{current_date}");
    expect(prompt).not.toContain("{custom_system.md}");
    expect(prompt).toContain(process.cwd());
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read:");
  });
});

describe("AnthropicAgent.runTurn", () => {
  test("records and prints a final response", async () => {
    const { client, create, calls } = fakeClient([
      fakeMessage({
        content: [{ type: "text", text: "Completed" }],
        stop_reason: "end_turn",
      }) as Message,
    ]);
    const printed: string[] = [];
    const agent = new AnthropicAgent({ client, print: (text) => printed.push(text) });

    await agent.runTurn("hi");

    expect(create).toHaveBeenCalledTimes(1);
    expect(printed).toEqual(["Completed"]);
    const request = calls[0]!;
    expect(request.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("continues after tool_use and appends tool results", async () => {
    const toolUse = fakeMessage({
      content: [
        { type: "tool_use", id: "t1", name: "bash", input: { command: "echo hi" } },
      ],
      stop_reason: "tool_use",
    });
    const final = fakeMessage({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
    });
    const { client, create, calls } = fakeClient([toolUse, final]);
    const agent = new AnthropicAgent({
      client,
      ctx: createToolContext(),
      print: () => {},
    });

    await agent.runTurn("go");

    expect(create).toHaveBeenCalledTimes(2);
    const secondRequest = calls[1]!;
    const messages = secondRequest.messages as MessageParam[];
    expect(messages).toHaveLength(3); // user, assistant(tool_use), user(tool_result)
    const toolResults = messages[2]!.content as Array<{
      type: string;
      is_error: boolean;
      content: string;
    }>;
    expect(toolResults[0]!.type).toBe("tool_result");
    expect(toolResults[0]!.is_error).toBe(false);
    expect(JSON.parse(toolResults[0]!.content).stdout).toBe("hi\n");
  });
});

describe("AnthropicAgent.runTools", () => {
  test("serializes successes and errors independently", async () => {
    const message = fakeMessage({
      content: [
        { type: "tool_use", id: "a", name: "bash", input: { command: "echo hi" } },
        { type: "tool_use", id: "b", name: "nope", input: {} },
      ],
    });
    const agent = new AnthropicAgent({ client: fakeClient([]).client });

    const results = await agent.runTools(message);

    expect(results).toHaveLength(2);
    expect(results[0]!.is_error).toBe(false);
    expect(JSON.parse(results[0]!.content as string).stdout).toBe("hi\n");
    expect(results[1]!.is_error).toBe(true);
    expect(JSON.parse(results[1]!.content as string).error).toContain(
      "Unknown tool name",
    );
  });
});

describe("textFromMessage", () => {
  test("joins text blocks and ignores tool_use", () => {
    const message = fakeMessage({
      content: [
        { type: "text", text: "a" },
        { type: "tool_use", id: "x", name: "bash", input: {} },
        { type: "text", text: "b" },
      ],
    });
    expect(textFromMessage(message)).toBe("a\nb");
  });
});

