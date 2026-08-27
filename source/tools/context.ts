import { z } from "zod";
import type { ZodType } from "zod";

/** The subset of `fetch` the tools depend on; keeps fakes trivial to supply. */
export type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/**
 * Shared, mutable state threaded through every tool invocation.
 * Replaces the instance state that lived on the Python `ToolSet` class.
 */
export interface ToolContext {
  /** Absolute paths that have been read (or written) this session. */
  readPaths: Set<string>;
  /** Injectable fetch implementation, for testability. Defaults to global fetch. */
  fetch: FetchFn;
  /** Injectable env lookup, for testability. Defaults to process.env. */
  env: (key: string) => string | undefined;
}

export function createToolContext(
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    readPaths: overrides.readPaths ?? new Set<string>(),
    fetch: overrides.fetch ?? globalThis.fetch,
    env: overrides.env ?? ((key) => process.env[key]),
  };
}

/**
 * Raised by tools for expected, user-facing validation/operation failures.
 * The loop serializes `message` back to the model as a tool error.
 */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** A tool: schema + description + handler, colocated as one source of truth. */
export interface Tool<S extends ZodType = ZodType> {
  name: string;
  description: string;
  schema: S;
  handler: (input: z.infer<S>, ctx: ToolContext) => Promise<unknown> | unknown;
}

/**
 * A tool with its generic erased, for heterogeneous storage in the registry.
 * The `input` is intentionally `unknown`: the registry validates raw model
 * input with `schema.parse` before invoking `handler`.
 */
export interface AnyTool {
  name: string;
  description: string;
  schema: ZodType;
  handler: (input: never, ctx: ToolContext) => Promise<unknown> | unknown;
}

/** Helper to define a tool with full type inference on the handler input. */
export function defineTool<S extends ZodType>(tool: Tool<S>): Tool<S> {
  return tool;
}
