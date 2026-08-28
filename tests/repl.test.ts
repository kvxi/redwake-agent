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
      "Unknown command: /help. Available commands: /model, /tree, /sessions, /login, /logout, /status\n",
      "\x1b[0m",
    ]);
  });

  test("continues a selected session locally and rebuilds before the next message", async () => {
    const first = { runTurn: mock(async (_message: string) => {}) };
    const second = { runTurn: mock(async (_message: string) => {}) };
    let created = 0;
    const createAgent = mock((_provider: Provider) => created++ === 0 ? first : second);
    const activate = mock((_path: string) => ({ status: "switched" as const, eventCount: 4 }));
    const list = mock(() => [{
      path: "/tmp/session-1.jsonl",
      name: "session-1.jsonl",
      number: 1,
      eventCount: 4,
      active: false,
      preview: { type: "user" as const, content: "old" },
    }]);
    const { io, writes } = fakeIO(["/sessions", "continue", ""]);
    const showSessions = mock(async () => "/tmp/session-1.jsonl");

    await runRepl({
      provider: "anthropic",
      createAgent,
      modelFor: () => "claude-opus-5",
      sessions: { list, activate },
    }, { ...io, showSessions });

    expect(first.runTurn).not.toHaveBeenCalled();
    expect(second.runTurn).toHaveBeenCalledWith("continue");
    expect(activate).toHaveBeenCalledWith("/tmp/session-1.jsonl");
    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(writes).toContain("Continued session-1.jsonl (4 events).\n");
  });

  test("cancels session selection without rebuilding or calling the model", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const activate = mock((_path: string) => ({ status: "switched" as const, eventCount: 0 }));
    const { io, writes } = fakeIO(["/sessions", ""]);
    await runRepl({
      ...options,
      sessions: {
        list: () => [{ path: "/tmp/session-1.jsonl", name: "session-1.jsonl", number: 1, eventCount: 0, active: true }],
        activate,
      },
    }, { ...io, showSessions: async () => null });
    expect(activate).not.toHaveBeenCalled();
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(writes).toContain("Session selection canceled.\n");
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
      ["\x1b[1;31m> "],
      ["\x1b[1;31m> "],
    ]);
    expect(writes).toEqual(["\x1b[0m", "\x1b[0m"]);
  });
});
