// Parses args, resolves the working directory, and runs the interactive agent.
import { createInterface } from "node:readline/promises";
import { chdir, stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { modelFor, PROVIDER, type Provider } from "./config.ts";
import { createAgentFactory, type ProviderAgentFactory } from "./agent/factory.ts";
import { createToolContext } from "./tools/context.ts";
import { createSessionStore, SessionStore } from "./session/store.ts";
import { ConversationState, type ConversationEntry } from "./session/conversation-state.ts";
import { selectTreeNode } from "./session/tree-ui.ts";

export interface ReplIO {
  /** Prompt for a line; resolves to null at end-of-input. */
  question(prompt: string, initialText?: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
  showTree?(entries: readonly ConversationEntry[]): Promise<number | null>;
}

export interface BranchableConversation {
  entries(): ReadonlyArray<ConversationEntry>;
  branchTo(index: number | null): boolean;
}

export interface ReplOptions {
  provider: Provider;
  createAgent: ProviderAgentFactory;
  modelFor: (provider: Provider) => string;
  conversation?: BranchableConversation;
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
  let pendingEditorText = "";

  const question = async (prompt: string, initialText?: string): Promise<string | null> => {
    const styledPrompt = `${USER_INPUT_STYLE}${prompt}`;
    const answer = initialText
      ? await io.question(styledPrompt, initialText)
      : await io.question(styledPrompt);
    io.write(RESET_STYLE);
    return answer;
  };

  try {
    while (true) {
      const prefill = pendingEditorText;
      pendingEditorText = "";
      const userMessage = await question("> ", prefill || undefined);
      if (userMessage === null) return;
      if (userMessage === "") {
        if (prefill) {
          io.write("Message discarded; branch kept.\n");
          continue;
        }
        return;
      }

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

      if (userMessage === "/tree") {
        if (!options.conversation || !io.showTree) {
          io.write("Session tree is not available in this session.\n");
          continue;
        }
        const entries = options.conversation.entries();
        if (entries.length === 0) {
          io.write("Session tree is empty.\n");
          continue;
        }

        let index: number | null;
        try {
          index = await io.showTree(entries);
        } catch {
          index = null;
        }
        if (index === null) {
          io.write("Branch canceled.\n");
          continue;
        }
        const selected = entries.find((entry) => entry.index === index);
        if (!selected) {
          io.write("Could not branch: session history is inconsistent.\n");
          continue;
        }
        const branchIndex = selected.event.type === "user"
          ? (index === 0 ? null : index - 1)
          : index;
        if (!options.conversation.branchTo(branchIndex)) {
          io.write("Could not branch: session history is inconsistent.\n");
          continue;
        }
        if (selected.event.type === "user") pendingEditorText = selected.event.content;
        agent = options.createAgent(provider);
        io.write(branchIndex === null
          ? "Branched to the start of the session.\n"
          : `Branched to session entry ${branchIndex + 1}.\n`);
        continue;
      }

      if (userMessage.startsWith("/")) {
        io.write(`Unknown command: ${userMessage}. Available commands: /model, /tree\n`);
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
  const initialRecords = resumePath ? store.loadPathRecords() : [];
  const initialEvents = initialRecords.map((record) => record.event);
  stdout.write(`Session: ${store.path}${resumePath ? ` (resumed ${initialEvents.length} events)` : ""}\n`);

  const rl = createInterface({ input: stdin, output: stdout });
  const io: ReplIO = {
    question: (prompt, initialText) => {
      const answer = rl.question(prompt).catch(() => null);
      if (initialText) rl.write(initialText);
      return answer;
    },
    write: (text) => stdout.write(text),
    close: () => rl.close(),
  };
  if (stdin.isTTY) {
    io.showTree = (entries) => selectTreeNode(entries, {
      input: stdin,
      output: stdout,
      pause: () => rl.pause(),
      resume: () => rl.resume(),
    });
  }
  const conversation = new ConversationState(
    store,
    initialEvents,
    initialRecords.map((record) => record.id),
  );
  const createAgent = createAgentFactory({
    ctx: createToolContext(),
    conversation,
  });
  await runRepl({ provider: PROVIDER, createAgent, modelFor, conversation }, io);
}
