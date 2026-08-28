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

function fakeRuntime(agents: Partial<Record<Provider, Conversation>>) {
  const createAgent = mock((provider: Provider) => {
    const agent = agents[provider];
    if (!agent) throw new Error(`Missing fake agent for ${provider}`);
    return agent;
  });
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
      "\x1b[0m",
      "\x1b[0m",
      "Switched to openai using gpt-5.6. Conversation retained.\n",
      "\x1b[0m",
      "\x1b[0m",
    ]);
  });

  test("treats selecting the active provider as a no-op", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, writes } = fakeIO(["/model", "anthropic", "continue", ""]);
    await runRepl(options, io);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).toHaveBeenCalledWith("continue");
    expect(writes).toContain(
      "Already using anthropic with claude-opus-5. Conversation retained.\n",
    );
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
    expect(writes).toEqual([
      "\x1b[0m",
      "\x1b[0m",
      "Model selection canceled.\n",
      "\x1b[0m",
      "\x1b[0m",
    ]);
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
    expect(writes).toEqual([
      "\x1b[0m",
      "\x1b[0m",
      "Invalid provider. Choose anthropic or openai or openai-codex.\n",
      "\x1b[0m",
    ]);
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
      "\x1b[0m",
      "Unknown command: /help. Available commands: /model, /tree, /login, /logout, /status\n",
      "\x1b[0m",
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

describe("runRepl prompts", () => {
  test("colors and bolds input until the line is submitted", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, question, writes } = fakeIO(["message", ""]);

    await runRepl(options, io);

    expect(question.mock.calls).toEqual([
      ["\x1b[1;36m> "],
      ["\x1b[1;36m> "],
    ]);
    expect(writes).toEqual(["\x1b[0m", "\x1b[0m"]);
  });
});
