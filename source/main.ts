// Parses args, resolves the working directory, and runs the interactive agent.
import { createInterface } from "node:readline/promises";
import { chdir, stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { modelFor, parseProvider, PROVIDER, PROVIDERS, type Provider } from "./config.ts";
import { createAgentFactory, type ProviderAgentFactory } from "./agent/factory.ts";
import { CodexAuthService, type AuthService } from "./auth/service.ts";
import { ModelCatalog, type ModelDescriptor } from "./codex/models.ts";
import { createToolContext } from "./tools/context.ts";
import { createSessionStore, SessionStore } from "./session/store.ts";
import { ConversationState, type ConversationEntry } from "./session/conversation-state.ts";
import { selectTreeNode } from "./session/tree-ui.ts";
import { SessionNavigator, type SessionSummary } from "./session/navigator.ts";
import { selectSession } from "./session/sessions-ui.ts";

export interface ReplIO {
  /** Prompt for a line; resolves to null at end-of-input. */
  question(prompt: string, initialText?: string): Promise<string | null>;
  write(text: string): void;
  close(): void;
  showTree?(entries: readonly ConversationEntry[]): Promise<number | null>;
  showSessions?(sessions: readonly SessionSummary[]): Promise<string | null>;
}

export interface BranchableConversation {
  entries(): ReadonlyArray<ConversationEntry>;
  branchTo(index: number | null): boolean;
}

export interface SessionNavigation {
  list(): SessionSummary[];
  activate(path: string): { status: "switched" | "already-active"; eventCount: number };
}

export interface ReplOptions {
  provider: Provider;
  createAgent: (provider: Provider) => ReturnType<ProviderAgentFactory>;
  modelFor: (provider: Provider) => string;
  conversation?: BranchableConversation;
  sessions?: SessionNavigation;
  auth?: AuthService;
  discoverCodexModels?: () => Promise<ModelDescriptor[]>;
}

const USER_INPUT_STYLE = "\x1b[1;31m";
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
  let model = options.modelFor(provider);
  // Codex starts lazily so an unauthenticated user can run /login first.
  let agent = provider === "openai-codex" ? undefined : options.createAgent(provider);
  let pendingEditorText = "";
  const rebuildAgent = () => { agent = provider === "openai-codex" ? (options.createAgent as ProviderAgentFactory)({ provider, model }) : options.createAgent(provider); };
  const ensureAgent = () => { if (!agent) rebuildAgent(); return agent!; };

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
          `Provider [${PROVIDERS.join("/")}] (current: ${provider}): `,
        );
        if (!choice) {
          io.write("Model selection canceled.\n");
          continue;
        }

        const selected = parseProvider(choice);
        if (!selected) {
          io.write(`Invalid provider. Choose ${PROVIDERS.join(" or ")}.\n`);
          continue;
        }
        let selectedModel = options.modelFor(selected);
        if (selected === "openai-codex") {
          if (!options.auth) { io.write("ChatGPT authentication is unavailable. Run /login openai-codex.\n"); continue; }
          const statuses = await options.auth.status();
          if (!statuses.some((entry) => !entry.disabled)) { io.write("Not authenticated. Run /login openai-codex.\n"); continue; }
          try {
            const models = await options.discoverCodexModels?.() ?? [];
            if (models.length) {
              const ids = models.map((entry) => entry.id);
              const answer = await question(`Model [${ids.join("/")}] (default: ${ids[0]}): `);
              if (answer?.trim() && !ids.includes(answer.trim())) { io.write("Invalid Codex model.\n"); continue; }
              selectedModel = answer?.trim() || ids[0]!;
            }
          } catch (error) { io.write(`Could not discover Codex models: ${error instanceof Error ? error.message : String(error)}\n`); continue; }
        }
        if (selected === provider && selectedModel === model) {
          io.write(`Already using ${provider} with ${model}. Conversation retained.\n`);
          continue;
        }
        provider = selected;
        model = selectedModel;
        rebuildAgent();
        io.write(`Switched to ${provider} using ${model}. Conversation retained.\n`);
        continue;
      }

      if (userMessage.startsWith("/login ") || userMessage.startsWith("/logout ") || userMessage.startsWith("/status ")) {
        const parts = userMessage.trim().split(/\s+/);
        const command = parts[0];
        if (parts[1] !== "openai-codex" || !options.auth) { io.write("Auth commands support only openai-codex.\n"); continue; }
        try {
          if (command === "/login") {
            const status = await options.auth.login(parts.includes("--device"), (message) => io.write(`${message}\n`));
            io.write(`Logged in: ${status.identity}${status.planType ? ` (${status.planType})` : ""}.\n`);
            if (provider === "openai-codex") rebuildAgent();
          } else if (command === "/logout") {
            const removed = await options.auth.logout(parts[2]);
            io.write(removed ? "Logged out.\n" : "Account not found.\n");
            if (provider === "openai-codex") agent = undefined;
          } else {
            const statuses = await options.auth.status();
            if (!statuses.length) io.write("No ChatGPT subscription accounts are logged in.\n");
            for (const status of statuses) io.write(`${status.identity}: ${status.disabled ? "disabled" : "ready"}${status.planType ? `, ${status.planType}` : ""}\n`);
          }
        } catch (error) { io.write(`${error instanceof Error ? error.message : String(error)}\n`); }
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
        rebuildAgent();
        io.write(branchIndex === null
          ? "Branched to the start of the session.\n"
          : `Branched to session entry ${branchIndex + 1}.\n`);
        continue;
      }

      if (userMessage === "/sessions") {
        if (!options.sessions || !io.showSessions) {
          io.write("Session selection is not available in this session.\n");
          continue;
        }
        let sessions: SessionSummary[];
        try {
          sessions = options.sessions.list();
        } catch (error) {
          io.write(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }
        if (sessions.length === 0) {
          io.write("No sessions found for this workspace.\n");
          continue;
        }
        let path: string | null;
        try {
          path = await io.showSessions(sessions);
        } catch {
          path = null;
        }
        if (path === null) {
          io.write("Session selection canceled.\n");
          continue;
        }
        try {
          const result = options.sessions.activate(path);
          if (result.status === "already-active") {
            io.write("That session is already active.\n");
            continue;
          }
          pendingEditorText = "";
          rebuildAgent();
          const name = sessions.find((session) => session.path === path)?.name ?? path;
          io.write(`Continued ${name} (${result.eventCount} events).\n`);
        } catch (error) {
          io.write(`Could not continue session: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }

      if (userMessage.startsWith("/")) {
        io.write(`Unknown command: ${userMessage}. Available commands: /model, /tree, /sessions, /login, /logout, /status\n`);
        continue;
      }

      await ensureAgent().runTurn(userMessage);
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
    const selectorIO = {
      input: stdin,
      output: stdout,
      pause: () => rl.pause(),
      resume: () => rl.resume(),
    };
    io.showTree = (entries) => selectTreeNode(entries, selectorIO);
    io.showSessions = (sessions) => selectSession(sessions, selectorIO);
  }
  const conversation = new ConversationState(
    store,
    initialEvents,
    initialRecords.map((record) => record.id),
  );
  const sessions = new SessionNavigator(conversation, store);
  const auth = new CodexAuthService();
  const createAgent = createAgentFactory({
    ctx: createToolContext(),
    conversation,
    credentials: auth.credentials,
  });
  const catalog = new ModelCatalog(auth.credentials, auth.store);
  await runRepl({ provider: PROVIDER, createAgent, modelFor, conversation, sessions, auth, discoverCodexModels: () => catalog.discover(true) }, io);
}
