import { describe, expect, mock, test } from "bun:test";
import type OpenAI from "openai";
import type {
  Response,
  ResponseInput,
} from "openai/resources/responses/responses";
import { OpenAIAgent } from "../source/agent/openai.ts";
import { MAX_TOKENS, MODEL } from "../source/config.ts";
import { createToolContext } from "../source/tools/context.ts";

function fakeResponse(partial: Partial<Response>): Response {
  return {
    id: "resp_1",
    object: "response",
    created_at: 0,
    model: MODEL,
    output: [],
    output_text: "",
    ...partial,
  } as unknown as Response;
}

function fakeClient(responses: Response[]) {
  const create = mock(async (_params: unknown) => responses.shift());
  const client = { responses: { create } } as unknown as OpenAI;
  return { client, create };
}

describe("OpenAIAgent.createResponse", () => {
  test("supplies the selected model, system prompt, output limit, and tool schemas", async () => {
    const { client, create } = fakeClient([fakeResponse({})]);
    const model = "gpt-test";
    const agent = new OpenAIAgent({ client, model });

    await agent.createResponse();

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0] as {
      model: string;
      max_output_tokens: number;
      instructions: string;
      tools: Array<{ name: string; type: string; strict: boolean }>;
    };
    expect(request.model).toBe(model);
    expect(request.max_output_tokens).toBe(MAX_TOKENS);
    expect(request.instructions.length).toBeGreaterThan(0);
    expect(request.tools.map((tool) => tool.name).sort()).toEqual([
      "bash",
      "edit",
      "fetch",
      "read",
      "search",
      "write",
    ]);
    expect(request.tools.every((tool) => tool.type === "function")).toBe(true);
    expect(request.tools.every((tool) => tool.strict === false)).toBe(true);
  });
});

describe("OpenAIAgent.runTurn", () => {
  test("returns function outputs to the Responses API and preserves output history", async () => {
    const functionCall = {
      type: "function_call" as const,
      id: "fc_1",
      call_id: "call_1",
      name: "bash",
      arguments: JSON.stringify({ command: "echo hi" }),
      status: "completed" as const,
    };
    const { client, create } = fakeClient([
      fakeResponse({ output: [functionCall] }),
      fakeResponse({ output_text: "done" }),
    ]);
    const printed: string[] = [];
    const agent = new OpenAIAgent({
      client,
      ctx: createToolContext(),
      print: (text) => printed.push(text),
    });

    await agent.runTurn("go");

    expect(create).toHaveBeenCalledTimes(2);
    expect(printed).toEqual(["done"]);
    const secondRequest = create.mock.calls[1]![0] as { input: ResponseInput };
    expect(secondRequest.input).toHaveLength(3);
    expect(secondRequest.input[0]).toEqual({ role: "user", content: "go" });
    expect(secondRequest.input[1]).toMatchObject(functionCall);
    expect(secondRequest.input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: JSON.stringify({ stdout: "hi\n", stderr: "", exit_code: 0 }),
    });
  });

  test("returns tool failures as function outputs", async () => {
    const functionCall = {
      type: "function_call" as const,
      id: "fc_2",
      call_id: "call_2",
      name: "missing",
      arguments: "{}",
      status: "completed" as const,
    };
    const agent = new OpenAIAgent({ client: fakeClient([]).client });

    const results = await agent.runTools(fakeResponse({ output: [functionCall] }));

    expect(results).toEqual([
      {
        type: "function_call_output",
        call_id: "call_2",
        output: JSON.stringify({ error: "Unknown tool name: missing" }),
      },
    ]);
  });
});
