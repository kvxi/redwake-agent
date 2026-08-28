import { modelFor, type Provider } from "../config.ts";
import type { CredentialManager } from "../auth/credential-manager.ts";
import { CodexTransport } from "../codex/transport.ts";
import { AnthropicAgent } from "./anthropic.ts";
import { type AgentBaseOptions } from "./base.ts";
import type { Conversation } from "./conversation.ts";
import { CodexAgent } from "./codex.ts";
import { OpenAIAgent } from "./openai.ts";
export interface ProviderSelection {provider:Provider;model:string;}
export type ProviderAgentOptions=AgentBaseOptions&{model:string;credentials?:CredentialManager;codexTransport?:CodexTransport};
export type CreateAgent=(provider:Provider,options:ProviderAgentOptions)=>Conversation;
export type ProviderAgentFactory=(selection:Provider|ProviderSelection)=>Conversation;
export function createAgent(provider:Provider,options:ProviderAgentOptions):Conversation{if(provider==="openai")return new OpenAIAgent(options);if(provider==="openai-codex"){const transport=options.codexTransport??(options.credentials?new CodexTransport({credentials:options.credentials}):undefined);if(!transport)throw new Error("ChatGPT is not authenticated. Run /login openai-codex.");return new CodexAgent({...options,transport});}return new AnthropicAgent(options);}
/** Build uncached agents sharing canonical history. Accepts a provider string for compatibility. */
export function createAgentFactory(options:AgentBaseOptions&{credentials?:CredentialManager;codexTransport?:CodexTransport},construct:CreateAgent=createAgent):ProviderAgentFactory{return(selection)=>{const provider=typeof selection==="string"?selection:selection.provider;const model=typeof selection==="string"?modelFor(provider):selection.model;return construct(provider,{...options,model});};}
