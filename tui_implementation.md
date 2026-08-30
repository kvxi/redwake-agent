# Redwake TUI implementation plan

## Goal

Replace the TTY-only `readline` presentation with a lightweight, full-screen terminal UI while preserving the existing agent, provider, session, authentication, and slash-command behavior.

The first deliverable should provide:

- a responsive Redwake welcome card;
- a conversation viewport that scrolls independently of fixed bottom chrome;
- a bordered, single-line input region;
- a persistent activity/status bar;
- consistent color, typography, spacing, and box drawing;
- banners for notices, successes, and errors;
- integrated `/tree` and `/sessions` overlays;
- a stable plain-text fallback for non-TTY use and debugging.

This is a presentation and terminal-lifecycle change, not an agent-runtime rewrite. `runRepl` should remain responsible for command semantics and agent selection; the TUI should own terminal input, rendering, and presentation state.

## Current-state constraints

- `source/main.ts` currently combines argument parsing, startup diagnostics, `readline/promises`, command handling, session wiring, and progress-renderer setup.
- `ReplIO` is testable, but it exposes presentation as raw prompt strings and `write()` calls. ANSI styling currently leaks into `runRepl`.
- `ProgressRenderer` writes directly to stdout and owns a transient spinner. A full-screen renderer cannot safely share stdout with it.
- `/tree` and `/sessions` temporarily take raw-terminal ownership and paint directly. The full-screen TUI must instead own raw mode for its entire lifetime.
- `ConversationState` is canonical history. UI transcript blocks are derived presentation state and must not become a second source of truth for model context or persistence.
- There is no current runtime setting for reasoning effort. The status bar must not invent or hard-code a value such as `high`.
- `#` command palette, `!` shell shortcuts, update checks, and `/help` are not implemented. The welcome card must advertise only commands that actually exist.

## Architecture decisions

### 1. Use a small ANSI renderer, not a TUI framework

Use the alternate screen, raw key events, cursor positioning, and line-oriented frame diffing. Add one display-width dependency such as `string-width`; do not add a component framework.

This is sufficient for the requested fixed footer, prompt, responsive card, overlays, and streaming output. Mouse support, arbitrary panel docking, and multiline editing do not justify framework weight in this slice.

### 2. Keep TTY and plain modes separate

Select the presentation mode once during startup:

- `stdin.isTTY && stdout.isTTY && TERM !== "dumb"` and no override: full-screen TUI;
- non-TTY or `--no-tui`: stable line-oriented renderer without ANSI;
- `--debug`: line-oriented renderer plus internal startup diagnostics, including the full session path.

Normal operation must show the product-facing session name/number, not the `.jsonl` storage path. There should be one canonical `--debug` switch rather than synonymous flags.

### 3. Give one object exclusive terminal ownership

A `TerminalScreen` should be the only TTY code that:

- enters/exits the alternate screen;
- enables/restores raw mode;
- hides/shows and positions the cursor;
- listens for keypress and resize events;
- writes ANSI cursor-control sequences;
- restores terminal state in `finally`, including error and Ctrl-C exits.

`ProgressRenderer`, `selectListItem`, and command handlers must not write directly while the TUI is active.

### 4. Render from explicit presentation state

Use one mutable application state with controlled update methods and pure rendering functions. A practical initial shape is:

```ts
type Activity = "idle" | "thinking" | "responding" | "running";
type NoticeTone = "info" | "success" | "warning" | "error";

interface TuiState {
  identity: {
    provider: Provider;
    model: string;
    cwd: string;
    sessionName: string;
    sessionNumber?: number;
    eventCount: number;
    reasoning?: string; // Render only when backed by real runtime state.
  };
  activity: {
    kind: Activity;
    label?: string;
  };
  transcript: readonly TranscriptBlock[];
  input: {
    active: boolean;
    label: string;
    value: string;
    cursor: number;
  };
  overlay?: ListOverlayState;
  scrollOffset: number;
  followOutput: boolean;
  columns: number;
  rows: number;
}
```

Keep mutable buffers private to the controller and expose snapshots to renderers. Do not persist UI notices, spinner text, or tool summaries into `ConversationState`.

### 5. Make the REPL/UI boundary semantic

Replace prompt-string inference with structured requests. Evolve `ReplIO` toward:

```ts
interface InputRequest {
  kind: "message" | "choice";
  label: string;
  initialText?: string;
}

interface ReplIO {
  readLine(request: InputRequest): Promise<string | null>;
  append(message: { text: string; tone?: NoticeTone }): void;
  close(): void;
  showTree?(entries: readonly ConversationEntry[]): Promise<number | null>;
  showSessions?(sessions: readonly SessionSummary[]): Promise<string | null>;
}
```

A structured boundary lets the TUI append submitted chat messages to the visible transcript without treating model/provider choice answers as chat. The plain adapter can still render these operations as ordinary lines. Remove `USER_INPUT_STYLE`, reset writes, and all other UI ANSI from `runRepl`.

## File-level plan

### New UI modules

- `source/ui/tui-state.ts`
  - State, transcript-block, notice, activity, input, and overlay types.
  - State-transition helpers for identity, session, activity, notices, input, scrolling, and resize.
- `source/ui/terminal-text.ts`
  - ANSI stripping, display-width measurement, width-aware wrapping, middle path truncation, `$HOME` to `~` compaction, and safe single-line sanitization.
  - This becomes the shared replacement for the duplicated ANSI/clean/truncate helpers in session UIs.
- `source/ui/theme.ts`
  - The small semantic palette: primary, accent/current, secondary, border, warning, success, and error.
  - Respect `NO_COLOR`; never emit style sequences in plain mode.
- `source/ui/layout.ts`
  - Pure renderers for the welcome card, transcript blocks, banners, prompt, status bar, overlay, and complete frame.
  - Keep these renderers together initially; split by component only if the file becomes difficult to navigate.
- `source/ui/input-editor.ts`
  - Pure reducer for printable input, cursor movement, deletion, Home/End, Ctrl-A/E/U/K, Enter, Ctrl-C, Ctrl-D on empty input, and bracketed paste.
  - Initial scope is one logical line; embedded newlines from paste are normalized explicitly rather than accidentally submitting partial messages.
- `source/ui/terminal-screen.ts`
  - Alternate-screen/raw-mode lifecycle, resize subscription, key decoding, cursor placement, dirty-row frame diffing, and guaranteed restoration.
- `source/ui/tui-app.ts`
  - Implements `ReplIO`, owns `TuiState`, translates agent progress events, schedules renders, and resolves active input/overlay promises.
  - Batch streaming deltas into at most one render per frame and always flush the final state on `text_end`, `tool_finish`, and `turn_end`.
- `source/ui/plain-repl-io.ts`
  - Existing line-oriented behavior extracted from `main.ts` for non-TTY and debug modes.
- `source/ui/list-overlay.ts`
  - Shared overlay reducer/view model used by `/tree` and `/sessions`; no terminal I/O.

### Existing modules to change

- `source/main.ts`
  - Extract argument parsing for `--resume`, `--no-tui`, `--debug`, and optional working directory.
  - Build initial UI identity from the selected provider/model, `process.cwd()`, active `SessionSummary`, and event count.
  - Select `TuiApp` or `PlainReplIO` once.
  - Route the agent progress callback to `TuiApp.handleProgress()` in TUI mode and `ProgressRenderer.handle()` in plain mode.
  - Notify the UI after model switches, session switches, branches, and completed turns so footer metadata stays current.
  - Remove the unconditional full session-path startup line; emit it only in debug mode.
- `source/ui/progress-renderer.ts`
  - Retain only as the plain-mode progress sink.
  - Preserve current stable non-TTY output and remove assumptions that it can share a TTY with another renderer.
- `source/session/tree-ui.ts`
  - Keep the pure tree row builders, grouping, formatting, and selection reducer.
  - Move raw input and painting out. Adapt tree selection to the TUI list overlay.
  - Use shared width-aware text utilities so Unicode paths/content do not break frame width.
- `source/session/sessions-ui.ts`
  - Keep session-specific row formatting and selection values.
  - Use the same TUI list overlay and shared terminal text utilities.
- `source/agent/progress.ts`
  - Keep the provider-neutral event contract unless implementation reveals missing observable state. Prefer translating existing events in `TuiApp` over adding UI-specific agent events.
- `package.json` / `bun.lock`
  - Add only the display-width dependency and its lockfile change.
- `README.md`
  - Document TUI/plain-mode selection, `--no-tui`, `--debug`, input and scroll keys, persistent status meanings, and the fact that normal startup hides internal storage paths.
  - Update the current description of the bare `>` prompt.

## Implementation phases

### Phase 1 — Establish pure state and terminal text primitives

1. Add `tui-state.ts`, `terminal-text.ts`, and `theme.ts`.
2. Define transcript blocks for user text, assistant streaming text, tool activity/results, notices, and the welcome card.
3. Centralize ANSI stripping and width-aware truncation; remove duplicated helpers from `tree-ui.ts` and `sessions-ui.ts` as those files are migrated.
4. Add exact tests for:
   - `$HOME` compaction;
   - middle truncation of long paths;
   - ANSI-free width measurement;
   - wide Unicode and combining characters;
   - control-character removal;
   - activity and identity state transitions.

**Exit criteria:** All layout inputs are serializable/testable values; no rendering helper reads global process or terminal state.

### Phase 2 — Build responsive components and frame layout

1. Implement a compact single-line `REDWAKE` identity inside the startup card; avoid a large ASCII logo.
2. Implement the welcome card:
   - `>= 90` columns: model/provider and workspace/session arranged in two aligned columns;
   - narrower terminals: vertically stacked metadata;
   - very narrow terminals: compact unboxed form rather than malformed borders;
   - onboarding lists only supported commands, initially `/model`, `/tree`, `/sessions`, and `/status`.
3. Implement transcript and banner rendering using a restrained semantic palette:
   - cyan/blue for current/interactive state;
   - bold primary text for model and user content;
   - dim gray for metadata and borders;
   - yellow for warnings/notices;
   - green/red for success/error.
4. Implement the bordered prompt and persistent status bar. Footer content priority when width shrinks:
   1. activity;
   2. model;
   3. session;
   4. compact workspace;
   5. provider and optional reasoning.
5. Reserve fixed rows for prompt/footer and allocate the remainder to the transcript. The welcome card is a transcript block, so it naturally scrolls away; prompt and footer remain fixed.
6. Cache wrapping by block revision and terminal width so a streamed token does not rewrap every unchanged transcript block.

**Exit criteria:** Pure layout tests produce valid frames at 30, 60, 89, 90, and 120 columns; every rendered row fits its display width and contains no unterminated ANSI style.

### Phase 3 — Implement terminal lifecycle and input editing

1. Implement the input reducer independently from terminal I/O.
2. Implement `TerminalScreen.start()`, `render(frame)`, and `dispose()`:
   - save prior raw state;
   - enter alternate screen and enable bracketed paste;
   - render an initial complete frame;
   - update only dirty rows afterward;
   - place/show the cursor only while input is active;
   - restore styles, cursor, paste mode, alternate screen, listeners, and original raw state exactly once.
3. Handle terminal resize through one event source. Clamp every viewport dimension before rendering.
4. Add scroll controls: Page Up/Page Down move through transcript output, End returns to follow mode. New output auto-follows only when `followOutput` is true.
5. Define exit semantics matching the existing CLI:
   - Enter submits;
   - an empty submitted message exits only for the main message prompt;
   - Ctrl-D exits when the input is empty;
   - Ctrl-C cancels an overlay first and exits from the main prompt.

**Exit criteria:** Fake-stream lifecycle tests prove raw mode and the alternate screen are restored after normal exit, thrown errors, Ctrl-C, and repeated `dispose()` calls. Input reducer tests cover cursor edits, paste, prefills, and exit keys.

### Phase 4 — Integrate the REPL and streamed agent progress

1. Change `ReplIO` to the structured input/output contract and migrate every `runRepl` caller and test fake in one cutover.
2. Add `PlainReplIO` and prove that non-TTY output remains deterministic and ANSI-free.
3. Implement `TuiApp` as the TTY adapter:
   - `readLine()` activates the prompt and resolves on submission/cancellation;
   - a submitted `message` input becomes a user transcript block;
   - a submitted `choice` stays UI-local;
   - `append()` creates normal or banner transcript blocks;
   - agent progress events update a live assistant/tool block and footer activity.
4. Translate progress states consistently:
   - `request_start` -> `thinking`;
   - first `text_delta` -> `responding` and append/update the live assistant block;
   - `tool_start` -> `running`, with the existing safe tool summary;
   - `tool_finish` -> stable success/error tool row, then `thinking` until the next request/turn event;
   - `turn_end` -> `idle`, final render, and refreshed event count.
5. Keep `ProgressRenderer` only on the plain path. Never send one progress event to both renderers.
6. Add a small runtime-state observer from `runRepl` for successful model/provider and session changes. Do not parse human-readable command output to update the footer.
7. Convert existing command outcomes to semantic tones. Authentication/model/session errors become error banners; successful switches/login/logout become success or info banners.

**Exit criteria:** Existing slash-command behavioral tests still prove commands are local, selections rebuild the correct agent, branch prefills survive, and cancellation does not exit unexpectedly. New adapter tests prove status/footer state matches the same model and session transitions.

### Phase 5 — Move tree and session selection into overlays

1. Extract the reusable list selection state from the existing raw selector without changing tree grouping or branch semantics.
2. Render `/tree` and `/sessions` over the transcript viewport while retaining the persistent status bar.
3. Route Up/Down, Enter, Esc, and Ctrl-C to the active overlay before the input editor.
4. Preserve existing behavior:
   - `/tree` selects the correct event, branches at the correct parent, and prefills selected user text;
   - expandable tool groups update the overlay in place;
   - `/sessions` activates the selected append-only session and retains provider/model;
   - cancellation changes neither session nor conversation.
5. Remove the old selector's raw-mode toggling and direct cursor painting after both callers use the overlay.

**Exit criteria:** Existing tree/session reducer and integration tests pass through the overlay host; no module other than `TerminalScreen` calls `setRawMode` or emits cursor-positioning ANSI in TUI mode.

### Phase 6 — Startup, fallback, and responsive behavior

1. Replace the unconditional `Session: /absolute/path/...jsonl` output with initial state supplied to the welcome card.
2. Show a product-facing session label such as `session 46 · new` or `session 46 · 12 events`.
3. Add the persistent footer with live model/provider, workspace, session, and activity. Omit reasoning when unavailable.
4. Add `--no-tui` and `--debug` parsing without weakening `--resume` or working-directory behavior.
5. In debug mode, use plain output and include the full storage path and startup metadata. Never let debug writes corrupt the alternate screen.
6. Verify `NO_COLOR`, `TERM=dumb`, redirected stdin, redirected stdout, and small terminal heights. Plain mode must not emit box-control or ANSI escape sequences.

**Exit criteria:** Default TTY startup contains the welcome card and no absolute session storage path; debug startup contains the path; redirected execution remains readable and does not enter raw/alternate-screen mode.

### Phase 7 — Verification, documentation, and cleanup

1. Update `README.md` only after behavior is stable.
2. Run focused tests for state, text width, layout, input, terminal lifecycle, REPL, progress rendering, tree UI, and sessions UI.
3. Run `bun run typecheck` and the full `bun test` suite once after integration.
4. Launch the real CLI in a pseudo-terminal and verify:
   - wide and narrow startup layouts;
   - streamed assistant text and tool activity without flicker/corruption;
   - input editing and branch prefill;
   - Page Up/Page Down/End transcript navigation;
   - `/model`, `/status`, `/tree`, and `/sessions` transitions;
   - terminal resize during idle, streaming, and overlay display;
   - clean terminal restoration after blank input, Ctrl-D, Ctrl-C, and an induced agent error.
5. Search for and remove obsolete raw-mode ownership, duplicated ANSI regexes, startup `console`/`stdout` diagnostics, stale bare-prompt documentation, and dead compatibility paths.

**Exit criteria:** The actual TTY smoke scenario works end to end, focused and full checks pass, and terminal state is restored on every exercised exit path.

## Test plan

Add focused tests rather than ANSI snapshots of the entire application:

- `tests/terminal-text.test.ts`: sanitization, width, wrapping, path compaction/truncation.
- `tests/tui-layout.test.ts`: component hierarchy, width breakpoints, footer priority, banner tones, row bounds.
- `tests/input-editor.test.ts`: editing reducer and key semantics.
- `tests/terminal-screen.test.ts`: lifecycle, frame diff, resize, cursor placement, cleanup.
- `tests/tui-app.test.ts`: structured input, render scheduling, progress translation, activity and event-count updates.
- Update `tests/repl.test.ts`, `tests/progress-renderer.test.ts`, `tests/tree-ui.test.ts`, and `tests/sessions-ui.test.ts` for the clean interface cutover.

Prefer assertions on observable rows, state transitions, terminal writes, and cleanup invariants. Do not assert source text or internal helper call counts unless they represent exclusive terminal ownership or render batching.

## Acceptance checklist

- [ ] TTY startup is a full-screen application, not a sequence of diagnostic lines.
- [ ] The welcome card has clear hierarchy, restrained styling, whitespace, and consistent box drawing.
- [ ] The card switches layout at 90 columns and remains valid on very narrow terminals.
- [ ] Long workspace paths use `~` and middle truncation based on terminal display width.
- [ ] The input area is visually distinct and supports the existing branch prefill flow.
- [ ] The bottom status bar remains visible while the transcript and overlays change.
- [ ] Activity changes correctly among idle, thinking, responding, and running.
- [ ] Model/provider, session, event count, and workspace stay synchronized after commands.
- [ ] Unsupported `#`, `!`, update, and reasoning features are not advertised or fabricated.
- [ ] Exceptional command/runtime information uses info/success/warning/error banners.
- [ ] `/tree` and `/sessions` operate inside the TUI without nested raw-mode ownership.
- [ ] Streaming output is batched and does not redraw unchanged rows for every token.
- [ ] Normal mode hides internal session storage paths; debug mode exposes them in plain output.
- [ ] Non-TTY, `TERM=dumb`, `NO_COLOR`, `--no-tui`, and `--debug` paths remain readable.
- [ ] All exit/error paths restore raw mode, cursor visibility, bracketed paste, styles, and the original screen.

## Explicit non-goals for this slice

- Mouse interaction.
- Multiline editing or syntax-aware input.
- A `#` command palette or `!` shell-command language.
- Network update checks, token accounting, or git-status polling.
- Invented reasoning-effort state.
- Rendering full tool outputs; retain the current safe summaries.
- Replacing `ConversationState`, provider adapters, session persistence, or slash-command semantics.
- A heavyweight terminal component framework.

These can be added later against the state/renderer boundary without coupling them to the agent runtime.
