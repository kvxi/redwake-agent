import { describe, expect, test } from "bun:test";
import { modelFor, type Provider } from "../source/config.ts";
import {
  createAgentFactory,
  type ProviderAgentOptions,
} from "../source/agent/factory.ts";
import { createToolContext } from "../source/tools/context.ts";
import { ConversationState } from "../source/session/conversation-state.ts";

describe("createAgentFactory", () => {
  test("shares the tool context while resolving a model per provider", () => {
    const ctx = createToolContext();
    const conversation = new ConversationState();
    const received: Array<{ provider: Provider; options: ProviderAgentOptions }> = [];
    const factory = createAgentFactory({ ctx, conversation }, (provider, options) => {
      received.push({ provider, options });
      return { runTurn: async (_message: string) => {} };
    });

    factory("anthropic");
    factory("openai");

    expect(received).toHaveLength(2);
    expect(received.map((entry) => entry.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(received.every((entry) => entry.options.ctx === ctx)).toBe(true);
    expect(received.every((entry) => entry.options.conversation === conversation)).toBe(true);
    expect(received.map((entry) => entry.options.model)).toEqual([
      modelFor("anthropic"),
      modelFor("openai"),
    ]);
  });

  test("injects a stored API key only into its matching provider", () => {
    const received: ProviderAgentOptions[] = [];
    const factory = createAgentFactory({ apiKeyFor: (provider) => provider === "openai" ? "stored-key" : undefined }, (_provider, options) => {
      received.push(options);
      return { runTurn: async () => {} };
    });
    factory("anthropic");
    factory("openai");
    expect(received.map((options) => options.apiKey)).toEqual([undefined, "stored-key"]);
  });
});
