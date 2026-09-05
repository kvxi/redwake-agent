# Ctrl-C Model-Turn Interruption Plan

## Goal

Allow a user to press **Ctrl-C** while the agent is thinking, streaming a response, retrying a model request, or otherwise processing the current model turn. The current prompt should stop, the UI should return to an idle input prompt, and no additional tool calls from that turn should begin.

Preserve the canonical history of what actually happened: retain the submitted user message, every complete accepted assistant response, and every tool invocation/result that completed. Record the cancellation as a typed interruption event so a rebuilt agent knows that the prior turn was stopped. Ctrl-C is execution control, not an implicit retry, edit, or history branch.

This is intentionally a lightweight cancellation path. It does not need to terminate a tool that is already running; if Ctrl-C arrives during a tool, let that invocation settle, record its result, append the interruption event, and stop before the next tool or model request.

## Existing behavior to preserve

- `TuiApp` already recognizes Ctrl-C in raw mode and forwards it through `ReplIO.setInterruptHandler()` when no editor prompt is active.
- Ctrl-C in a list/tree/session overlay continues to close the overlay.
- A single Ctrl-C must never quit the app merely because no model turn is active. Quitting from the top-level message prompt requires a deliberate second Ctrl-C.
- OAuth login already installs a temporary interrupt handler backed by an `AbortController`; model turns should use the same temporary-handler pattern without changing login behavior.
- Non-cancellation provider and tool errors must continue to propagate normally.
- Existing `/tree` branching remains an explicit user action. Interrupting a turn must not move the active session head or abandon records automatically.

## Implementation

### 1. Make model turns signal-aware

Update `source/agent/conversation.ts` so `Conversation.runTurn` accepts an optional `AbortSignal`:

```ts
runTurn(userMessage: string, signal?: AbortSignal): Promise<void>;
```

Thread that signal through the provider-independent lifecycle in `source/agent/base.ts`:

- Change the abstract `request()` method to accept an optional signal.
- Change `runTurn()` to accept the signal and pass it to every provider request.
- Check `signal.aborted` at safe boundaries:
  - before starting each model request;
  - immediately after a model response resolves and before processing its tool calls;
  - before starting each individual tool call;
  - after a completed tool call has had its result recorded, before starting another tool or another model request.
- On that cancellation path, append one canonical `turn_interrupted` event after all already-completed work and before leaving the turn.
- Keep `turn_end` in the existing `finally` block so interruption always resets progress/TUI activity to `idle`.

Use `signal.throwIfAborted()` where available (or a small equivalent helper) so cancellation follows one consistent exception path. Structure the catch narrowly: append the interruption marker only when the supplied signal is actually aborted, then rethrow the cancellation for the REPL to handle.

The post-response check is important even when an SDK cannot cancel promptly: a response that races with Ctrl-C must not be allowed to launch tools.

### 2. Stop between tool calls without corrupting recorded history

Update `AgentBase.executeToolCalls()` to accept the same optional signal.

For an already-running tool, do not attempt deep cancellation in this feature. Let it finish, emit `tool_finish`, append its canonical `tool_result`, and then honor the abort before processing the next call. Checking only after recording the current result avoids leaving a persisted `tool_call` without its result solely because Ctrl-C arrived during execution.

If cancellation leaves provider-specific in-memory response state incomplete (for example, a response declared several function calls but only an earlier one ran), discard that agent instance at the REPL boundary. The next prompt should create a fresh agent from `ConversationState`, whose history conversion flattens persisted events into safe user/assistant text.

### 3. Record interruption without rewriting history

Extend `SessionEvent` in `source/session/conversation-state.ts` with a provider-independent marker:

```ts
{ type: "turn_interrupted" }
```

Keep this as a distinct event rather than storing a fabricated user or assistant message. Update `isSessionEvent()`, tree rendering, and any exhaustive event switches for the new type.

`AgentBase.runTurn()` should append this marker exactly once when it exits through the supplied signal's cancellation path. Append it only after any already-running tool has settled and its canonical `tool_result` has been recorded. Do not append it for an unrelated provider/tool error, and do not append it after a normally completed turn. Keep marker creation in the provider-independent turn lifecycle, which has direct access to `ConversationState` and can order it correctly relative to tool results; the REPL should only decide whether cancellation is handled for the UI.

The post-request abort check should happen before `remember()` and before canonical assistant text is appended. Thus, a complete response that loses the response/Ctrl-C race is treated like incomplete streamed output: it may already be visible as best-effort UI output, but it is not accepted into canonical history and cannot launch tools. Once a complete response has been accepted, retain it even if interruption occurs later during its tools.

Update `source/agent/history.ts` so the marker gives a freshly constructed agent concise context such as:

```text
[Assistant turn interrupted by the user before completion. Do not continue it unless the user's next message asks you to.]
```

Render that synthetic transport context in the assistant role so the next real user message follows it cleanly across providers, while retaining the typed marker—not fabricated message text—in canonical storage. Update `source/session/tree-ui.ts` and `TuiApp.setConversation()` to show a short inert row such as `interrupted: turn stopped by user`.

Also add a presentation-only `turn_interrupted` progress event in `source/agent/progress.ts`. Emit it after the canonical marker is appended and before the existing `turn_end`. In `TuiApp.handleProgress()`, use it to mark the current live assistant block as interrupted (for example, with an `interrupted` flag rendered as a dim `[interrupted]` suffix); do not convert that partial block into canonical assistant history. In `ProgressRenderer`, stop transient output and establish a clean line boundary; the REPL's `Interrupted.` warning remains the plain-mode confirmation. If no partial assistant block exists, the TUI need not create one solely for this event because the warning notice and canonical marker already represent it.

Do **not** call `branchTo()` on interruption. The submitted request and completed work remain on the active path, since tool side effects cannot be rolled back and hiding their records would make later reasoning inaccurate. Retry/edit behavior remains an explicit `/tree` (or future dedicated retry) action.

### 4. Pass the signal to each model transport

Update each provider implementation:

- `source/agent/anthropic.ts`
  - Pass `{ signal }` as the request options for both `messages.stream(...)` and the non-streaming `messages.create(...)` compatibility path.
- `source/agent/openai.ts`
  - Pass `{ signal }` as the request options to `responses.create(...)`.
  - The async stream loop should naturally reject when the request is aborted; the base lifecycle still supplies the post-request safety check.
- `source/agent/codex.ts`
  - Pass the signal to `CodexTransport.createResponse(...)`.
- `source/codex/transport.ts`
  - No major redesign should be needed because it already accepts a signal, supplies it to `fetch`, stops retrying when aborted, and makes retry delays abortable. Verify that stream cancellation surfaces through `createResponse()` as an abort rather than being converted into a retry.

Keep public helper methods such as `createMessage()` and `createResponse()` source-compatible by making any new signal argument optional.

### 5. Own turn cancellation in the REPL

Wrap the model call at `source/main.ts` around the existing `await ensureAgent().runTurn(userMessage)` site:

1. Create one `AbortController` for the submitted turn.
2. Install a temporary `io.setInterruptHandler` that marks the turn as interrupted and aborts the controller. Make repeated Ctrl-C presses idempotent.
3. Call `runTurn(userMessage, controller.signal)`.
4. Catch only cancellation associated with this controller. Emit a short warning notice such as `Interrupted.` and continue the REPL instead of closing it.
5. Do not swallow unrelated `AbortError`-shaped provider failures unless this turn's controller was actually aborted.
6. In `finally`, clear the interrupt handler so Ctrl-C cannot abort an old turn after the next input prompt appears.
7. After interruption, clear the cached `agent` so the next prompt rebuilds provider-local history from canonical conversation state.
8. Refresh the runtime event count after either completion or interruption, since the user prompt, completed tool work, and the interruption marker may already have been persisted.

The handler should be active for the whole turn, not inferred from rendered text. This covers `thinking`, streamed response/reasoning, retries/status messages, and gaps between model/tool phases while avoiding stale UI-state races.

### 6. Add an explicit double-Ctrl-C exit policy

The existing TUI treats Ctrl-C in the top-level message editor as a canceled `readLine()`, which returns `null` and causes `runRepl()` to exit. That must change now that Ctrl-C also means “interrupt the active turn.”

Use a short, documented confirmation window (for example, 1.5 seconds):

- At the top-level message prompt, the first Ctrl-C arms exit, keeps the prompt active, and displays `Press Ctrl-C again to exit.`
- A second Ctrl-C within the window resolves the prompt as `null`, allowing the existing REPL shutdown path to run.
- If the window expires, the next Ctrl-C is another first press.
- Normal typing, submitting a prompt, opening/canceling an overlay, or beginning a model turn clears the armed-exit state.
- Ctrl-C during an active model turn only interrupts that turn. It must not count as the first press of an exit sequence; once the prompt returns, quitting still requires two deliberate presses.
- Ctrl-C in a choice prompt or overlay remains a local cancellation action rather than an exit-arm action. If a startup flow decides to end after that cancellation, that is flow cancellation rather than the top-level quit shortcut.

Keep this state in the terminal IO implementation rather than in `AgentBase`; it is input policy, not model lifecycle. Avoid a free-running timeout if possible by storing the first-press timestamp and comparing it on the next key event. This also avoids timer cleanup issues during `close()`.

### 7. Support terminal input modes

#### TUI

No new key parser is required in `source/ui/tui-app.ts`; its raw-mode Ctrl-C recognition and operation forwarding already work. Extend `handleKey()` with this precedence:

1. cancel an active overlay;
2. cancel a non-message choice prompt;
3. interrupt the active operation when an interrupt handler is installed and no prompt is active;
4. at the top-level message prompt, apply the double-Ctrl-C exit policy;
5. otherwise process editor/navigation input normally.

The first exit press should not resolve `pending`, clear the user's draft, or hide the editor. Render the confirmation as a warning notice or dedicated transient status without recursively changing input ownership.

Optionally tighten the existing comment on `ReplIO.setInterruptHandler` in `source/main.ts` so it describes any active cancellable operation, not only OAuth.

#### Plain/debug mode

Implement `setInterruptHandler()` in `source/ui/plain-repl-io.ts` so Ctrl-C during a model turn invokes the temporary handler instead of terminating the process. Attach the SIGINT/readline listener while needed and remove it in `close()` to avoid leaks or duplicate callbacks.

Apply the same double-Ctrl-C rule while the top-level message input is active. Because Node readline and OS SIGINT handling differ between TTY and piped input, centralize the first/second-press decision in `PlainReplIO` and ensure only the confirmed second press closes/resolves the prompt. Preserve single-press cancellation for choice prompts. Clear the armed state when an operation handler is installed, so a turn interruption can never accidentally become half of an exit gesture.

## User-visible behavior

- The submitted user message, accepted complete assistant output, and completed tool activity remain on the active session path; interruption does not roll back or implicitly branch already-persisted events.
- Canonical history ends the stopped turn with a typed `turn_interrupted` event, and a rebuilt agent receives concise context that the user stopped the prior turn and it should not resume automatically.
- Any incomplete streamed assistant text may remain visible in the current transcript as best-effort output and should be visibly marked as interrupted, but it is not added as a canonical assistant message.
- The progress lifecycle emits `turn_end`, making the status idle before the next prompt.
- A warning notice (`Interrupted.`) confirms that Ctrl-C was handled.
- At the idle top-level prompt, one Ctrl-C displays `Press Ctrl-C again to exit.` and leaves the app running; only a timely second press exits.
- Interrupting a turn does not arm the double-press exit sequence.
- No tool call that had not started at the time cancellation was observed should run.
- A tool already in progress may finish; this limitation should be documented as intentional scope rather than presented as full process cancellation.

## Tests

### Input and exit behavior (`tests/tui-app.test.ts`, `tests/repl.test.ts`)

- At an idle top-level message prompt, assert the first Ctrl-C leaves `readLine()` pending and renders the exit hint.
- Assert a second Ctrl-C within the confirmation window resolves `readLine()` as `null` and lets the REPL close.
- Assert an expired first press does not make a later single press exit.
- Assert typing/submitting between presses disarms exit and preserves the user's draft after the first press.
- Assert Ctrl-C during a turn calls the interrupt handler exactly once, does not resolve an unrelated prompt, and does not arm exit after the turn.
- Preserve coverage that one Ctrl-C cancels overlays and non-message choice prompts.
- Add equivalent plain-mode/SIGINT coverage, including listener removal on handler clear and `close()`.

### Agent lifecycle (`tests/base.test.ts`)

Add deterministic tests using a fake agent and controlled promises/signals:

- abort while a model request is pending and assert `runTurn` rejects through cancellation, appends exactly one canonical `turn_interrupted` event after the user event, and emits the interruption progress event before `turn_end`;
- abort after a response resolves but before response acceptance/tool execution and assert no assistant message or tool call is persisted before the interruption marker;
- abort during the first of multiple tool calls and assert the first result is recorded, the interruption marker follows that result, and the second tool and follow-up request do not run;
- verify repeated abort attempts still produce only one interruption marker;
- verify a non-aborted turn retains the existing request/tool/request loop and does not append an interruption marker;
- verify an unrelated provider/tool error does not append an interruption marker.

If testing the exact response/abort race is awkward, expose it through a fake `request(signal)` that aborts the controller immediately before resolving.

### Canonical history and branching (`tests/history.test.ts`, `tests/session.test.ts`, `tests/tree-ui.test.ts`)

- validate persistence and reload of `turn_interrupted` events;
- verify provider history converts the typed event into concise assistant-role interruption context and that the following real user prompt remains a distinct user turn;
- verify tree/transcript formatting displays the interruption marker as inert status rather than fabricated assistant content;
- verify interruption leaves the active session head at the new marker and does not invoke checkout/branching or abandon the submitted user message and completed tool records;
- preserve explicit `/tree` behavior so selecting a user event can still branch and prefill that message when the user deliberately requests it.

### Provider propagation

- `tests/loop.test.ts`: verify the Anthropic client receives the supplied signal in request options for streaming and compatibility paths.
- `tests/openai.test.ts`: verify OpenAI receives the supplied signal and does not process tools after cancellation.
- `tests/codex.sse.test.ts` or a focused transport test: verify Codex receives the signal and an aborted request does not retry.

### REPL behavior (`tests/repl.test.ts`)

Add a fake IO that captures the installed interrupt handler and a fake agent whose turn remains pending until its signal aborts. Assert that:

- Ctrl-C aborts the signal;
- `runRepl` emits `Interrupted.` and asks for another prompt rather than exiting;
- the handler is cleared after the turn;
- the interrupted agent is discarded and a fresh one is constructed for the next submitted message;
- a normal provider error is not mislabeled as interruption.

### UI/input behavior (`tests/tui-app.test.ts`)

Retain the existing no-prompt Ctrl-C forwarding test and add/confirm coverage that:

- Ctrl-C at the active top-level message prompt follows the first-press/confirmed-second-press exit policy and does not invoke a stale turn handler;
- Ctrl-C in a choice prompt or overlay cancels/closes it and does not invoke the turn handler;
- `turn_end` following interruption leaves `activity.kind === "idle"`;
- the interruption progress event marks a live partial assistant block as interrupted without promoting it to a canonical assistant message, and creates no empty assistant block when no text streamed.

Add a plain-IO test if practical to verify temporary SIGINT listener registration, invocation, cleanup, and no duplicate listener after multiple turns.

## Validation

Run:

```sh
bun test
bun run typecheck
```

Then manually verify with each provider in the TUI:

1. submit a prompt likely to request tools;
2. press Ctrl-C while the footer says `thinking` or while text is streaming;
3. confirm the activity returns to idle, `Interrupted.` appears, partial text is marked interrupted, no subsequent tool starts, and a new prompt can be submitted;
4. press Ctrl-C during a multi-tool sequence and confirm at most the currently-running tool completes and its result remains in history before the interruption marker;
5. inspect `/tree` and confirm the user request, completed work, and interruption marker remain on the active path without an automatic branch;
6. submit a corrective follow-up and confirm the rebuilt agent knows the prior turn was interrupted but does not resume it unless asked;
7. at the idle prompt, verify one Ctrl-C shows the exit hint and two prompt Ctrl-C presses within the confirmation window quit;
8. repeat interruption and double-press exit checks in `--no-tui` mode.

## Out of scope

- Killing an already-running shell command or aborting filesystem tool handlers.
- Rolling back filesystem effects or session events from tools that completed before interruption.
- Provider-side recovery/resumption of a partial response.
- Pausing and later resuming the interrupted turn.
- Treating Ctrl-C as a branch/history-edit operation.
