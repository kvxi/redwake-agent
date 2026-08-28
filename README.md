# redwake-coding-agent

Redwake Coding Agent: My take on a minimalist coding agent. Right now, running it carries a mild security risk since sandboxing and hardcoded command allowlist is not yet implemented. The agent can run bash commands with only minimal guard rails. Future roadmap: harden security, TUI with history navigation, auto model usage to imrpove cost efficiency, and multi sub agents. 

# Cool stuff you can do

Edit source/custom_system.md to change the behavior of the agent. The default system prompt is minimal and just one small part of the total context which is given to the agent. You can write whatever you want into custom_system.md to unlock new behaviors from the agent or influence its work style.

## Requirements

- Bun >= 1.4
- `ANTHROPIC_API_KEY` for `PROVIDER=anthropic` (default), or `OPENAI_API_KEY`
  for `PROVIDER=openai`, available in the environment or the repository-root
  `.env` file. ChatGPT subscription access uses `PROVIDER=openai-codex` and OAuth;
  it never uses `OPENAI_API_KEY`.
- `BRAVE_SEARCH_API_KEY` only when the `search` tool is needed.

## Setup

```sh
bun install
```

## Run

```sh
bun run start                                      # Anthropic (default)
PROVIDER=openai MODEL=gpt-5.6 bun run start        # billed OpenAI API
PROVIDER=openai-codex bun run start                 # ChatGPT subscription
bun run source/client.ts /path/to/project          # target another project
```

Type a message at the `>` prompt; submit an empty line (or Ctrl-D) to exit.

Use `/model` to select Anthropic, OpenAI, or authenticated ChatGPT Codex without
sending a model message. Canonical history and tool state are retained.

ChatGPT OAuth commands are local and never enter session history:

```text
/login openai-codex             # browser PKCE login (localhost:1455 callback)
/login openai-codex --device    # headless/device login
/status openai-codex
/logout openai-codex [account-id]
```

Credentials are stored globally in `~/redwake/agent/auth.sqlite` with user-only
filesystem permissions, not in a project `.env` or session JSONL. Multiple
workspaces are supported and exhausted workspaces may be routed around. ChatGPT
subscription limits apply only to `openai-codex`; Redwake never falls back from
it to the billable OpenAI API. If callback port 1455 is occupied, use device
login. OAuth and the ChatGPT Codex backend are private compatibility surfaces;
a contract-drift error may require a Redwake update.

Use `/tree` to navigate the current session path with ↑/↓, branch with Enter, or
cancel with Esc. Selecting a user message branches from its parent and prefills
that complete message for editing and resubmission. Selecting an assistant or
tool entry keeps that entry as the leaf and opens an empty prompt. Abandoned
branches remain in the append-only session file, but are excluded from all
subsequent model context and from the active path when the session is resumed.

## Test / typecheck

```sh
bun test
bun run typecheck
```