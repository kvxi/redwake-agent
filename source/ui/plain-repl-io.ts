import { createInterface, type Interface } from "node:readline/promises";
import type { ReplIO, InputRequest } from "../main.ts";
import type { ConversationEntry } from "../session/conversation-state.ts";
import type { SessionSummary } from "../session/navigator.ts";
import { formatTreeRow } from "../session/tree-ui.ts";
import { formatSessionRow, NEW_SESSION, type SessionSelection } from "../session/sessions-ui.ts";
import { stripAnsi } from "./terminal-text.ts";

const EXIT_CONFIRM_MS = 1_500;

export class PlainReplIO implements ReplIO {
  private readonly rl: Interface;
  private interruptHandler?: () => void;
  private active?: { request: InputRequest; controller: AbortController };
  private exitArmedAt?: number;
  private listenerAttached = false;
  private closed = false;

  private readonly onSigint = (): void => {
    if (this.active?.request.kind === "choice") {
      this.active.controller.abort();
      return;
    }
    if (this.active?.request.kind === "message") {
      const now = Date.now();
      if (this.exitArmedAt !== undefined && now - this.exitArmedAt <= EXIT_CONFIRM_MS) {
        this.exitArmedAt = undefined;
        this.active.controller.abort();
      } else {
        this.exitArmedAt = now;
        this.output.write("\nPress Ctrl-C again to exit.\n");
      }
      return;
    }
    this.interruptHandler?.();
  };

  private readonly onData = (chunk: Buffer | string): void => {
    // Normal input disarms an idle-prompt exit gesture. Do not disarm on the
    // Ctrl-C byte itself; readline turns that byte into SIGINT.
    if (!String(chunk).includes("\u0003")) this.exitArmedAt = undefined;
  };

  private updateInterruptListeners(): void {
    const needed = !this.closed && (this.active !== undefined || this.interruptHandler !== undefined);
    if (needed === this.listenerAttached) return;
    this.listenerAttached = needed;
    if (needed) {
      this.rl.on("SIGINT", this.onSigint);
      this.input.on("data", this.onData);
    } else {
      this.rl.off("SIGINT", this.onSigint);
      this.input.off("data", this.onData);
    }
  }

  constructor(
    private readonly input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.rl = createInterface({ input, output });
  }

  async readLine(request: InputRequest): Promise<string | null> {
    if (this.closed) return null;
    this.exitArmedAt = undefined;
    const controller = new AbortController();
    this.active = { request, controller };
    this.updateInterruptListeners();
    try {
      const prompt = stripAnsi(request.label.endsWith(" ") ? request.label : `${request.label} `);
      if (request.secret && this.input.isTTY && this.output.isTTY) {
        // readline has no public silent-question API. Suppress its terminal echo
        // while it collects the key, leaving only the prompt visible.
        const internal = this.rl as Interface & { _writeToOutput?: (text: string) => void };
        const write = internal._writeToOutput;
        this.output.write(prompt);
        if (write) internal._writeToOutput = () => {};
        try { return await this.rl.question("", { signal: controller.signal }); }
        finally { if (write) internal._writeToOutput = write; this.output.write("\n"); }
      }
      const answer = this.rl.question(prompt, { signal: controller.signal });
      if (request.initialText) this.rl.write(request.initialText);
      return await answer;
    } catch {
      return null;
    } finally {
      if (this.active?.controller === controller) this.active = undefined;
      this.exitArmedAt = undefined;
      this.updateInterruptListeners();
    }
  }

  setInterruptHandler(handler?: () => void): void {
    this.interruptHandler = handler;
    if (handler) this.exitArmedAt = undefined;
    this.updateInterruptListeners();
  }

  append(message: { text: string }): void {
    this.output.write(stripAnsi(message.text).replace(/\n?$/, "\n"));
  }

  async showTree(entries: readonly ConversationEntry[]): Promise<number | null> {
    this.exitArmedAt = undefined;
    entries.forEach((entry, index) => this.output.write(`${index + 1}. ${stripAnsi(formatTreeRow(entry)).trimStart()}\n`));
    const answer = await this.readLine({ kind: "choice", label: "Entry number (blank to cancel): " });
    const selected = Number(answer);
    return answer?.trim() && Number.isInteger(selected) && selected >= 1 && selected <= entries.length
      ? entries[selected - 1]!.index : null;
  }

  async showSessions(sessions: readonly SessionSummary[]): Promise<SessionSelection | null> {
    this.exitArmedAt = undefined;
    sessions.forEach((session, index) => this.output.write(`${index + 1}. ${stripAnsi(formatSessionRow(session)).trimStart()}\n`));
    this.output.write(`${sessions.length + 1}. new session\n`);
    const answer = await this.readLine({ kind: "choice", label: "Session number (blank to cancel): " });
    const selected = Number(answer);
    if (!answer?.trim() || !Number.isInteger(selected) || selected < 1 || selected > sessions.length + 1) return null;
    return selected === sessions.length + 1 ? NEW_SESSION : sessions[selected - 1]!.path;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.active?.controller.abort();
    this.active = undefined;
    this.interruptHandler = undefined;
    this.updateInterruptListeners();
    this.rl.close();
  }
}
