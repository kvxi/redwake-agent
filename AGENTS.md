# Repository guide

Redwake Agent is a minimalist, Bun-based TypeScript coding-agent CLI (`rwa`). It supports Anthropic and OpenAI APIs, ChatGPT subscription OAuth, tool execution, persistent branching sessions, and both TUI and plain terminal output.

## Development commands

- Install dependencies: `bun install`
- Run locally: `bun run start -- [workspace] [--no-tui|--debug]`
- Run all tests: `bun test`
- Run one test file: `bun test tests/<name>.test.ts`
- Type-check: `bun run typecheck`
- Build the native executable: `bun run build`

Use Bun, not npm or Node, for scripts and tests. CI uses Bun 1.4.0 and runs `bun test && bun run typecheck`. There is no configured lint or format command.

## Code map

- `source/cli.ts` is the executable entry point; `source/main.ts` owns startup and the interactive REPL.
- `source/agent/` contains the provider-neutral lifecycle and provider adapters. Keep shared turn/tool behavior in `base.ts`; keep wire-format translation in provider files.
- `source/codex/` contains ChatGPT/Codex transport, model, SSE, and usage handling.
- `source/auth/` owns API-key/OAuth management and the private global SQLite store.
- `source/session/` owns append-only JSONL history, branching, navigation, and session UI.
- `source/tools/` defines tools. Zod schemas are the validation and provider-schema source of truth; register new tools in `registry.ts`.
- `source/ui/` contains terminal rendering and input behavior for TUI/plain modes.
- `tests/` mirrors behavior across these areas using Bun's test runner.

## Conventions

- Keep TypeScript strict and ESM-compatible. Use double quotes, semicolons, 2-space indentation, explicit `.ts` extensions for local imports, and `node:` prefixes for built-ins.
- Use `import type`/`export type` for type-only dependencies and avoid `any`; the compiler enables `noUncheckedIndexedAccess`.
- Prefer small, focused changes and existing dependency-injection seams over new globals. Preserve provider-neutral behavior and parity across Anthropic, OpenAI, and OpenAI Codex where applicable.
- Keep terminal output deterministic and avoid mixing rendering concerns into canonical conversation/session state.
- Preserve backward compatibility when changing persisted session records, auth schemas, CLI flags, or slash commands.
- Do not hand-edit `bun.lock`; update it through Bun only when dependencies change.

## Testing and safety

- Add or update a focused `tests/*.test.ts` regression test for behavior changes. Use `bun:test`, temporary directories, in-memory stores, and mocked fetch/provider clients; tests must not require live credentials or network access.
- Run the nearest relevant test file while iterating, then run `bun test` and `bun run typecheck` before finishing. Run `bun run build` when changing CLI startup, packaging, or runtime imports.
- Never write credentials, OAuth tokens, or session contents into the repository, logs, fixtures, or snapshots. Global state belongs under the paths defined in `source/paths.ts`; retain `0700` directories and `0600` private files.
- Treat session JSONL as append-only and tolerate malformed/legacy data rather than destructively rewriting user history.
- Do not alter unrelated working-tree changes or generated `dist/` artifacts.
