# redwake-agent

**Redwake Agent** is a minimalist coding agent under the Redwake family of apps. Its
command is **`rwa`** (short for redwake-agent). The agent can execute shell commands;
use it only in workspaces you trust.

## Usage

Release archives contain one standalone executable named `rwa`. Bun is not required
at runtime. The public curl installer will be supplied separately and is not part of
this repository's current distribution work.

```sh
rwa                         # use the current directory as the workspace
rwa /path/to/project        # use another workspace
rwa --resume /path/session.jsonl
rwa --no-tui                # line-oriented output
rwa --debug                 # plain output with startup details
rwa --help
rwa --version
```

Set provider configuration in the process environment:

- `ANTHROPIC_API_KEY` for `PROVIDER=anthropic` (the default)
- `OPENAI_API_KEY` for `PROVIDER=openai`
- `PROVIDER=openai-codex` for ChatGPT subscription OAuth (no API key)
- `BRAVE_SEARCH_API_KEY` when using the search tool

Standalone `rwa` does not depend on an install-root or workspace `.env` file.
Relative read, write, edit, and bash operations resolve against the selected
workspace. State is never stored in that workspace.

Interactive terminals use a full-screen UI. Redirected input/output, `TERM=dumb`,
`--no-tui`, and `--debug` use deterministic plain output. A blank message or Ctrl-D
exits. `/model`, `/status`, `/tree`, and `/sessions` manage runtime state and history.
ChatGPT OAuth is managed with:

```text
/login openai-codex
/login openai-codex --device
/status openai-codex
/logout openai-codex [account-id]
```

The system prompt is built into the executable from
`source/agent/system-prompt.ts`; no source-checkout prompt asset is needed.

## Private global state

State is located at:

- `$XDG_CONFIG_HOME/redwake/agent/` when `XDG_CONFIG_HOME` is a non-empty absolute path
- `~/.config/redwake/agent/` otherwise (including a relative `XDG_CONFIG_HOME`)

`redwake/` is the shared namespace for Redwake apps and `agent/` belongs to this app.
The app stores `auth.sqlite` (credentials, quota/model cache, and model selection),
`sessions/`, and `installation-id` there. Directories are user-only (`0700`) and
private files are `0600`. On first normal startup, data from the legacy
`~/redwake/agent/` location is migrated conservatively without overwriting new data.

## Contributor setup

Bun is a development and build requirement:

```sh
bun install
bun run start -- /path/to/project
bun test
bun run typecheck
bun run build
./dist/rwa --help
./dist/rwa --version
```

`bun run build` compiles a host-native standalone executable to `dist/rwa`. Tagged
releases (`v*`) build macOS arm64/x64 and Linux x64/arm64/x64-baseline archives,
each containing only `rwa`, plus `SHA256SUMS`.
