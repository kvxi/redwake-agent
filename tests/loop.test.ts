import { describe, expect, mock, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message, MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { Agent, textFromMessage } from "../source/agent/loop.ts";
import { buildSystemPrompt } from "../source/agent/system-prompt.ts";
import { toAnthropicTools } from "../source/tools/registry.ts";
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
  const create = mock(async (_params: Anthropic.MessageCreateParams) =>
    responses.shift(),
  );
  const client = { messages: { create } } as unknown as Anthropic;
  return { client, create };
}
describe("registry", () => {
  test("exposes exactly the six tools with generated schemas", () => {
    const schemas = toAnthropicTools();
    expect(schemas.map((s) => s.name).sort()).toEqual(TOOL_NAMES);
    const fetchSchema = schemas.find((s) => s.name === "fetch");
    const properties = fetchSchema?.input_schema.properties as Record<
      string,
      { minimum?: number }
    >;
    expect(properties.offset?.minimum).toBe(0);
  });
});

describe("createMessage", () => {
  test("always supplies tool schemas, system, model and max_tokens", async () => {
    const { client, create } = fakeClient([fakeMessage({})]);
    const agent = new Agent({ client });
    await agent.createMessage([{ role: "user", content: "hi" }]);

    expect(create).toHaveBeenCalledTimes(1);
    const arg = create.mock.calls[0]![0] as Anthropic.MessageCreateParams;
    expect((arg.tools ?? []).map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect(typeof arg.system).toBe("string");
    expect((arg.system as string).length).toBeGreaterThan(0);
    expect(arg.model).toBe(MODEL);
    expect(arg.max_tokens).toBe(MAX_TOKENS);
  });
});

describe("buildSystemPrompt", () => {
  test("substitutes context placeholders and lists tools", () => {
    const prompt = buildSystemPrompt();
    expect(prompt).not.toContain("{cwd}");
    expect(prompt).not.toContain("{current_date}");
    expect(prompt).not.toContain("{custom_system.md}");
    expect(prompt).toContain(process.cwd());
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read:");
  });
});

describe("runTurn", () => {
  test("records and prints a final response", async () => {
    const { client, create } = fakeClient([
      fakeMessage({
        content: [{ type: "text", text: "Completed" }],
        stop_reason: "end_turn",
      }) as Message,
    ]);
    const printed: string[] = [];
    const agent = new Agent({ client, print: (t) => printed.push(t) });
    const messages: MessageParam[] = [{ role: "user", content: "hi" }];

    const response = await agent.runTurn(messages);

    expect(create).toHaveBeenCalledTimes(1);
    expect(response.stop_reason).toBe("end_turn");
    expect(printed).toEqual(["Completed"]);
    expect(messages).toHaveLength(2);
    expect(messages[1]!.role).toBe("assistant");
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
    const { client, create } = fakeClient([toolUse, final]);
    const agent = new Agent({ client, ctx: createToolContext(), print: () => {} });
    const messages: MessageParam[] = [{ role: "user", content: "go" }];

    await agent.runTurn(messages);

    expect(create).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(4); // user, assistant(tool_use), user(tool_result), assistant
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

describe("runTools", () => {
  test("serializes successes and errors independently", async () => {
    const message = fakeMessage({
      content: [
        { type: "tool_use", id: "a", name: "bash", input: { command: "echo hi" } },
        { type: "tool_use", id: "b", name: "nope", input: {} },
      ],
    });
    const agent = new Agent({ client: fakeClient([]).client });

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

describe("runRepl", () => {
  test("exits without a model call on a blank line", async () => {
    let turns = 0;
    const agent = { runTurn: async () => fakeMessage({}) };
    const runTurn = mock(agent.runTurn);
    const io = { question: mock(async () => ""), close: mock(() => {}) };

    await runRepl({ runTurn }, io);

    expect(runTurn).not.toHaveBeenCalled();
    expect(io.close).toHaveBeenCalledTimes(1);
    void turns;
  });

  test("exits without a model call on end-of-input", async () => {
    const runTurn = mock(async () => fakeMessage({}));
    const io = { question: mock(async () => null), close: mock(() => {}) };

    await runRepl({ runTurn }, io);

    expect(runTurn).not.toHaveBeenCalled();
  });

  test("runs a turn per non-empty line until blank", async () => {
    let n = 0;
    const runTurn = mock(async () => fakeMessage({}));
    const io = {
      question: mock(async () => (n++ === 0 ? "hi" : "")),
      close: mock(() => {}),
    };

    await runRepl({ runTurn }, io);

    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});
