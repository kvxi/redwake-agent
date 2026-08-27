import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic" | "openai";

export const DEFAULT_MODELS: Readonly<Record<Provider, string>> = {
  anthropic: "claude-opus-5",
  openai: "gpt-5.6",
};

const configuredProvider = process.env.PROVIDER ?? "anthropic";
if (configuredProvider !== "anthropic" && configuredProvider !== "openai") {
  throw new Error(`Unsupported provider: ${configuredProvider}`);
}

/** API provider selected by PROVIDER; defaults to Anthropic for compatibility. */
export const PROVIDER: Provider = configuredProvider;

/**
 * Resolves the selected provider's model. MODEL overrides only the provider
 * active at process startup; switching providers uses that provider's default.
 */
export function modelFor(provider: Provider): string {
  if (provider === PROVIDER && process.env.MODEL) return process.env.MODEL;
  return DEFAULT_MODELS[provider];
}

/** Model selected for the provider active at process startup. */
export const MODEL = modelFor(PROVIDER);
export const MAX_TOKENS = 4096;

// Session-store root: ~/redwake/agent/sessions (per memory_sessions_plan.md).
export const SESSIONS_ROOT = join(homedir(), "redwake", "agent", "sessions");

// Tool output/HTTP limits (ported from ToolSet class attributes).
export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_OUTPUT_LINES = 1_000;
export const FETCH_WINDOW_CHARS = 20_000;
export const HTTP_TIMEOUT_MS = 20_000;
export const SEARCH_RESULT_COUNT = 20;
