# redwake-coding-agent

Redwake Coding Agent: My take on a minimalist coding agent. Right now, running it carries a mild security risk since sandboxing and a hardcoded command allowlist are not yet implemented. The agent can run bash commands with only minimal guard rails. Future roadmap: harden security, improve model cost efficiency, and add multiple sub-agents.

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
bun run start -- --resume ./session.jsonl          # resume a session
bun run start -- --no-tui                          # force line-oriented output
bun run start -- --debug                           # plain output plus startup internals
```

On an interactive terminal Redwake uses a full-screen UI with a scrolling transcript,
bordered single-line editor, and persistent activity/model/session status. Enter submits;
a blank message or Ctrl-D on an empty editor exits. Ctrl-A/E move to the start/end,
Ctrl-U/K delete to the start/end, Page Up/Page Down scroll output, and End resumes
following streamed output. `/tree` and `/sessions` open keyboard-driven overlays;
use Up/Down, Enter, Esc, or Ctrl-C.

Redirected input/output, `TERM=dumb`, `--no-tui`, and `--debug` use deterministic,
ANSI-free line output. `NO_COLOR` disables TUI color while retaining layout. Normal
startup shows a product-facing session label and hides its internal JSONL path;
`--debug` prints the full path and startup metadata.

Responses stream as they are generated, and concise progress rows show tool activity.
Full tool results remain internal to the model and session; bash output is buffered until
its command completes. The status activity is `idle`, `thinking`, `responding`, or
`running`; reasoning effort is shown only when supplied by real runtime state.

Use `/model` to select Anthropic, OpenAI, or authenticated ChatGPT Codex without
sending a model message. Canonical history and tool state are retained. The last
selection is restored on future startups; an explicit `PROVIDER` or `MODEL`
environment setting overrides it for that startup.

Use `/status` to display the active model, session name, and number of events in
the active session.

ChatGPT OAuth commands are local and never enter session history:

```text
/login openai-codex             # browser PKCE login (localhost:1455 callback)
/login openai-codex --device    # headless/device login
/status openai-codex            # stored ChatGPT account status
/logout openai-codex [account-id]
```

Credentials and the last model selection are stored globally in
`~/redwake/agent/auth.sqlite` with user-only filesystem permissions, not in a
project `.env` or session JSONL. Multiple
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

Use `/sessions` to list sessions for the current project, move with ↑/↓, continue
one with Enter, or cancel with Esc. Continuing changes the active append-only
session file and rebuilds model context from that session's active branch; the
current provider and model are retained. Unlike `/tree`, it does not create a
branch or prefill an earlier message—the next prompt is appended to the selected
session's current leaf.

## Test / typecheck

```sh
bun test
bun run typecheck
```