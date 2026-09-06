import type { CredentialManager } from "../auth/credential-manager.ts";
import { CodexTransport } from "../codex/transport.ts";
import { modelFor, type Provider } from "../config.ts";
import { AnthropicAgent } from "./anthropic.ts";
import type { AgentBaseOptions } from "./base.ts";
import type { Conversation } from "./conversation.ts";
import { CodexAgent } from "./codex.ts";
import { OpenAIAgent } from "./openai.ts";
import type { SessionPrompt } from "./session-prompt.ts";

export interface ProviderSelection { provider: Provider; model: string }
export type ProviderAgentOptions = AgentBaseOptions & {
  model: string;
  apiKey?: string;
  credentials?: CredentialManager;
  codexTransport?: CodexTransport;
};
export type CreateAgent = (provider: Provider, options: ProviderAgentOptions) => Conversation;
export type ProviderAgentFactory = (selection: Provider | ProviderSelection) => Conversation;

export function createAgent(provider: Provider, options: ProviderAgentOptions): Conversation {
  if (provider === "openai") return new OpenAIAgent(options);
  if (provider === "openai-codex") {
    const transport = options.codexTransport ?? (options.credentials ? new CodexTransport({ credentials: options.credentials }) : undefined);
    if (!transport) throw new Error("ChatGPT is not authenticated. Run /login openai-codex.");
    return new CodexAgent({ ...options, transport });
  }
  return new AnthropicAgent(options);
}

export interface CreateAgentFactoryOptions extends AgentBaseOptions {
  apiKeyFor?: (provider: Provider) => string | undefined;
  credentials?: CredentialManager;
  codexTransport?: CodexTransport;
  sessionPrompt?: SessionPrompt;
}

/** Build agents sharing canonical history and the active session's prompt snapshot. */
export function createAgentFactory(
  options: CreateAgentFactoryOptions,
  construct: CreateAgent = createAgent,
): ProviderAgentFactory {
  return (selection) => {
    const provider = typeof selection === "string" ? selection : selection.provider;
    const model = typeof selection === "string" ? modelFor(provider) : selection.model;
    const apiKey = options.apiKeyFor?.(provider);
    const systemPrompt = options.sessionPrompt?.snapshot() ?? options.systemPrompt;
    return construct(provider, { ...options, model, ...(systemPrompt ? { systemPrompt } : {}), ...(apiKey ? { apiKey } : {}) });
  };
}
