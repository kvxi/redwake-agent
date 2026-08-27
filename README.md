# redwake-coding-agent

Redwake Coding Agent: My take on a minimalist coding agent. Right now, running it carries a mild security risk since sandboxing and hardcoded command allowlist is not yet implemented. The agent can run bash commands with only minimal guard rails. Future roadmap: harden security, TUI with history navigation, auto model usage to imrpove cost efficiency, and multi sub agents. 

# Cool stuff you can do

Edit source/custom_system.md to change the behavior of the agent. The default system prompt is minimal and just one small part of the total context which is given to the agent. You can write whatever you want into custom_system.md to unlock new behaviors from the agent or influence its work style.

## Requirements

- Bun >= 1.4
- `ANTHROPIC_API_KEY` for `PROVIDER=anthropic` (default), or `OPENAI_API_KEY`
  for `PROVIDER=openai`, available in the environment or the repository-root
  `.env` file.
- `BRAVE_SEARCH_API_KEY` only when the `search` tool is needed.

## Setup

```sh
bun install
```

## Run

```sh
bun run start                                      # Anthropic (default)
PROVIDER=openai MODEL=gpt-5.6 bun run start        # OpenAI
bun run source/client.ts /path/to/project          # target another project
```

Type a message at the `>` prompt; submit an empty line (or Ctrl-D) to exit.

Use `/model` to select Anthropic or OpenAI without sending a model message.
Changing providers starts a fresh provider-specific conversation while retaining
the agent's tool state.

## Test / typecheck

```sh
bun test
bun run typecheck
```