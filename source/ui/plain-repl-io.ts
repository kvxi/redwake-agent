import { createInterface, type Interface } from "node:readline/promises";
import type { ReplIO, InputRequest } from "../main.ts";
import type { ConversationEntry } from "../session/conversation-state.ts";
import type { SessionSummary } from "../session/navigator.ts";
import { formatTreeRow } from "../session/tree-ui.ts";
import { formatSessionRow } from "../session/sessions-ui.ts";
import { stripAnsi } from "./terminal-text.ts";

export class PlainReplIO implements ReplIO {
  private readonly rl: Interface;
  constructor(
    input: NodeJS.ReadStream = process.stdin,
    private readonly output: NodeJS.WriteStream = process.stdout,
  ) {
    this.rl = createInterface({ input, output });
  }

  async readLine(request: InputRequest): Promise<string | null> {
    try {
      const prompt = request.label.endsWith(" ") ? request.label : `${request.label} `;
      const answer = this.rl.question(stripAnsi(prompt));
      if (request.initialText) this.rl.write(request.initialText);
      return await answer;
    } catch { return null; }
  }

  append(message: { text: string }): void {
    this.output.write(stripAnsi(message.text).replace(/\n?$/, "\n"));
  }

  async showTree(entries: readonly ConversationEntry[]): Promise<number | null> {
    entries.forEach((entry, index) => this.output.write(`${index + 1}. ${stripAnsi(formatTreeRow(entry)).trimStart()}\n`));
    const answer = await this.readLine({ kind: "choice", label: "Entry number (blank to cancel): " });
    const selected = Number(answer);
    return answer?.trim() && Number.isInteger(selected) && selected >= 1 && selected <= entries.length
      ? entries[selected - 1]!.index : null;
  }

  async showSessions(sessions: readonly SessionSummary[]): Promise<string | null> {
    sessions.forEach((session, index) => this.output.write(`${index + 1}. ${stripAnsi(formatSessionRow(session)).trimStart()}\n`));
    const answer = await this.readLine({ kind: "choice", label: "Session number (blank to cancel): " });
    const selected = Number(answer);
    return answer?.trim() && Number.isInteger(selected) && selected >= 1 && selected <= sessions.length
      ? sessions[selected - 1]!.path : null;
  }

  close(): void { this.rl.close(); }
}
