import { describe, expect, mock, test } from "bun:test";
import type { Provider } from "../source/config.ts";
import type { Conversation } from "../source/agent/conversation.ts";
import { runRepl } from "../source/main.ts";
import { NEW_SESSION } from "../source/session/sessions-ui.ts";

function fakeIO(inputs: Array<string | null>) {
  let index = 0;
  const writes: string[] = [];
  const question = mock(async (_request: { kind: "message" | "choice"; label: string; initialText?: string }) => inputs[index++] ?? null);
  return {
    io: {
      readLine: question,
      append: (message: { text: string }) => writes.push(`${message.text}\n`),
      close: () => {},
    },
    writes,
    question,
  };
}

function fakeRuntime(agents: Partial<Record<Provider, Conversation>>) {
  const createAgent = mock((selection: Provider | { provider: Provider; model: string }) => {
    const provider = typeof selection === "string" ? selection : selection.provider;
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
  test("onboards a fresh install by selecting a provider and requesting its API key", async () => {
    const openai = { runTurn: mock(async (_message: string) => {}) };
    const createAgent = mock(() => openai);
    const saved: Partial<Record<Provider, string>> = {};
    const saveModelSelection = mock((_provider: Provider, _model: string) => {});
    const { io, question, writes } = fakeIO(["openai", "sk-test", "hello", ""]);

    await runRepl({
      provider: "anthropic",
      createAgent,
      modelFor: (provider) => provider === "openai" ? "gpt-test" : "claude-test",
      onboarding: true,
      saveModelSelection,
      getApiKey: (provider) => saved[provider],
      saveApiKey: (provider, key) => { saved[provider] = key; },
    }, io);

    expect(saveModelSelection).toHaveBeenCalledWith("openai", "gpt-test");
    expect(saved.openai).toBe("sk-test");
    expect(question.mock.calls[1]?.[0]).toMatchObject({ label: "OpenAI API key:", secret: true });
    expect(createAgent).toHaveBeenCalledWith({ provider: "openai", model: "gpt-test" });
    expect(openai.runTurn).toHaveBeenCalledWith("hello");
    expect(writes).toContain("Logged in to openai with an API key.\n");
  });

  test("onboards ChatGPT subscriptions with the Codex default and model-selection prompt", async () => {
    const login = mock(async () => ({ accountId: "workspace", identity: "user@example.com", expiresAt: Date.now() + 1000 }));
    const saveModelSelection = mock((_provider: Provider, _model: string) => {});
    const { io, writes } = fakeIO(["openai-codex", ""]);
    await runRepl({
      provider: "anthropic",
      createAgent: mock(() => ({ runTurn: async () => {} })),
      modelFor: (provider) => provider === "openai-codex" ? "gpt-5.6-terra" : "claude-test",
      onboarding: true,
      saveModelSelection,
      auth: { login } as never,
    }, io);
    expect(login).toHaveBeenCalledTimes(1);
    expect(saveModelSelection).toHaveBeenCalledWith("openai-codex", "gpt-5.6-terra");
    expect(writes).toContain("OpenAI Codex defaults to gpt-5.6-terra. Run /model openai-codex to choose another available model.\n");
  });

  test("accepts the prompted /model openai-codex command", async () => {
    const anthropic = { runTurn: mock(async (_message: string) => {}) };
    const codex = { runTurn: mock(async (_message: string) => {}) };
    const createAgent = mock((selection: Provider | { provider: Provider; model: string }) => {
      const selected = typeof selection === "string" ? selection : selection.provider;
      return selected === "openai-codex" ? codex : anthropic;
    });
    const { io, question } = fakeIO(["/model openai-codex", "gpt-5.6-terra", ""]);
    await runRepl({
      provider: "anthropic",
      createAgent,
      modelFor: (provider) => provider === "openai-codex" ? "gpt-5.6-terra" : "claude-test",
      auth: { status: async () => [{ disabled: false }] } as never,
      discoverCodexModels: async () => [{ provider: "openai-codex", id: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" }],
    }, io);

    expect(question.mock.calls[1]?.[0].label).toContain("Model [gpt-5.6-terra]");
    expect(createAgent).toHaveBeenLastCalledWith({ provider: "openai-codex", model: "gpt-5.6-terra" });
  });

  test("switches providers without sending the command to either model", async () => {
    const anthropic = { runTurn: mock(async (_message: string) => {}) };
    const openai = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({ anthropic, openai });
    const { io, writes } = fakeIO(["/model", "openai", "explain this", ""]);

    await runRepl(options, io);

    expect(createAgent.mock.calls).toEqual([
      [{ provider: "anthropic", model: "claude-opus-5" }],
      [{ provider: "openai", model: "gpt-5.6" }],
    ]);
    expect(anthropic.runTurn).not.toHaveBeenCalled();
    expect(openai.runTurn).toHaveBeenCalledWith("explain this");
    expect(writes).toEqual([
      "Switched to openai using gpt-5.6. Conversation retained.\n",
    ]);
  });

  test("shows the active model and session details without calling the model", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({ anthropic: agent });
    const entries = mock(() => [
      { index: 0, event: { type: "user" as const, content: "hello" }, recordId: 0 },
      { index: 1, event: { type: "assistant" as const, content: "hi" }, recordId: 1 },
    ]);
    const list = mock(() => [{
      path: "/tmp/session-7.jsonl",
      name: "session-7.jsonl",
      number: 7,
      eventCount: 2,
      active: true,
    }]);
    const { io, writes } = fakeIO(["/status", ""]);

    await runRepl({
      ...options,
      initialModel: "claude-restored",
      conversation: { entries, branchTo: () => true },
      sessions: { list, activate: () => ({ status: "already-active", eventCount: 2 }) },
    }, io);

    expect(agent.runTurn).not.toHaveBeenCalled();
    expect(writes).toContain(
      "Active model: claude-restored (anthropic)\nSession: session-7.jsonl\nSession events: 2\n",
    );
  });

  test("uses a restored model when constructing the startup agent", async () => {
    const anthropic = { runTurn: mock(async (_message: string) => {}) };
    const { options, createAgent } = fakeRuntime({ anthropic });
    const { io } = fakeIO([""]);

    await runRepl({ ...options, initialModel: "claude-restored" }, io);

    expect(createAgent).toHaveBeenCalledWith({
      provider: "anthropic",
      model: "claude-restored",
    });
  });

  test("persists a successful model selection", async () => {
    const anthropic = { runTurn: mock(async (_message: string) => {}) };
    const openai = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({ anthropic, openai });
    const saveModelSelection = mock((_provider: Provider, _model: string) => {});
    const { io } = fakeIO(["/model", "openai", ""]);

    await runRepl({ ...options, saveModelSelection }, io);

    expect(saveModelSelection).toHaveBeenCalledWith("openai", "gpt-5.6");
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
      "Model selection canceled.\n",
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
      "Invalid provider. Choose anthropic or openai or openai-codex.\n",
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
      "Unknown command: /help. Available commands: /model, /tree, /sessions, /login, /logout, /status\n",
    ]);
  });

  test("Ctrl-C aborts an in-progress login and exits the REPL", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({ anthropic: agent });
    const { io } = fakeIO(["/login openai-codex"]);
    let loginSignal: AbortSignal | undefined;
    const login = mock(async (_device?: boolean, _notify?: (message: string) => void, signal?: AbortSignal) => {
      loginSignal = signal;
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(Object.assign(new Error("Authentication canceled."), { name: "AbortError" })), { once: true });
      });
      throw new Error("unreachable");
    });

    await runRepl({ ...options, auth: { login } as never }, {
      ...io,
      setInterruptHandler: (handler) => { if (handler) queueMicrotask(handler); },
    });

    expect(login).toHaveBeenCalledTimes(1);
    expect(loginSignal?.aborted).toBe(true);
    expect(agent.runTurn).not.toHaveBeenCalled();
  });

  test("continues a selected session locally and rebuilds before the next message", async () => {
    const first = { runTurn: mock(async (_message: string) => {}) };
    const second = { runTurn: mock(async (_message: string) => {}) };
    let created = 0;
    const createAgent = mock((_selection: Provider | { provider: Provider; model: string }) => created++ === 0 ? first : second);
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
    const selectedEntries = [
      { index: 0, recordId: 0, event: { type: "user" as const, content: "old" } },
      { index: 1, recordId: 1, event: { type: "assistant" as const, content: "answer" } },
      { index: 2, recordId: 2, event: { type: "user" as const, content: "follow-up" } },
      { index: 3, recordId: 3, event: { type: "assistant" as const, content: "more" } },
    ];
    const entries = mock(() => selectedEntries);
    const setConversation = mock((_entries: typeof selectedEntries) => {});

    await runRepl({
      provider: "anthropic",
      createAgent,
      modelFor: () => "claude-opus-5",
      conversation: { entries, branchTo: () => true },
      sessions: { list, activate },
    }, { ...io, showSessions, setConversation });

    expect(first.runTurn).not.toHaveBeenCalled();
    expect(second.runTurn).toHaveBeenCalledWith("continue");
    expect(activate).toHaveBeenCalledWith("/tmp/session-1.jsonl");
    expect(setConversation).toHaveBeenCalledWith(selectedEntries);
    expect(createAgent).toHaveBeenCalledTimes(2);
    expect(writes).toContain("Continued session-1.jsonl (4 events).\n");
  });

  test("starts a new session from the sessions list", async () => {
    const first = { runTurn: mock(async (_message: string) => {}) };
    const second = { runTurn: mock(async (_message: string) => {}) };
    let createdAgents = 0;
    const createAgent = mock(() => createdAgents++ === 0 ? first : second);
    const create = mock(() => ({ path: "/tmp/session-2.jsonl", name: "session-2.jsonl", number: 2, eventCount: 0 as const }));
    const entries = mock(() => []);
    const setConversation = mock((_entries: readonly never[]) => {});
    const { io, writes } = fakeIO(["/sessions", "hello", ""]);

    await runRepl({
      provider: "anthropic",
      createAgent,
      modelFor: () => "claude-opus-5",
      conversation: { entries, branchTo: () => true },
      sessions: {
        list: () => [{ path: "/tmp/session-1.jsonl", name: "session-1.jsonl", number: 1, eventCount: 2, active: true }],
        activate: () => ({ status: "switched", eventCount: 0 }),
        create,
      },
    }, { ...io, showSessions: async () => NEW_SESSION, setConversation });

    expect(create).toHaveBeenCalledTimes(1);
    expect(setConversation).toHaveBeenCalledWith([]);
    expect(second.runTurn).toHaveBeenCalledWith("hello");
    expect(writes).toContain("Started new session session-2.jsonl.\n");
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
  test("uses structured message requests without presentation ANSI", async () => {
    const agent = { runTurn: mock(async (_message: string) => {}) };
    const { options } = fakeRuntime({
      anthropic: agent,
      openai: { runTurn: mock(async (_message: string) => {}) },
    });
    const { io, question, writes } = fakeIO(["message", ""]);

    await runRepl(options, io);

    expect(question.mock.calls).toEqual([
      [{ kind: "message", label: ">" }],
      [{ kind: "message", label: ">" }],
    ]);
  });
});
