# TUI mouse cursor navigation implementation plan

Click-to-position is baseline TUI editor behavior rather than an optional or separately documented feature. It applies to the interactive TUI; the line-oriented `--no-tui` mode continues to use the terminal's normal line editor.

## 1. Add terminal mouse event support

**File:** `source/ui/terminal-screen.ts`

- Add a `TerminalMouseEvent` type containing:
  - 1-based terminal `row` and `column`
  - button/action information, including left-button press and wheel direction
  - modifier flags where available
- Add an `onMouse` callback to `TerminalScreenOptions`.
- Enable mouse reporting when the alternate screen starts:
  - basic button-event tracking (`CSI ?1000h`)
  - SGR extended coordinates (`CSI ?1006h`)
- Disable both modes during `dispose()`, alongside bracketed paste and keyboard protocol restoration.
- Parse SGR mouse reports such as `ESC [ < Cb ; Cx ; Cy M/m` before forwarding ordinary key events.
- Forward left-button presses to `onMouse`.
- Preserve transcript scrolling by translating reported wheel-up and wheel-down events into mouse events rather than relying only on terminals that synthesize arrow keys.
- Ignore unsupported buttons, movement reports, malformed sequences, and button releases for cursor movement.

## 2. Add input hit-testing based on the rendered layout

**File:** `source/ui/layout.ts`

- Refactor the existing private input layout calculations so rendering and mouse hit-testing share the same source of truth.
- Export a helper such as:

```ts
inputOffsetAt(
  state: TuiState,
  row: number,
  column: number,
): number | undefined
```

- Determine whether the click is on one of the currently visible input content rows, accounting for:
  - transcript viewport height
  - boxed versus compact input layout
  - top and side borders
  - the prompt label on the first row
  - wrapped and explicitly multiline input
  - `visibleStart` when a large prompt is showing a cursor-following window
- Convert the clicked display column to a UTF-16 string offset using grapheme segmentation and `displayWidth`.
- Clamp clicks before editable text to the row start and clicks after its text to the row end.
- Return `undefined` for clicks on the transcript, status line, box borders, hidden input rows, or outside the frame.
- Keep the resulting offset on a grapheme boundary. Define deterministic behavior for wide glyphs—for example, clicking the first display cell places the cursor before the glyph and clicking the second places it after.

## 3. Support direct cursor placement in the editor reducer

**Files:**
- `source/ui/input-editor.ts`
- `tests/input-editor.test.ts`

- Add an editor action such as:

```ts
{ type: "set-cursor"; cursor: number }
```

- Normalize the requested offset to the input bounds and a valid grapheme boundary.
- Clear any active selection when the cursor is placed by a click.
- Keep cursor mutation inside `editInput` rather than directly changing `TuiState`, preserving one path for editor invariants.

## 4. Wire mouse clicks into the TUI

**File:** `source/ui/tui-app.ts`

- Extend `ScreenHost` and screen integration with mouse support and pass `onMouse` when constructing `TerminalScreen`.
- Add `handleMouse(event)` to `TuiApp`.
- On a left-button press:
  - require an active `readLine` request
  - ignore the event while an overlay is open
  - use `inputOffsetAt` to resolve the clicked input position
  - apply the editor's `set-cursor` action
  - clear any selection through the reducer
  - render immediately so the terminal cursor visibly moves
- Keep clicks outside the input editor as no-ops; they must not submit, cancel, or alter the prompt.
- Handle wheel mouse events through the existing transcript scroll logic so explicit mouse reporting does not regress scrolling while typing or while the model is responding.
- Extract the current scroll calculation from `handleKey` into a shared method if needed so keyboard and mouse wheel events use identical behavior.

## 5. Add terminal protocol tests

**File:** `tests/terminal-screen.test.ts`

Add coverage that verifies:

- Startup writes include mouse tracking and SGR-coordinate enable sequences.
- Disposal writes include matching disable sequences exactly once.
- An SGR left-click report is decoded into the expected 1-based row and column.
- Press and release reports are distinguished; release does not trigger cursor movement.
- Wheel-up and wheel-down reports are decoded correctly.
- Malformed or unsupported mouse sequences do not become inserted input.
- Existing bracketed paste and Kitty keyboard decoding continue to work.

## 6. Add layout hit-testing tests

**File:** `tests/tui-layout.test.ts`

Cover cursor-offset mapping for:

- A single-line prompt, including clicks before the editable value, between characters, and after the final character.
- Wrapped input across multiple rows.
- Explicitly multiline pasted input.
- A long prompt where only a window of input rows is visible.
- Narrow terminals using the unboxed layout.
- Wide Unicode glyphs and combining graphemes.
- Input labels and box borders, confirming they either clamp appropriately or return `undefined` according to the chosen contract.
- Transcript and status-line clicks returning `undefined`.

Prefer testing the exported hit-testing helper directly so coordinate behavior is isolated from terminal parsing.

## 7. Add TUI integration tests

**File:** `tests/tui-app.test.ts`

Update `FakeScreen` as needed and add tests that verify:

- Clicking between characters moves `state.input.cursor`.
- Typing after the click inserts at the selected location.
- Clicking a wrapped or multiline row maps to the correct logical offset.
- Clicking after row text moves to that row's end.
- Clicking while a selection is active clears the selection.
- Clicking outside the input, with no pending input, or while an overlay is active does nothing.
- Mouse wheel scrolling still updates `followOutput` and `scrollOffset`.
- Secret prompts remain masked after clicking and editing.

## 8. Validation

Run:

```sh
bun test tests/input-editor.test.ts
bun test tests/terminal-screen.test.ts
bun test tests/tui-layout.test.ts
bun test tests/tui-app.test.ts
bun test
bun run typecheck
bun run build
```

## Acceptance criteria

- A user can click any visible position in the active TUI prompt and continue typing from that logical position.
- Wrapped, multiline, Unicode, and horizontally padded prompt content map correctly.
- Clicking outside the editor does not modify input.
- Existing keyboard editing, paste handling, overlays, transcript scrolling, and terminal cleanup continue to work.
- Mouse reporting is always disabled when the TUI exits, including error and repeated-disposal paths.
- Click-to-position works by default as part of normal TUI input behavior, with no feature flag or separate user-facing documentation requirement.
