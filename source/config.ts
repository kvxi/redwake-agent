import { homedir } from "node:os";
import { join } from "node:path";

export type Provider = "anthropic" | "openai";

const configuredProvider = process.env.PROVIDER ?? "anthropic";
if (configuredProvider !== "anthropic" && configuredProvider !== "openai") {
  throw new Error(`Unsupported provider: ${configuredProvider}`);
}

/** API provider selected by PROVIDER; defaults to Anthropic for compatibility. */
export const PROVIDER: Provider = configuredProvider;

/** Model selected by MODEL; defaults to the selected provider's primary model. */
export const MODEL =
  process.env.MODEL ?? (PROVIDER === "openai" ? "gpt-5.6" : "claude-opus-5");
export const MAX_TOKENS = 4096;

// Session-store root: ~/redwake/agent/sessions (per memory_sessions_plan.md).
export const SESSIONS_ROOT = join(homedir(), "redwake", "agent", "sessions");

// Tool output/HTTP limits (ported from ToolSet class attributes).
export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_OUTPUT_LINES = 1_000;
export const FETCH_WINDOW_CHARS = 20_000;
export const HTTP_TIMEOUT_MS = 20_000;
export const SEARCH_RESULT_COUNT = 20;
