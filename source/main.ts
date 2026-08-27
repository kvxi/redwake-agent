// Parses args, resolves the working directory, and runs the interactive agent.
import { createInterface } from "node:readline/promises";
import { chdir, stdin, stdout } from "node:process";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";
import { Agent, type Conversation } from "./agent/loop.ts";
import { createSessionStore, type SessionStore } from "./session/store.ts";

export interface ReplIO {
  /** Prompt for a line; resolves to null at end-of-input. */
  question(prompt: string): Promise<string | null>;
  close(): void;
}

/**
 * Interactive read-eval loop. Exits on a blank line or end-of-input without
 * issuing a model call (mirrors the original run_cli contract).
 */
export async function runRepl(
  agent: Conversation,
  io: ReplIO,
  store?: SessionStore,
): Promise<void> {
  const messages: MessageParam[] = [];
  try {
    while (true) {
      const userMessage = await io.question("> ");
      if (!userMessage) return;
      const message: MessageParam = { role: "user", content: userMessage };
      messages.push(message);
      store?.append(message);
      await agent.runTurn(messages);
    }
  } finally {
    io.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cwd = argv[0];
  if (cwd) chdir(cwd);

  const store = createSessionStore();
  stdout.write(`Session: ${store.path}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  const io: ReplIO = {
    question: (prompt) => rl.question(prompt).catch(() => null),
    close: () => rl.close(),
  };
  await runRepl(new Agent({ store }), io, store);
}
