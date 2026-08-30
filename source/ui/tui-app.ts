import type { AgentProgressEvent } from "../agent/progress.ts";
import type { ConversationEntry } from "../session/conversation-state.ts";
import type { SessionSummary } from "../session/navigator.ts";
import { buildTreeRows, formatTreeDisplayRow, type TreeDisplayRow } from "../session/tree-ui.ts";
import { formatSessionRow } from "../session/sessions-ui.ts";
import type { InputRequest, ReplIO } from "../main.ts";
import { editInput, type EditorAction } from "./input-editor.ts";
import { renderFrame } from "./layout.ts";
import { reduceList, type ListKey, type ListState } from "./list-overlay.ts";
import { TerminalScreen, type TerminalKey } from "./terminal-screen.ts";
import { createTheme, type Theme } from "./theme.ts";
import { createTuiState, resizeState, updateActivity, updateIdentity, type NoticeTone, type TranscriptBlock, type TuiIdentity, type TuiState } from "./tui-state.ts";
import { formatDuration, summarizeToolCall, summarizeToolName } from "./tool-summary.ts";
import { stripAnsi } from "./terminal-text.ts";

interface ScreenHost { columns: number; rows: number; start(): void; render(frame: ReturnType<typeof renderFrame>): void; dispose(): void }
interface PendingInput { request: InputRequest; resolve: (value: string | null) => void }
interface PendingOverlay<T> { state: ListState<T>; rows: (item: T) => string; resolve: (value: T | null) => void; activate?: (item: T) => { items: readonly T[]; selected: number } | undefined }

export interface TuiAppOptions { identity: TuiIdentity; screen?: ScreenHost; theme?: Theme; color?: boolean }

export class TuiApp implements ReplIO {
  state: TuiState;
  private readonly screen: ScreenHost;
  private readonly theme: Theme;
  private pending?: PendingInput;
  private overlay?: PendingOverlay<unknown>;
  private nextId = 1;
  private liveAssistant?: number;
  private renderQueued = false;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(options: TuiAppOptions) {
    this.theme = options.theme ?? createTheme(options.color);
    this.state = createTuiState(options.identity);
    this.screen = options.screen ?? new TerminalScreen({
      onKey: (text, key) => this.handleKey(text, key),
      onResize: (columns, rows) => { this.state = resizeState(this.state, columns, rows); this.renderNow(); },
    });
    this.state = resizeState(this.state, this.screen.columns, this.screen.rows);
    this.screen.start();
    this.renderNow();
  }

  readLine(request: InputRequest): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.pending) throw new Error("A terminal input request is already active");
    this.state = { ...this.state, input: { active: true, label: request.label, value: request.initialText ?? "", cursor: request.initialText?.length ?? 0 } };
    this.renderNow();
    return new Promise((resolve) => { this.pending = { request, resolve }; });
  }

  append(message: { text: string; tone?: NoticeTone }): void {
    const text = message.text.replace(/\n+$/, "");
    if (!text) return;
    this.push({ id: this.nextId++, revision: 0, kind: "notice", text, tone: message.tone ?? "info" });
  }

  updateRuntime(patch: Partial<TuiIdentity>): void {
    this.state = updateIdentity(this.state, patch);
    this.renderNow();
  }

  handleProgress(event: AgentProgressEvent): void {
    switch (event.type) {
      case "request_start": this.liveAssistant = undefined; this.state = updateActivity(this.state, "thinking"); break;
      case "text_delta": {
        this.state = updateActivity(this.state, "responding");
        if (this.liveAssistant === undefined) {
          this.liveAssistant = this.nextId++;
          this.push({ id: this.liveAssistant, revision: 0, kind: "assistant", text: event.delta }, false);
        } else this.updateBlock(this.liveAssistant, (block) => block.kind === "assistant" ? { ...block, text: block.text + event.delta, revision: block.revision + 1 } : block);
        this.scheduleRender(); return;
      }
      case "text_end": this.liveAssistant = undefined; this.renderNow(); return;
      case "tool_start": this.state = updateActivity(this.state, "running", `running ${summarizeToolName(event.name)}`); this.push({ id: this.nextId++, revision: 0, kind: "tool", text: summarizeToolCall(event.name, event.input) }, false); break;
      case "tool_finish": this.push({ id: this.nextId++, revision: 0, kind: "tool", text: `${summarizeToolName(event.name)} (${formatDuration(event.durationMs)})`, tone: event.isError ? "error" : "success" }, false); this.state = updateActivity(this.state, "thinking"); break;
      case "status": this.state = updateActivity(this.state, "thinking", event.message); break;
      case "turn_end": this.liveAssistant = undefined; this.state = updateActivity(this.state, "idle"); this.renderNow(); return;
    }
    this.renderNow();
  }

  showTree(entries: readonly ConversationEntry[]): Promise<number | null> {
    const expanded = new Set<number>();
    let rows = buildTreeRows(entries, expanded);
    return this.showList<TreeDisplayRow>("Session tree", rows, (row) => stripAnsi(formatTreeDisplayRow(row, { width: Math.max(1, this.state.columns - 4) })), "↑/↓ navigate · enter expand/branch · esc cancel", (row) => {
      if (row.kind === "event") return undefined;
      if (expanded.has(row.startIndex)) expanded.delete(row.startIndex); else expanded.add(row.startIndex);
      rows = buildTreeRows(entries, expanded);
      return { items: rows, selected: rows.findIndex((item) => item.kind === "tool_group" && item.startIndex === row.startIndex) };
    }).then((row) => row?.kind === "event" ? row.entry.index : null);
  }

  showSessions(sessions: readonly SessionSummary[]): Promise<string | null> {
    return this.showList("Sessions", sessions, (session) => stripAnsi(formatSessionRow(session, { width: Math.max(1, this.state.columns - 4) })), "↑/↓ navigate · enter continue · esc cancel").then((item) => item?.path ?? null);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending?.resolve(null);
    this.overlay?.resolve(null);
    this.pending = undefined;
    this.overlay = undefined;
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.screen.dispose();
  }

  private showList<T>(title: string, items: readonly T[], rows: (item: T) => string, footer: string, activate?: PendingOverlay<T>["activate"]): Promise<T | null> {
    if (!items.length) return Promise.resolve(null);
    if (this.overlay) throw new Error("An overlay is already active");
    const rowCount = Math.max(1, this.state.rows - 8);
    const list: ListState<T> = { items, selected: items.length - 1, offset: Math.max(0, items.length - rowCount), rowCount };
    this.state = { ...this.state, overlay: { title, rows: items.map(rows), selected: list.selected, offset: list.offset, footer } };
    this.renderNow();
    return new Promise((resolve) => { this.overlay = { state: list, rows, resolve, activate } as PendingOverlay<unknown>; });
  }

  private handleKey(text: string, key: TerminalKey): void {
    if (this.overlay) { this.handleOverlayKey(key); return; }
    if (!this.pending) return;
    if (key.name === "pageup" || key.name === "pagedown" || key.name === "end") {
      if (key.name === "end") this.state = { ...this.state, followOutput: true, scrollOffset: 0 };
      else {
        const delta = Math.max(1, this.state.rows - 5);
        const scrollOffset = Math.max(0, this.state.scrollOffset + (key.name === "pageup" ? delta : -delta));
        this.state = { ...this.state, followOutput: scrollOffset === 0 && key.name === "pagedown", scrollOffset };
      }
      this.renderNow(); return;
    }
    const action = this.editorAction(text, key);
    if (!action) return;
    const edited = editInput(this.state.input, action);
    this.state = { ...this.state, input: { ...this.state.input, value: edited.value, cursor: edited.cursor } };
    if (edited.outcome) {
      const pending = this.pending;
      this.pending = undefined;
      this.state = { ...this.state, input: { ...this.state.input, active: false } };
      const answer = edited.outcome === "submit" ? edited.value : null;
      if (answer !== null && pending.request.kind === "message" && answer !== "") this.push({ id: this.nextId++, revision: 0, kind: "user", text: answer }, false);
      this.renderNow(); pending.resolve(answer); return;
    }
    this.renderNow();
  }

  private handleOverlayKey(key: TerminalKey): void {
    const name: ListKey | undefined = key.ctrl && key.name === "c" ? "escape" : key.name === "return" || key.name === "enter" ? "enter" : key.name === "escape" ? "escape" : key.name === "up" ? "up" : key.name === "down" ? "down" : key.name === "pageup" ? "page-up" : key.name === "pagedown" ? "page-down" : undefined;
    if (!name || !this.overlay) return;
    let next = reduceList(this.overlay.state, name);
    if (next.outcome === "confirm" && next.item !== undefined) {
      const update = this.overlay.activate?.(next.item);
      if (update) {
        next = { items: update.items, selected: update.selected, offset: Math.max(0, update.selected - next.rowCount + 1), rowCount: next.rowCount };
        this.overlay.state = next;
      } else { this.finishOverlay(next.item); return; }
    } else if (next.outcome === "cancel") { this.finishOverlay(null); return; }
    else this.overlay.state = next;
    this.state = { ...this.state, overlay: { ...this.state.overlay!, rows: next.items.map(this.overlay.rows), selected: next.selected, offset: next.offset } };
    this.renderNow();
  }

  private finishOverlay(value: unknown): void {
    const overlay = this.overlay!;
    this.overlay = undefined;
    this.state = { ...this.state, overlay: undefined };
    this.renderNow(); overlay.resolve(value);
  }

  private editorAction(text: string, key: TerminalKey): EditorAction | undefined {
    if (key.ctrl && key.name === "c") return { type: "cancel" };
    if (key.ctrl && key.name === "d") return { type: "eof" };
    if (key.ctrl && key.name === "a") return { type: "home" };
    if (key.ctrl && key.name === "e") return { type: "end" };
    if (key.ctrl && key.name === "u") return { type: "kill-start" };
    if (key.ctrl && key.name === "k") return { type: "kill-end" };
    if (key.name === "return" || key.name === "enter") return { type: "submit" };
    if (key.name === "left" || key.name === "right" || key.name === "home" || key.name === "end" || key.name === "backspace" || key.name === "delete") return { type: key.name } as EditorAction;
    if (text && !key.ctrl && !key.meta) return { type: "insert", text };
    return undefined;
  }

  private push(block: TranscriptBlock, render = true): void { this.state = { ...this.state, transcript: [...this.state.transcript, block] }; if (render) this.renderNow(); }
  private updateBlock(id: number, update: (block: TranscriptBlock) => TranscriptBlock): void { this.state = { ...this.state, transcript: this.state.transcript.map((block) => block.id === id ? update(block) : block) }; }
  private scheduleRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    this.renderTimer = setTimeout(() => {
      this.renderQueued = false;
      this.renderTimer = undefined;
      if (!this.closed) this.renderNow();
    }, 16);
  }
  private renderNow(): void {
    if (this.renderTimer !== undefined) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.renderQueued = false;
    if (!this.closed) this.screen.render(renderFrame(this.state, this.theme));
  }
}
