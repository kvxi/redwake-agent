import { modelFor, type Provider } from "../config.ts";
import { AnthropicAgent } from "./anthropic.ts";
import { type AgentBaseOptions } from "./base.ts";
import type { Conversation } from "./conversation.ts";
import { OpenAIAgent } from "./openai.ts";

export type ProviderAgentOptions = AgentBaseOptions & { model: string };
export type CreateAgent = (
  provider: Provider,
  options: ProviderAgentOptions,
) => Conversation;
export type ProviderAgentFactory = (provider: Provider) => Conversation;

/** Construct an agent with the selected provider's native protocol. */
export function createAgent(
  provider: Provider,
  options: ProviderAgentOptions,
): Conversation {
  if (provider === "openai") return new OpenAIAgent(options);
  return new AnthropicAgent(options);
}

/** Build agents that share runtime state while retaining provider-local history. */
export function createAgentFactory(
  options: AgentBaseOptions,
  construct: CreateAgent = createAgent,
): ProviderAgentFactory {
  return (provider) => construct(provider, { ...options, model: modelFor(provider) });
}
