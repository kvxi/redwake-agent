import type { AgentProgressEvent } from "../agent/progress.ts";
import { formatDuration, summarizeToolCall, summarizeToolName } from "./tool-summary.ts";

export interface ProgressRendererOptions {
  write: (text: string) => void;
  isTTY: boolean;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLEAR_LINE = "\r\x1b[2K";

export class ProgressRenderer {
  private readonly write: (text: string) => void;
  private readonly isTTY: boolean;
  private readonly setTimer: typeof globalThis.setInterval;
  private readonly clearTimer: typeof globalThis.clearInterval;
  private timer?: ReturnType<typeof globalThis.setInterval>;
  private transient = false;
  private frame = 0;
  private lineOpen = false;
  private responseHasText = false;

  constructor(options: ProgressRendererOptions) {
    this.write = options.write;
    this.isTTY = options.isTTY;
    this.setTimer = options.setInterval ?? globalThis.setInterval;
    this.clearTimer = options.clearInterval ?? globalThis.clearInterval;
  }

  handle(event: AgentProgressEvent): void {
    switch (event.type) {
      case "request_start":
        this.responseHasText = false;
        if (this.isTTY) this.startSpinner("Thinking…");
        else this.progressLine("Thinking…");
        break;
      case "text_delta":
        this.stopTransient();
        this.write(event.delta);
        this.responseHasText = true;
        this.lineOpen = !event.delta.endsWith("\n");
        break;
      case "text_end":
        this.stopTransient();
        if (this.responseHasText && this.lineOpen) this.write("\n");
        this.lineOpen = false;
        break;
      case "tool_start":
        this.stopTransient();
        this.progressLine(`● ${summarizeToolCall(event.name, event.input)}`);
        if (this.isTTY) this.startSpinner(`Running ${summarizeToolName(event.name)}…`);
        break;
      case "tool_finish":
        this.stopTransient();
        this.progressLine(`${event.isError ? "✗" : "✓"} ${summarizeToolName(event.name)} (${formatDuration(event.durationMs)})`);
        break;
      case "status":
        this.stopTransient();
        this.progressLine(event.message);
        if (this.isTTY) this.startSpinner("Thinking…");
        break;
      case "turn_interrupted":
        this.stopTransient();
        this.ensureProgressBoundary();
        break;
      case "turn_end":
        this.stopTransient();
        this.ensureProgressBoundary();
        break;
    }
  }

  dispose(): void {
    this.stopTransient();
    this.ensureProgressBoundary();
  }

  private ensureProgressBoundary(): void {
    if (this.lineOpen) {
      this.write("\n");
      this.lineOpen = false;
    }
  }

  private progressLine(text: string): void {
    this.ensureProgressBoundary();
    this.write(`${text}\n`);
    this.lineOpen = false;
  }

  private startSpinner(label: string): void {
    this.stopTransient();
    this.ensureProgressBoundary();
    this.transient = true;
    this.frame = 0;
    const paint = () => {
      if (!this.transient) return;
      this.write(`${CLEAR_LINE}${FRAMES[this.frame++ % FRAMES.length]} ${label}`);
    };
    paint();
    this.timer = this.setTimer(paint, 80);
  }

  private stopTransient(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.transient) {
      if (this.isTTY) this.write(CLEAR_LINE);
      this.transient = false;
    }
  }
}
