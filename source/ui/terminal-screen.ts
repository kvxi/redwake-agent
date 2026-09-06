import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { PassThrough } from "node:stream";
import type { Frame } from "./layout.ts";

export interface TerminalKey { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string }
export interface TerminalMouseEvent {
  row: number;
  column: number;
  action: "press" | "release" | "wheel";
  button?: "left" | "middle" | "right";
  wheel?: "up" | "down";
  shift: boolean;
  meta: boolean;
  ctrl: boolean;
}
export interface TerminalScreenOptions {
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  onKey?: (text: string, key: TerminalKey) => void;
  onPaste?: (text: string) => void;
  onMouse?: (event: TerminalMouseEvent) => void;
  onResize?: (columns: number, rows: number) => void;
}

export class TerminalScreen {
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;
  private readonly onKey?: TerminalScreenOptions["onKey"];
  private readonly onPaste?: TerminalScreenOptions["onPaste"];
  private readonly onMouse?: TerminalScreenOptions["onMouse"];
  private readonly onResize?: TerminalScreenOptions["onResize"];
  private readonly keyInput = new PassThrough();
  private pendingMouse?: Buffer;
  private pendingMouseTimer?: ReturnType<typeof setTimeout>;
  private previous: string[] = [];
  private previousSoftWrapRows = new Set<number>();
  private started = false;
  private disposed = false;
  private wasRaw = false;
  private pasteBuffer?: string;

  constructor(options: TerminalScreenOptions = {}) {
    this.input = options.input ?? stdin;
    this.output = options.output ?? stdout;
    this.onKey = options.onKey;
    this.onPaste = options.onPaste;
    this.onMouse = options.onMouse;
    this.onResize = options.onResize;
  }

  get columns(): number { return Math.max(1, this.output.columns ?? 80); }
  get rows(): number { return Math.max(3, this.output.rows ?? 24); }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.wasRaw = Boolean(this.input.isRaw);
    try {
      emitKeypressEvents(this.keyInput);
      this.keyInput.on("keypress", this.handleKeypress);
      this.input.setRawMode?.(true);
      this.input.on("data", this.handleData);
      this.input.resume();
      this.output.on("resize", this.handleResize);
      // Ask compatible terminals to report all keys (including Enter) with
      // modifiers and associated text. Flag 1 alone deliberately leaves Enter
      // ambiguous in the Kitty protocol; flags 8 and 16 make Shift-Enter
      // distinguishable without losing the text produced by shifted keys.
      // Unsupported terminals safely ignore these protocol requests.
      this.output.write("\x1b[?1049h\x1b[>25u\x1b[>4;2m\x1b[?2004h\x1b[?1000h\x1b[?1006h\x1b[?25l\x1b[2J\x1b[H");
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
      this.input.off("data", this.handleData);
      this.keyInput.off("keypress", this.handleKeypress);
      this.keyInput.destroy();
      this.output.off("resize", this.handleResize);
      this.pasteBuffer = undefined;
      this.pendingMouse = undefined;
      if (this.pendingMouseTimer !== undefined) clearTimeout(this.pendingMouseTimer);
      this.pendingMouseTimer = undefined;
      try { this.input.setRawMode?.(this.wasRaw); } catch { /* best-effort restoration */ }
      try { this.output.write("\x1b[0m\x1b[?25h\x1b[?1006l\x1b[?1000l\x1b[?2004l\x1b[>4;0m\x1b[<u\x1b[?1049l"); } catch { /* output may already be closed */ }
      if (!this.wasRaw) { try { this.input.pause(); } catch { /* input may already be closed */ } }
    }
  }

  private handleData = (chunk: Buffer | string): void => {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.pendingMouseTimer !== undefined) clearTimeout(this.pendingMouseTimer);
    this.pendingMouseTimer = undefined;
    if (this.pendingMouse) {
      data = Buffer.concat([this.pendingMouse, data]);
      this.pendingMouse = undefined;
    }
    const mouseMarker = Buffer.from("\x1b[<");
    const shiftedReturns = [Buffer.from("\x1b[13;2u"), Buffer.from("\x1b[27;2;13~")];
    const markers = [mouseMarker, ...shiftedReturns];
    while (data.length) {
      const encoded = data.toString("latin1");
      const csiKey = encoded.match(/\x1b\[[\d:]+(?:;[\d:]*){0,2}u/);
      const csiStart = csiKey?.index ?? -1;
      const starts = [...markers.map((marker) => data.indexOf(marker)), csiStart].filter((index) => index >= 0);
      const start = starts.length ? Math.min(...starts) : -1;
      if (start < 0) {
        let partialLength = 0;
        for (const marker of markers) {
          for (let length = 1; length < marker.length && length <= data.length; length += 1) {
            if (data.subarray(-length).equals(marker.subarray(0, length))) partialLength = Math.max(partialLength, length);
          }
        }
        const partialCsi = encoded.match(/\x1b\[[\d:;]*$/);
        if (partialCsi?.index !== undefined) partialLength = Math.max(partialLength, data.length - partialCsi.index);
        if (partialLength) {
          if (data.length > partialLength) this.keyInput.write(data.subarray(0, -partialLength));
          this.holdMouse(data.subarray(-partialLength));
        } else this.keyInput.write(data);
        return;
      }
      if (start > 0) this.keyInput.write(data.subarray(0, start));
      if (csiStart === start && csiKey) {
        const sequence = csiKey[0];
        if (this.pasteBuffer !== undefined) this.pasteBuffer += sequence;
        else this.handleKeypress(undefined, { sequence });
        data = data.subarray(start + sequence.length);
        continue;
      }
      const shiftedReturn = shiftedReturns.find((sequence) => data.subarray(start, start + sequence.length).equals(sequence));
      if (shiftedReturn) {
        if (this.pasteBuffer !== undefined) this.pasteBuffer += shiftedReturn.toString();
        else this.onKey?.("", { name: "return", shift: true, meta: false, ctrl: false, sequence: shiftedReturn.toString() });
        data = data.subarray(start + shiftedReturn.length);
        continue;
      }
      let end = -1;
      for (let index = start + mouseMarker.length; index < data.length; index += 1) {
        if (data[index] === 0x4d || data[index] === 0x6d) { end = index; break; }
      }
      if (end < 0) {
        // Mouse reports are short. Bound buffering so malformed input cannot
        // retain an unbounded amount of terminal data.
        if (data.length - start <= 64) this.holdMouse(data.subarray(start));
        return;
      }
      this.decodeMouse(data.subarray(start, end + 1).toString());
      data = data.subarray(end + 1);
    }
  };

  private holdMouse(data: Uint8Array): void {
    this.pendingMouse = Buffer.from(data);
    this.pendingMouseTimer = setTimeout(() => {
      const pending = this.pendingMouse;
      this.pendingMouse = undefined;
      this.pendingMouseTimer = undefined;
      // A lone ESC/CSI prefix may be an ordinary keyboard sequence. An
      // incomplete SGR report is malformed terminal protocol and is dropped.
      if (pending && !pending.toString().startsWith("\x1b[<")) this.keyInput.write(pending);
    }, 10);
  }

  private decodeMouse(sequence: string): boolean {
    const mouse = sequence.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/);
    if (!mouse) return false;
    const code = Number(mouse[1]);
    const column = Number(mouse[2]);
    const row = Number(mouse[3]);
    if (Number.isSafeInteger(code) && column > 0 && row > 0 && !(code & 32)) {
      const modifiers = {
        shift: Boolean(code & 4),
        meta: Boolean(code & 8),
        ctrl: Boolean(code & 16),
      };
      if (code & 64) {
        const wheelCode = code & 3;
        if (wheelCode <= 1) this.onMouse?.({ row, column, action: "wheel", wheel: wheelCode === 0 ? "up" : "down", ...modifiers });
      } else {
        const buttonCode = code & 3;
        const button = buttonCode === 0 ? "left" : buttonCode === 1 ? "middle" : buttonCode === 2 ? "right" : undefined;
        if (button) this.onMouse?.({ row, column, action: mouse[4] === "m" ? "release" : "press", button, ...modifiers });
      }
    }
    return true;
  }

  private handleKeypress = (text: string | undefined, key: TerminalKey): void => {
    const sequence = key.sequence ?? text ?? "";
    if (key.name === "paste-start" || sequence === "\x1b[200~") {
      this.pasteBuffer = "";
      return;
    }
    if (key.name === "paste-end" || sequence === "\x1b[201~") {
      if (this.pasteBuffer !== undefined) {
        const pasted = this.pasteBuffer;
        this.pasteBuffer = undefined;
        this.onPaste?.(pasted);
      }
      return;
    }
    if (this.pasteBuffer !== undefined) {
      this.pasteBuffer += sequence;
      return;
    }

    // Decode SGR mouse reports before they can be treated as typed input.
    // Reports with unsupported buttons/motion are consumed but ignored.
    const mouseSequence = key.sequence ?? text ?? "";
    if (this.decodeMouse(mouseSequence) || mouseSequence.startsWith("\x1b[<")) return;

    // Node's readline parser does not currently decode the Kitty keyboard
    // protocol used by several modern terminals, so normalize its CSI-u form.
    const match = key.sequence?.match(/^\x1b\[([\d:]+)(?:;([\d:]*))?(?:;([\d:]+))?u$/);
    if (match) {
      const codepoint = Number(match[1]!.split(":")[0]);
      const modifiers = Number(match[2]?.split(":")[0] || 1) - 1;
      const associatedText = match[3]?.split(":").map(Number);
      const validText = associatedText?.every((point) => Number.isSafeInteger(point) && point >= 0 && point <= 0x10ffff);
      if (Number.isSafeInteger(codepoint) && codepoint >= 0 && codepoint <= 0x10ffff) {
        const character = validText && associatedText?.length
          ? String.fromCodePoint(...associatedText)
          : String.fromCodePoint(codepoint);
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
    this.onKey?.(text ?? "", key);
  };
  private handleResize = (): void => { this.previous = []; this.onResize?.(this.columns, this.rows); };
}
