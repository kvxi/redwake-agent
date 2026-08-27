// Central runtime configuration. Single source of truth for the model id
// (previously duplicated/overwritten in loop.py).
export const MODEL = "claude-opus-5";
export const MAX_TOKENS = 4096;

// Tool output/HTTP limits (ported from ToolSet class attributes).
export const MAX_OUTPUT_CHARS = 20_000;
export const MAX_OUTPUT_LINES = 1_000;
export const FETCH_WINDOW_CHARS = 20_000;
export const HTTP_TIMEOUT_MS = 20_000;
export const SEARCH_RESULT_COUNT = 20;
