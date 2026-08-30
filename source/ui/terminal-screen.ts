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
      this.output.write("\x1b[?1049h\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H");
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  render(frame: Frame): void {
    if (!this.started || this.disposed) return;
    let writes = "\x1b[?25l";
    const count = Math.max(this.previous.length, frame.lines.length);
    for (let index = 0; index < count; index += 1) {
      const line = frame.lines[index] ?? "";
      if (line !== this.previous[index]) writes += `\x1b[${index + 1};1H\x1b[2K${line}\x1b[0m`;
    }
    if (frame.cursor) writes += `\x1b[${frame.cursor.row};${frame.cursor.column}H\x1b[?25h`;
    this.output.write(writes);
    this.previous = [...frame.lines];
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.started) {
      this.input.off("keypress", this.handleKeypress);
      this.output.off("resize", this.handleResize);
      try { this.input.setRawMode?.(this.wasRaw); } catch { /* best-effort restoration */ }
      try { this.output.write("\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l"); } catch { /* output may already be closed */ }
      if (!this.wasRaw) { try { this.input.pause(); } catch { /* input may already be closed */ } }
    }
  }

  private handleKeypress = (text: string, key: TerminalKey): void => { this.onKey?.(text, key); };
  private handleResize = (): void => { this.previous = []; this.onResize?.(this.columns, this.rows); };
}
