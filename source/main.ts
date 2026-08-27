// Parses args, resolves the working directory, and runs the interactive agent.
import { createInterface } from "node:readline/promises";
import { chdir, stdin, stdout } from "node:process";
import { PROVIDER } from "./config.ts";
import type { Conversation } from "./agent/conversation.ts";
import { AnthropicAgent } from "./agent/anthropic.ts";
import { OpenAIAgent } from "./agent/openai.ts";
import { createSessionStore } from "./session/store.ts";

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
): Promise<void> {
  try {
    while (true) {
      const userMessage = await io.question("> ");
      if (!userMessage) return;
      await agent.runTurn(userMessage);
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
  const agent =
    PROVIDER === "openai"
      ? new OpenAIAgent({ store })
      : new AnthropicAgent({ store });
  await runRepl(agent, io);
}
