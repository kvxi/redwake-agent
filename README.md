# redwake-coding-agent

Redwake coding agent. My take on a minimalist coding agent. Right now, running it carrues a mild security risk since sandboxing and hardcoded command allowlist is not yet implemented. The agent can run bash commands with only minimal guard rails. Future roadmap: harden security, TUI with history navigation, auto model usage to imrpove cost efficiency, and multi sub agents. 

# Cool stuff you can do

Edit source/custom_system.md to change the behavior of the agent. The default system prompt is minimal and just one small part of the total context which is given to the agent. You can write whatever you want into custom_system.md to unlock new behaviors from the agent or influence its work style.

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