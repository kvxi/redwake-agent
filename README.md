# redwake-agent

**Redwake Agent** is a minimalist coding agent based on my sensibilities. I use this and will update it anytime I think a feature is necesssary in my workflow.

Redwake Agent is almost ready for public distribution.

```sh
rwa                         # use the current directory as the workspace
rwa /path/to/project        # use another workspace
rwa --resume /path/session.jsonl
rwa --no-tui                # line-oriented output
rwa --debug                 # plain output with startup details
rwa --help
rwa --version
```

In the TUI navigate up and down with arrow keys, including while a
response is streaming. Press **End** to return to and follow the newest output.

On first run, the agent asks you to choose a provider and then authenticates it.
Anthropic and OpenAI API keys are pasted into a masked prompt and stored in the
private global database. ChatGPT subscriptions use browser OAuth on a local
desktop. In containers and headless sessions the agent automatically uses the
device flow; it can also be requested explicitly with `--device`.

Models and credentials can also be managed later with:

```text
/model anthropic            # authenticate if needed, then choose an API model
/model openai               # authenticate if needed, then choose an API model
/model openai-codex         # choose a model available to the ChatGPT account
/api anthropic              # API-provider-only alias for /model anthropic
/api openai                 # API-provider-only alias for /model openai
/login anthropic
/login openai
/login openai-codex
/login openai-codex --device
/status <provider>
/logout <provider> [account-id]
```

Environment configuration remains supported and takes precedence over stored keys:

- `ANTHROPIC_API_KEY` for `PROVIDER=anthropic`
- `OPENAI_API_KEY` for `PROVIDER=openai`
- `PROVIDER=openai-codex` for ChatGPT subscription OAuth (no API key)
- `BRAVE_SEARCH_API_KEY` when using the search tool

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
