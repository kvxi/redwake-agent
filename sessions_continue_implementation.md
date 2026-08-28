# `/sessions` Continue-Session Implementation Guide

## Goal

Add a local `/sessions` command that lists the sessions for the current working directory, lets the user move with ↑/↓, and continues the selected session when Enter is pressed.

Continuing a session means all of the following:

1. Replace the live `ConversationState` transcript with the selected session's active root-to-leaf path.
2. Point future persistence at the selected session file.
3. Rebuild the provider adapter so its provider-specific request history is reconstructed from the selected canonical history.
4. Leave the prompt empty. The next ordinary user input is appended to the selected file with `parent` equal to that session's active leaf.
5. Preserve the selected provider/model and the existing `ToolContext`.

The command itself is local. It must not be appended as a user event or sent to a model.

## Existing source behavior to preserve

The relevant source seams are:

- `source/config.ts` defines `SESSIONS_ROOT` as `~/redwake/agent/sessions`.
- `source/session/store.ts` stores one workspace under `encodeURIComponent(resolve(cwd))` and names files `session-N.jsonl`.
- `SessionStore` reconstructs its append leaf while scanning a file. `append()` already writes `{ id, parent: lastId, event }`.
- Checkout records (`{ "head": id }`) make the checked-out branch the active path. Therefore, "latest" must mean the **active leaf**, not simply the record with the largest ID. Otherwise `/sessions` could revive an abandoned `/tree` branch.
- `ConversationState` is the canonical provider-independent history. It currently owns a transcript, persisted record IDs, and one `SessionStore`.
- Every provider adapter is constructed with the shared `ConversationState`. `createAgentFactory()` creates a fresh adapter and each adapter rebuilds wire history from canonical state.
- `runRepl()` already calls `rebuildAgent()` after `/tree`, which is the correct model for session switching as well.
- `source/session/tree-ui.ts` already supplies the terminal mechanics needed by `/sessions`: key decoding, clamped selection, viewport scrolling, raw-mode setup/cleanup, readline pause/resume, cursor hiding, and ANSI-safe rows.
- `main()` creates a new numbered store by default; `--resume` directly opens a specified store.

Do not replace the current process with a new `main()` invocation and do not shell out to start another Redwake process. Switching in-process is necessary to retain provider/model selection and tool state.

## User-visible contract

Use this behavior consistently in implementation, tests, and README:

- `/sessions` lists only sessions belonging to the resolved current working directory. It must not expose sessions from other workspace directories.
- Sort by parsed numeric session number in ascending order (`session-1`, `session-2`, …), and initially select the newest item at the bottom. This mirrors `/tree`, which initially selects the current leaf.
- A row should contain at least the session filename and a short preview. A useful format is:

  ```text
    session-1 · 8 events · user: add authentication
  ❯ session-2 · 3 events · assistant: tests now pass
  ```

  Prefer the latest user/assistant event for the preview; tool-only paths may fall back to the latest event. Sanitize control/ANSI characters and truncate to terminal width exactly as tree rows do.
- The footer should say `↑/↓ navigate · enter continue · esc cancel`.
- Enter on the already active session is a harmless no-op. Report that it is already active and do not reconstruct state unnecessarily.
- Esc or Ctrl-C cancels only the selector and returns to the normal prompt.
- Non-TTY runs should report that interactive session selection is unavailable rather than hanging or entering raw mode.
- Empty lists should report `No sessions found for this workspace.`
- After a successful switch, print a concise message such as `Continued session-N.jsonl (12 events).`
- Do not prefill an old user message. Prefilling is `/tree` branch behavior, not continue-session behavior.
- Add `/sessions` to the unknown-command availability text.

The process's startup-created session may still be empty and therefore may not yet exist on disk. The listing layer should explicitly include the current store path even when the file has not been created, or the store constructor should create the empty file. Prefer explicit inclusion: it avoids changing the current lazy-write behavior merely for UI discovery.

## Recommended architecture

Keep three responsibilities separate:

```text
SessionStore/catalog       discover files and resolve active persisted paths
ConversationState          replace the live canonical transcript/store atomically
sessions-ui                render/select one session summary
runRepl                    command orchestration and provider adapter rebuild
```

A small injected navigator keeps filesystem details out of `runRepl` and makes REPL tests deterministic.

Suggested public types (names can vary, but retain these boundaries):

```ts
export interface SessionSummary {
  path: string;             // absolute path and stable selector identity
  name: string;             // session-N.jsonl
  number: number;
  eventCount: number;       // active-path count, not all abandoned records
  preview?: SessionEvent;
  active: boolean;
}

export interface SessionNavigator {
  list(): SessionSummary[];
  activate(path: string): { status: "switched" | "already-active"; eventCount: number };
}
```

`activate()` should be the only operation that mutates live conversation state. A selector returns a path; it must not return only a list index because the list can be regenerated and indices are not stable identities.

## 1. Refactor workspace session discovery

Update `source/session/store.ts` so creation and discovery share the same path rules.

Add helpers equivalent to:

```ts
export function sessionDirectory(
  cwd = process.cwd(),
  root = SESSIONS_ROOT,
): string {
  return join(root, encodeURIComponent(resolve(cwd)));
}

export function listSessionFiles(
  cwd = process.cwd(),
  root = SESSIONS_ROOT,
): Array<{ path: string; name: string; number: number }>;
```

Implementation requirements:

1. Match only `^session-(\d+)\.jsonl$`.
2. Convert the capture to a finite safe integer and reject invalid/unsafe values.
3. Sort numerically, not lexically (`session-10` must follow `session-9`).
4. Return absolute paths built from the known workspace directory and validated basenames. Never accept a path from terminal display text.
5. Treat a missing workspace directory as an empty list. Discovery should not throw merely because no sessions have been written yet.
6. Keep `createSessionStore()` behavior based on the maximum numeric suffix and reuse `sessionDirectory()`/the parser so creation and listing cannot drift.

For every discovered file, construct a `SessionStore` and obtain its active path with `loadPathRecords()`. Summaries must count only that path. Use the last user or assistant event on the path as the preview, falling back to the final event.

### Corrupt sessions

A selected session must have a valid parent chain from its active leaf to `null`. Before activation, verify:

```ts
const path = store.pathTo(store.leaf);
if (path === null) throw new Error("Session has an inconsistent history path.");
```

Do not switch the live state when validation fails. The existing `activePath()` fallback to file order is useful for backward-compatible reading, but it cannot guarantee that the next append has a valid parent if `leaf` itself is corrupt. Activation should therefore use the stricter check above. Malformed individual JSONL lines may continue to be skipped under the existing store policy.

Also canonicalize/resolve both the chosen path and listed paths before comparing them. `activate()` must reject any path that is not in the current discovery result (plus the explicitly included current path). This prevents arbitrary file access through an injected or stale UI value.

## 2. Make `ConversationState` switchable

`ConversationState` currently declares its store through a `private readonly` constructor parameter and initializes transcript arrays only once. Add a method that replaces all three pieces of canonical state together:

```ts
replaceSession(
  store: SessionStore,
  records: readonly SessionRecord[],
): void
```

Required behavior:

1. Validate the complete input before mutation:
   - records are a valid root-to-leaf chain;
   - the first parent is `null`;
   - each later `parent` equals the preceding record's `id`;
   - IDs are unique;
   - every event passes `isSessionEvent()`;
   - the final record ID equals `store.leaf` (or both are empty/null).
2. Clone events before storing them, preserving the class's current mutation protection.
3. Change `store` from readonly to a mutable private field.
4. Replace `transcript` with `records.map(record => record.event)`.
5. Replace `recordIds` with `records.map(record => record.id)`.
6. Assign the new store only after validation and cloning succeed, so a bad session cannot leave state half-switched.

The arrays are currently declared `readonly` but mutated with `push()` and `splice()`. They can remain the same array objects and be replaced via `splice(0, length, ...newValues)`, or the fields can become assignable arrays. The atomic validation-before-mutation rule matters more than which approach is chosen.

Do not implement continuation by calling `branchTo()` on the current conversation. `branchTo()` intentionally changes a leaf inside the current file; it does not change the backing store.

After replacement, existing methods provide the needed behavior automatically:

```text
next ordinary prompt
  -> AgentBase.runTurn()
  -> ConversationState.append(user event)
  -> selected SessionStore.append()
  -> parent is selected SessionStore.leaf
```

## 3. Add a session navigator

Add `source/session/navigator.ts` (or an equivalently focused module). Construct it with:

- resolved workspace cwd;
- sessions root (injectable for tests);
- the current `SessionStore`;
- the shared `ConversationState`.

Responsibilities:

### `list()`

- Discover workspace files.
- Include the current store if it is not yet present on disk.
- Create summaries from active paths.
- Mark exactly one item active by normalized absolute path.
- Return numeric ascending order.
- Return cloned/plain values so UI code cannot mutate navigator state.

### `activate(path)`

- Rediscover the allowlisted paths to avoid trusting a stale selector result.
- If the normalized path equals the active path, return `already-active`.
- Construct a fresh `SessionStore` for the selected path. A fresh instance is important because it scans the latest on-disk head and maximum ID.
- Strictly resolve and validate its active path.
- Call `conversation.replaceSession(store, records)`.
- Update the navigator's current store/path only after replacement succeeds.
- Return the active event count.

All operations are synchronous today because `SessionStore` uses synchronous filesystem APIs. Keep the navigator interface compatible with `Promise` if a future async store is likely, but do not mix sync and async behavior inconsistently.

## 4. Reuse the tree selector infrastructure

Avoid copying the raw-terminal lifecycle from `tree-ui.ts`. Extract reusable pieces into a neutral module such as `source/session/list-ui.ts`:

- `SelectionKey`, `SelectionState`, and `nextSelection()`;
- keypress decoding;
- raw-mode setup and restoration;
- viewport painting;
- generic item selection by stable identity.

Then retain thin wrappers:

```ts
selectTreeNode(entries, io): Promise<number | null>
selectSession(summaries, io): Promise<string | null>
```

`selectTreeNode()` should continue returning transcript indices so existing `/tree` behavior and tests remain unchanged. `selectSession()` should return the absolute path from the selected summary.

If a generic selector would make the first patch too broad, it is acceptable to export and reuse `nextSelection()` while adding `sessions-ui.ts`, but centralize key decoding and raw-mode cleanup rather than maintaining two subtly different implementations.

Add `formatSessionRow()` with the same safety rules as `formatTreeRow()`:

- strip ANSI escape sequences from persisted content;
- replace newlines, tabs, controls, and repeated whitespace;
- safely stringify tool input;
- truncate before adding styling, so ANSI bytes do not consume display width;
- never emit persisted content as terminal control sequences.

Use `try/finally` to restore raw mode, cursor visibility, input pause state, and readline operation on confirm, cancel, and exceptions. This is already done correctly in `selectTreeNode()` and must survive the refactor.

## 5. Wire `/sessions` into the REPL

Extend the interfaces in `source/main.ts`:

```ts
export interface ReplIO {
  // existing members...
  showSessions?(sessions: readonly SessionSummary[]): Promise<string | null>;
}

export interface ReplOptions {
  // existing members...
  sessions?: SessionNavigator;
}
```

Add command handling before the generic `userMessage.startsWith("/")` branch:

```ts
if (userMessage === "/sessions") {
  // check navigator and selector availability
  // list summaries
  // show selector
  // cancel safely when null
  // activate selected path
  // rebuildAgent() after a real switch
  // print result/error
  continue;
}
```

Detailed rules:

1. If either the navigator or `io.showSessions` is missing, write `Session selection is not available in this session.` and continue.
2. If no summaries exist, write the empty-list message and continue.
3. Wrap selector errors as cancellation or a clear UI error, just as `/tree` currently avoids crashing on selector failure.
4. On `null`, print `Session selection canceled.` and continue.
5. Call `activate()` inside `try/catch`. On failure, report a concise error and retain the old state/agent.
6. If the result is `already-active`, do not call `rebuildAgent()`.
7. On a real switch, clear `pendingEditorText` defensively, call `rebuildAgent()`, and report success.
8. Never call `runTurn()` for `/sessions`.
9. Add `/sessions` to the unknown-command message.

Why rebuilding is required: provider adapters maintain their own wire-format history in addition to canonical state. The old adapter still contains the previous session. A newly constructed adapter reads the newly replaced `ConversationState`, exactly as it does after `/tree` and `/model`.

## 6. Wire the runtime in `main()`

The creation order should become:

1. Resolve cwd and startup/`--resume` store as today.
2. Load initial records.
3. Construct the shared `ConversationState`.
4. Construct the `SessionNavigator` with that state and startup store.
5. Construct the agent factory with the same state and existing `ToolContext`.
6. For TTY input, assign both `io.showTree` and `io.showSessions`, passing the same readline pause/resume callbacks.
7. Pass `sessions: navigator` to `runRepl()`.

Do not construct a second `ConversationState` during activation. Existing and future agents must all share one canonical object. Do not recreate `ToolContext`; its `readPaths` state is intentionally session-process state and is needed by tools such as `edit`.

`--resume` should continue to work unchanged. The resumed file becomes the navigator's initially active item, and `/sessions` can then switch to another file in the same workspace directory. If a `--resume` path is outside the current workspace's standard session directory, either include only that path as the current item or disable switching with a clear message; do not silently use its parent directory as a new workspace catalog. The safer first implementation is to include the external resumed path as current but permit activation only for files discovered under the resolved workspace directory.

## 7. Tests

### `tests/session.test.ts`

Add coverage for:

- session discovery sorts `session-2` before `session-10` numerically;
- unrelated filenames and directories are ignored;
- missing workspace directories return an empty list;
- current empty/lazy session is included by the navigator;
- summaries count the active path, not abandoned records after a checkout;
- summary preview prefers the latest user/assistant event;
- activating a session replaces events and record IDs;
- the first appended user event after activation has `parent === selectedStore.leaf` from before the append;
- switching from a branched session continues from the persisted `head`, not the maximum record ID;
- corrupt/cyclic/missing parent graphs are rejected without mutating the current conversation;
- selecting the current path is a no-op;
- a path outside the workspace allowlist is rejected.

A critical integration assertion should resemble:

```ts
const previousLeaf = selectedStore.leaf;
navigator.activate(selectedStore.path);
conversation.append({ type: "user", content: "continue here" });
const last = new SessionStore(selectedStore.path).records().at(-1)!;
expect(last.parent).toBe(previousLeaf);
```

Use the actual active leaf captured from the selected file, and account for any checkout marker in the fixture.

### `tests/sessions-ui.test.ts`

Add pure tests for:

- up/down clamping and scrolling (or retain shared reducer tests in `tree-ui.test.ts`);
- newest item is initially selected;
- Enter returns the selected path;
- Esc and Ctrl-C return `null`;
- empty input does not touch raw mode;
- row formatting strips ANSI/control characters and truncates to width;
- `session-10` display does not affect numeric ordering;
- terminal cleanup occurs if painting or key handling throws.

Keep existing tree tests passing after any generic selector refactor.

### `tests/repl.test.ts`

Inject a fake navigator and `showSessions` callback. Verify:

- `/sessions` never calls any agent's `runTurn()`;
- confirmation activates the returned path and rebuilds the agent exactly once;
- the next normal message is sent through the rebuilt agent;
- cancellation returns to the prompt without activation/rebuild;
- an empty list is handled locally;
- unavailable non-TTY selection is handled locally;
- selecting the active session does not rebuild;
- activation failure retains the old agent and allows another prompt;
- unknown-command help includes `/sessions`.

When updating expected prompt colors, preserve the repository's current intentional `USER_INPUT_STYLE` change rather than folding unrelated style changes into this feature.

### Full validation

Run:

```sh
bun test
bun run typecheck
```

Also perform a manual TTY check:

1. Start Redwake and send a message in `session-N`.
2. Restart, creating `session-(N+1)`, and send a different message.
3. Run `/sessions`, choose `session-N`, and continue it.
4. Inspect `session-N.jsonl`: the new user record's parent must be its previous active leaf.
5. Confirm `session-(N+1)` was not modified by the continued message.
6. Run `/tree` in the continued session and verify it shows the selected session's path.
7. Cancel both selectors and verify the prompt/readline state remains normal.

## 8. Documentation updates

Update `README.md` near the existing `/tree` section. Explain:

- `/sessions` lists sessions for the current project only;
- ↑/↓, Enter, Esc controls;
- continuing uses the selected session's active branch and appends to that JSONL file;
- `/tree` branches within one session, while `/sessions` changes which session is active;
- provider/model selection is retained and model context is rebuilt from canonical history.

Do not claim that a new copy of the selected session is created. The requested behavior continues the selected append-only file.

## Delivery order

1. Add shared session-directory parsing and discovery tests.
2. Add validated `ConversationState.replaceSession()` and navigator tests.
3. Extract/reuse selector infrastructure and add session row/TTY tests.
4. Add `/sessions` orchestration to `runRepl()`.
5. Wire navigator/UI in `main()`.
6. Update README and unknown-command output.
7. Run all tests/typecheck and perform the manual parent-link check.

## Acceptance criteria

The feature is complete when:

- `/sessions` displays the current workspace's numbered sessions in deterministic numeric order.
- Keyboard navigation, confirmation, cancellation, scrolling, and terminal restoration work in a TTY.
- Selecting a session atomically replaces canonical context and rebuilds the active provider adapter.
- The next user event is persisted in the selected file with its parent equal to the selected session's active leaf.
- Persisted checkout heads are honored, so abandoned `/tree` branches do not re-enter context.
- The previous session is not modified after switching.
- `/sessions` is never persisted or sent to a provider.
- Corrupt or out-of-workspace selections cannot partially switch state.
- Existing `/tree`, `/model`, auth, provider, resume, and tool behavior remains intact.
- `bun test` and `bun run typecheck` pass.
