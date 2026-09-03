import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import type { Frame } from "./layout.ts";

export interface TerminalKey { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string }
export interface TerminalScreenOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  onKey?: (text: string, key: TerminalKey) => void;
  onResize?: (columns: number, rows: number) => void;
}

export class TerminalScreen {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly onKey?: TerminalScreenOptions["onKey"];
  private readonly onResize?: TerminalScreenOptions["onResize"];
  private previous: string[] = [];
  private previousSoftWrapRows = new Set<number>();
  private started = false;
  private disposed = false;
  private wasRaw = false;

  constructor(options: TerminalScreenOptions = {}) {
    this.input = options.input ?? stdin;
    this.output = options.output ?? stdout;
    this.onKey = options.onKey;
    this.onResize = options.onResize;
  }

  get columns(): number { return Math.max(1, this.output.columns ?? 80); }
  get rows(): number { return Math.max(3, this.output.rows ?? 24); }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.wasRaw = Boolean(this.input.isRaw);
    try {
      emitKeypressEvents(this.input);
      this.input.setRawMode?.(true);
      this.input.resume();
      this.input.on("keypress", this.handleKeypress);
      this.output.on("resize", this.handleResize);
      // Ask compatible terminals for unambiguous modified-key sequences. In
      // particular, Ctrl-A is then delivered as CSI 97;5u instead of an
      // ambiguous legacy control byte. Unsupported terminals
      // safely ignore this progressive keyboard-protocol request.
      this.output.write("\x1b[?1049h\x1b[>1u\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  render(frame: Frame): void {
    if (!this.started || this.disposed) return;
    let writes = "\x1b[?25l";
    const count = Math.max(this.previous.length, frame.lines.length);
    const softWrapRows = new Set(frame.softWrapRows ?? []);
    for (let index = 0; index < count; index += 1) {
      const line = frame.lines[index] ?? "";
      // The preceding over-width line paints this row through terminal soft
      // wrapping. Writing or clearing it would split/erase a copied URL.
      if (softWrapRows.has(index)) continue;
      if (line !== this.previous[index] || this.previousSoftWrapRows.has(index)) writes += `\x1b[${index + 1};1H\x1b[2K${line}\x1b[0m`;
    }
    if (frame.cursor) writes += `\x1b[${frame.cursor.row};${frame.cursor.column}H\x1b[?25h`;
    this.output.write(writes);
    this.previous = [...frame.lines];
    this.previousSoftWrapRows = softWrapRows;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.input.off("keypress", this.handleKeypress);
      this.output.off("resize", this.handleResize);
      try { this.input.setRawMode?.(this.wasRaw); } catch { /* best-effort restoration */ }
      try { this.output.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[<u\x1b[?1049l"); } catch { /* output may already be closed */ }
      if (!this.wasRaw) { try { this.input.pause(); } catch { /* input may already be closed */ } }
    }
  }

  private handleKeypress = (text: string, key: TerminalKey): void => {
    // Node's readline parser does not currently decode the Kitty keyboard
    // protocol used by several modern terminals, so normalize its CSI-u form.
    const match = key.sequence?.match(/^\x1b\[(\d+)(?:;(\d+)(?::\d+)?)?u$/);
    if (match) {
      const codepoint = Number(match[1]);
      const modifiers = Number(match[2] ?? 1) - 1;
      if (Number.isSafeInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff) {
        const character = String.fromCodePoint(codepoint);
        const specialName = codepoint === 13 ? "return"
          : codepoint === 27 ? "escape"
          : codepoint === 9 ? "tab"
          : codepoint === 127 ? "backspace"
          : undefined;
        this.onKey?.(specialName ? "" : character, {
          ...key,
          name: specialName ?? (/^[A-Za-z]$/.test(character) ? character.toLowerCase() : key.name),
          shift: Boolean(modifiers & 1),
          meta: Boolean(modifiers & 2),
          ctrl: Boolean(modifiers & 4),
        });
        return;
      }
    }
    this.onKey?.(text, key);
  };
  private handleResize = (): void => { this.previous = []; this.onResize?.(this.columns, this.rows); };
}
