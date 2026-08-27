import { describe, expect, mock, test } from "bun:test";
import type { Provider } from "../source/config.ts";
import type { Conversation } from "../source/agent/conversation.ts";
import { runRepl } from "../source/main.ts";

function fakeIO(inputs: Array<string | null>) {
  let index = 0;
  const writes: string[] = [];
  const question = mock(async (_prompt: string) => inputs[index++] ?? null);
  return {
    io: {
      question,
      write: (text: string) => writes.push(text),
      close: () => {},
    },
    writes,
    question,
  };
}

function fakeRuntime(agents: Record<Provider, Conversation>) {
  const createAgent = mock((provider: Provider) => agents[provider]);
  return {
    options: {
      provider: "anthropic" as const,
      createAgent,
      modelFor: (provider: Provider) =>
        provider === "openai" ? "gpt-5.6" : "claude-opus-5",
    },
    createAgent,
  };
}

describe("runRepl slash commands", () => {
  test("switches providers without sending the command to either model", async () => {
    const anthropic = { runTurn: mock(async (_message: string) => {}) };
    const openai = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({ anthropic, openai });
    const { io, writes } = fakeIO(["/model", "openai", "explain this", ""]);

    await runRepl(options, io);

    expect(createAgent.mock.calls).toEqual([["anthropic"], ["openai"]]);
    expect(anthropic.runTurn).not.toHaveBeenCalled();
    expect(openai.runTurn).toHaveBeenCalledWith("explain this");
    expect(writes).toEqual([
      "Switched to openai using gpt-5.6. Conversation context reset.\n",
    ]);
  });

  test("cancels model selection without exiting the REPL", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, writes } = fakeIO(["/model", "", "continue", ""]);

    await runRepl(options, io);

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).toHaveBeenCalledWith("continue");
    expect(writes).toEqual(["Model selection canceled.\n"]);
  });

  test("rejects invalid provider selections locally", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, writes } = fakeIO(["/model", "invalid", ""]);

    await runRepl(options, io);

    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(writes).toEqual(["Invalid provider. Choose anthropic or openai.\n"]);
  });

  test("rejects unknown slash commands without sending them to a model", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, writes } = fakeIO(["/help", ""]);

    await runRepl(options, io);

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(writes).toEqual([
      "Unknown command: /help. Available commands: /model\n",
    ]);
  });

  test("exits without a model call on blank input", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io } = fakeIO([""]);

    await runRepl(options, io);

    expect(agent.runTurn).not.toHaveBeenCalled();
  });
});
