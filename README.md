# redwake-coding-agent

A minimal terminal coding agent (Anthropic tool-use loop) written in TypeScript
and run with [Bun](https://bun.sh).

## Requirements

- Bun >= 1.4
- `ANTHROPIC_API_KEY` (required) and `BRAVE_SEARCH_API_KEY` (only for the
  `search` tool) available in the environment or a local `.env` file.

## Setup

```sh
bun install
```

## Run

```sh
bun run start            # start the interactive agent in the current directory
bun run source/client.ts /path/to/project   # or point it at another directory
```

Type a message at the `>` prompt; submit an empty line (or Ctrl-D) to exit.

## Test / typecheck

```sh
bun test
bun run typecheck
```

## Layout

```
source/
  client.ts            CLI entry: sets the process title, calls main()
  main.ts              arg/cwd handling + interactive REPL
  config.ts            model id and runtime limits
  agent/
    loop.ts            Agent: createMessage / runTurn / runTools
    system-prompt.ts   system prompt assembly
  tools/
    registry.ts        single source of truth (schema + handler per tool)
    context.ts         shared per-session state + tool types
    read/write/edit/bash/search/fetch.ts, html-to-markdown.ts
tests/                 bun:test suites
```

Each tool declares one Zod schema that drives both runtime validation and the
Anthropic JSON tool schema, so the two can never drift.
