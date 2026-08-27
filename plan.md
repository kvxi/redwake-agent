# Seamless Model-Switching Context Plan

## Goal

Preserve useful session context when the user switches providers with `/model`, so the next model can continue naturally without receiving invalid provider-specific history.

The session—not an Anthropic or OpenAI agent instance—should own the canonical conversation history. Provider agents should translate that history into their native request formats.

## Current Behavior

- `runRepl` creates a new agent whenever `/model` selects a provider.
- `AnthropicAgent` stores history in a private `MessageParam[]`.
- `OpenAIAgent` stores history in a private `ResponseInput`.
- A newly constructed agent starts with an empty native history.
- `ToolContext` and `SessionStore` are shared, but the store is write-only and is not used to hydrate agents.
- The store currently persists only user and assistant text, not tool calls or tool results.
- A model switch occurs between completed turns, so there should be no outstanding tool call to transfer.

## Design Principles

1. Maintain one provider-neutral transcript for the session.
2. Keep provider wire formats inside provider-specific adapters.
3. Preserve exact history while it fits in the target model's context window.
4. Compact older history only when necessary.
5. Never transfer unmatched or provider-specific tool-call objects directly.
6. Keep `/model` local; it should not appear as a user message in model history.
7. Persist the same canonical representation used for in-memory handoff.
8. Do not depend on caching provider agents; inactive cached agents would miss turns handled by another provider.

## Canonical Session Model

Add a provider-neutral event model, for example in `source/session/conversation-state.ts`:

```ts
export type SessionEvent =
  | {
      type: "user";
      content: string;
    }
  | {
      type: "assistant";
      content: string;
    }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      callId: string;
      content: string;
      isError: boolean;
    };

export class ConversationState {
  readonly events: SessionEvent[];

  constructor(
    private readonly store?: SessionStore,
    initialEvents: SessionEvent[] = [],
  ) {
    this.events = [...initialEvents];
  }

  append(event: SessionEvent): void {
    this.events.push(event);
    this.store?.append(event);
  }
}
```

The exact class API may change during implementation, but it should provide one authoritative event stream shared by all provider agents.

## Provider History Translation

Create provider-specific translation functions:

```ts
function toAnthropicHistory(events: SessionEvent[]): MessageParam[];
function toOpenAIHistory(events: SessionEvent[]): ResponseInput;
```

### Text messages

User and assistant text can normally be translated directly into each provider's native message representation.

### Historical tool activity

Provider tool protocols differ in message structure, call identifiers, and ordering constraints. Do not blindly copy native tool objects from one provider to another.

Use one of these translation strategies:

1. Translate a complete canonical `tool_call`/`tool_result` pair into the target provider's native format when the target API accepts the sequence safely.
2. Otherwise, render completed historical tool activity as ordinary context, such as:

```text
Previous tool interaction:
- Tool: read
- Input: {"file_path":"source/main.ts"}
- Result: <tool output>
```

Prefer correctness over preserving native tool structure. Historical calls are complete facts; only calls made during the current turn need to remain native protocol objects.

## Runtime Flow

1. `main` creates one `ConversationState` for the process session.
2. `createAgentFactory` receives the shared `ConversationState`, `ToolContext`, and `SessionStore` dependencies.
3. The active agent appends user, assistant, tool-call, and tool-result events to the shared state.
4. When `/model` is selected, `runRepl` constructs the target provider agent with that same state.
5. The new agent translates or hydrates the canonical transcript into its native request history.
6. The next user message is appended and sent with the retained session context.
7. The REPL reports that context was retained instead of reset.

A model switch must remain available only between turns. The existing `runTurn()` boundary already waits until all tool calls have completed, which avoids transferring an in-flight tool call.

## Required Code Changes

### 1. Add canonical conversation state

Add a module under `source/session/` containing:

- `SessionEvent`
- `ConversationState`
- optional validation for events loaded from disk
- methods to append and inspect events without exposing mutable internal state unnecessarily

### 2. Update session persistence

Change `source/session/store.ts` to persist canonical events, including tool calls and tool results.

Add a loading API, for example:

```ts
load(): SessionEvent[];
```

Requirements:

- Continue using append-only JSONL.
- Continue treating write failures as non-fatal.
- Validate or safely reject malformed records on load.
- Preserve event ordering.
- Decide whether the existing `id`/`parent` envelope remains around each event. Keeping it is useful for future branching.
- Avoid writing secrets unnecessarily; tool outputs and inputs may need truncation or redaction rules.

### 3. Update `AgentBaseOptions`

Add shared conversation state:

```ts
export interface AgentBaseOptions {
  ctx?: ToolContext;
  print?: (text: string) => void;
  store?: SessionStore;
  conversation: ConversationState;
}
```

If `ConversationState` owns persistence, remove direct persistence responsibility from `AgentBase` to prevent duplicate writes.

### 4. Update the shared turn lifecycle

In `source/agent/base.ts`:

- Append the user event before the first request.
- Append each normalized tool call before execution.
- Append each tool result after execution.
- Append assistant-visible text when received.
- Preserve provider-native response objects only for the active turn/protocol as needed.
- Ensure each canonical event is written exactly once.

The current `NormalizedToolCall` may need an explicit normalized input value rather than only `decodeInput()`, so the same decoded input can be executed and recorded consistently.

### 5. Add Anthropic history encoding

In `source/agent/anthropic.ts` or a separate adapter module:

- Convert canonical user and assistant events into `MessageParam[]`.
- Convert safe complete tool pairs where possible.
- Fall back to textual historical tool context when native conversion would be invalid.
- Keep current-turn `tool_use` and `tool_result` blocks native.

### 6. Add OpenAI history encoding

In `source/agent/openai.ts` or a separate adapter module:

- Convert canonical user and assistant events into `ResponseInput`.
- Convert safe complete function-call pairs where possible.
- Fall back to textual historical tool context when native conversion would be invalid.
- Keep current-turn function calls and outputs native.

### 7. Update the agent factory

Change `source/agent/factory.ts` so every newly constructed provider agent receives the same canonical conversation state.

Clarify the factory comment: history is retained by shared session state, not by caching provider-local agent instances.

### 8. Update `/model` behavior

In `source/main.ts`:

- Keep `/model` local and out of the transcript.
- Construct the selected provider with the shared conversation state.
- Change the status message to something like:

```text
Switched to openai using gpt-5.6. Conversation retained.
```

- Selecting the currently active provider may either rebuild the agent from canonical state or be treated as a no-op; choose and test one explicit behavior.

### 9. Add context compaction

Do not require summarization for the first implementation if the exact transcript fits. Add a clear extension point for compaction:

```ts
interface ConversationSnapshot {
  summary?: string;
  facts: string[];
  recentEvents: SessionEvent[];
}
```

When context approaches the target model's limit:

1. Summarize older events.
2. Retain important project facts and decisions.
3. Keep recent user and assistant messages verbatim.
4. Keep relevant recent tool interactions verbatim.
5. Record summary provenance or covered event IDs so events are not duplicated.

Do not summarize on every provider switch. Unnecessary summarization adds latency, cost, and information loss.

## Incremental Delivery

### Phase 1: Text continuity

Implement the smallest useful version:

- Shared canonical user/assistant transcript
- Provider adapters for text messages
- Hydration when constructing a new provider agent
- `/model` reports retained context
- Existing shared `ToolContext` remains unchanged

Historical tool activity can initially be omitted or represented as concise text.

### Phase 2: Full tool-event history

- Record canonical tool calls and results.
- Translate complete tool interactions safely.
- Add textual fallback for incompatible provider history.
- Add truncation/redaction controls for large or sensitive tool data.

### Phase 3: Resume and compaction

- Load canonical events from JSONL.
- Resume a previous session using the same model-switch mechanism.
- Add context-budget calculation and older-history compaction.
- Preserve summaries and important facts across restarts.

## Testing Plan

### Conversation state tests

- Appending events preserves order.
- Events are persisted exactly once.
- Loading restores valid events.
- Malformed records are handled predictably.

### Adapter tests

- User and assistant text convert correctly for Anthropic.
- User and assistant text convert correctly for OpenAI.
- Complete tool pairs are translated or rendered as text without unmatched IDs.
- Tool errors retain their error status or equivalent textual meaning.
- Empty history produces valid provider requests.

### REPL tests

- `/model` is not sent to either provider.
- The target agent receives all previous user/assistant context.
- The next user turn is sent only once.
- Switching Anthropic → OpenAI → Anthropic retains turns from both providers.
- Selecting the same provider has documented behavior.
- Invalid or canceled selections do not alter state.

### Tool-loop tests

- Switching is only possible after a completed turn.
- Tool calls and results are recorded once.
- Historical tool IDs never produce invalid target-provider sequences.
- Tool state such as `readPaths` remains shared after switching.

### Persistence tests

- One JSONL session contains events across provider switches.
- Event IDs and parent links remain valid if retained.
- A loaded session can initialize either provider.

## Acceptance Criteria

- After `/model`, the new provider can answer references such as “continue that change” using the prior conversation.
- The `/model` command itself never appears in model input.
- Switching in either direction produces valid API payloads.
- Switching away from a provider and back does not lose intervening turns.
- Completed tool activity is available to the new provider in a safe native or textual representation.
- There are no unmatched cross-provider tool-call IDs.
- Session persistence contains enough canonical information to support future resume functionality.
- The shared tool context and filesystem effects remain intact.
- Existing non-switching conversations continue to work.

## Non-Goals for the Initial Version

- Transferring hidden model reasoning or chain-of-thought
- Interrupting and transferring an in-flight tool call
- Perfectly preserving every provider-specific response field
- Summarizing every switch
- Solving branching session navigation before linear handoff works

## Key Architectural Decision

The durable source of truth should be a provider-neutral session transcript. Anthropic and OpenAI histories are derived representations used to communicate with their respective APIs, not the primary owner of session context.

## Publishing This Work to an `experimental` Branch

Push the repository to a new branch named `experimental` on `origin`
(`git@github.com:kvxi/redwake-coding-agent.git`).

### Steps

1. Confirm you are in the repository root and inspect the working tree:

```bash
cd /Users/act/redwake-coding-agent
git status
```

2. Create and switch to the new branch from the current `main` branch:

```bash
git switch -c experimental
```

3. Stage and commit any pending work (skip if the tree is already clean):

```bash
git add -A
git commit -m "Add seamless model-switching context plan"
```

4. Push the branch and set its upstream tracking reference:

```bash
git push -u origin experimental
```

5. Verify the branch exists remotely and is tracked locally:

```bash
git branch -vv
git ls-remote --heads origin experimental
```

### Notes

- Use `git push -u origin experimental` only the first time; later pushes are
  just `git push`.
- If `experimental` already exists on the remote, either pick a different name
  or reconcile with `git pull --rebase origin experimental` before pushing.
- Do not force-push (`--force`) to a shared branch; prefer
  `--force-with-lease` if a rewrite is unavoidable.
- Keep `main` untouched by this work; open a pull request from `experimental`
  when the changes are ready for review.
- Confirm `.env` remains ignored by `.gitignore` so credentials are never
  pushed.
