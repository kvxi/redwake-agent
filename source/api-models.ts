import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Provider } from "./config.ts";
import type { ModelDescriptor } from "./codex/models.ts";

export type ApiProvider = Extract<Provider, "anthropic" | "openai">;

/** List every model visible to an API key using the provider's official SDK. */
export async function discoverApiModels(
  provider: ApiProvider,
  apiKey: string,
): Promise<ModelDescriptor[]> {
  if (provider === "anthropic") {
    const models: ModelDescriptor[] = [];
    for await (const model of new Anthropic({ apiKey }).models.list({ limit: 100 })) {
      models.push({
        provider,
        id: model.id,
        displayName: model.display_name,
        ...(model.max_input_tokens === null ? {} : { contextWindow: model.max_input_tokens }),
        ...(model.max_tokens === null ? {} : { maxOutputTokens: model.max_tokens }),
      });
    }
    return models;
  }

  const models: ModelDescriptor[] = [];
  for await (const model of new OpenAI({ apiKey }).models.list()) {
    models.push({ provider, id: model.id, displayName: model.id });
  }
  return models.sort((left, right) => right.id.localeCompare(left.id));
}
