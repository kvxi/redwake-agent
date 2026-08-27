// Parses args, resolves the working directory, and runs the interactive agent.
import { createInterface } from "node:readline/promises";
import { chdir, stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { modelFor, PROVIDER, type Provider } from "./config.ts";
import { createAgentFactory, type ProviderAgentFactory } from "./agent/factory.ts";
import { createToolContext } from "./tools/context.ts";
import { createSessionStore, SessionStore } from "./session/store.ts";
import { ConversationState } from "./session/conversation-state.ts";

export interface ReplIO {
  /** Prompt for a line; resolves to null at end-of-input. */
  question(prompt: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
}

export interface ReplOptions {
  provider: Provider;
  createAgent: ProviderAgentFactory;
  modelFor: (provider: Provider) => string;
}

const USER_INPUT_STYLE = "\x1b[1;36m";
const RESET_STYLE = "\x1b[0m";


/**
 * Interactive read-eval loop. Exits on a blank line or end-of-input without
 * issuing a model call. Slash commands execute locally and are never sent to a
 * provider.
 */
export async function runRepl(
  options: ReplOptions,
  io: ReplIO,
): Promise<void> {
  let provider = options.provider;
  let agent = options.createAgent(provider);

  const question = async (prompt: string): Promise<string | null> => {
    const answer = await io.question(`${USER_INPUT_STYLE}${prompt}`);
    io.write(RESET_STYLE);
    return answer;
  };

  try {
    while (true) {
      const userMessage = await question("> ");
      if (!userMessage) return;

      if (userMessage === "/model") {
        const choice = await question(
          `Provider [anthropic/openai] (current: ${provider}): `,
        );
        if (!choice) {
          io.write("Model selection canceled.\n");
          continue;
        }

        const selected = choice.trim().toLowerCase();
        if (selected !== "anthropic" && selected !== "openai") {
          io.write("Invalid provider. Choose anthropic or openai.\n");
          continue;
        }

        if (selected === provider) {
          io.write(`Already using ${provider} with ${options.modelFor(provider)}. Conversation retained.\n`);
          continue;
        }
        provider = selected;
        agent = options.createAgent(provider);
        io.write(
          `Switched to ${provider} using ${options.modelFor(provider)}. ` +
            "Conversation retained.\n",
        );
        continue;
      }

      if (userMessage.startsWith("/")) {
        io.write(`Unknown command: ${userMessage}. Available commands: /model\n`);
        continue;
      }

      await agent.runTurn(userMessage);
    }
  } finally {
    io.close();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const resumeIndex = args.indexOf("--resume");
  let resumePath: string | undefined;
  if (resumeIndex >= 0) {
    resumePath = args[resumeIndex + 1];
    if (!resumePath) throw new Error("--resume requires a session JSONL path");
    resumePath = resolve(resumePath);
    args.splice(resumeIndex, 2);
  }
  const cwd = args[0];
  if (cwd) chdir(cwd);

  const store = resumePath
    ? new SessionStore(resumePath)
    : createSessionStore();
  const initialEvents = resumePath ? store.load() : [];
  stdout.write(`Session: ${store.path}${resumePath ? ` (resumed ${initialEvents.length} events)` : ""}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  const io: ReplIO = {
    question: (prompt) => rl.question(prompt).catch(() => null),
    write: (text) => stdout.write(text),
    close: () => rl.close(),
  };
  const conversation = new ConversationState(store, initialEvents);
  const createAgent = createAgentFactory({
    ctx: createToolContext(),
    conversation,
  });
  await runRepl({ provider: PROVIDER, createAgent, modelFor }, io);
}
