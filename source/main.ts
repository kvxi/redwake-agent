// Parses args, resolves the working directory, and runs the interactive agent.
import { chdir, stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { ensureStateDirectories, migrateLegacyState } from "./paths.ts";
import { modelFor, parseProvider, PROVIDER, PROVIDERS, type Provider } from "./config.ts";
import { createAgentFactory, type ProviderAgentFactory } from "./agent/factory.ts";
import { CodexAuthService, type AuthService } from "./auth/service.ts";
import { ModelCatalog, type ModelDescriptor } from "./codex/models.ts";
import { createToolContext } from "./tools/context.ts";
import { createSessionStore, SessionStore } from "./session/store.ts";
import { ConversationState, type ConversationEntry } from "./session/conversation-state.ts";
import { SessionNavigator, type SessionSummary } from "./session/navigator.ts";
import { ProgressRenderer } from "./ui/progress-renderer.ts";
import { PlainReplIO } from "./ui/plain-repl-io.ts";
import { TuiApp } from "./ui/tui-app.ts";
import type { NoticeTone, TuiIdentity } from "./ui/tui-state.ts";

export interface InputRequest {
  kind: "message" | "choice";
  label: string;
  initialText?: string;
}

export interface ReplIO {
  readLine(request: InputRequest): Promise<string | null>;
  append(message: { text: string; tone?: NoticeTone }): void;
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
  /** Overrides modelFor(provider) for a restored startup selection. */
  initialModel?: string;
  createAgent: ProviderAgentFactory;
  modelFor: (provider: Provider) => string;
  saveModelSelection?: (provider: Provider, model: string) => void;
  conversation?: BranchableConversation;
  sessions?: SessionNavigation;
  auth?: AuthService;
  discoverCodexModels?: () => Promise<ModelDescriptor[]>;
  onRuntimeChange?: (patch: Partial<TuiIdentity>) => void;
}


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
  let model = options.initialModel ?? options.modelFor(provider);
  // Codex starts lazily so an unauthenticated user can run /login first.
  let agent = provider === "openai-codex" ? undefined : options.createAgent({ provider, model });
  let pendingEditorText = "";
  const rebuildAgent = () => { agent = options.createAgent({ provider, model }); };
  const ensureAgent = () => { if (!agent) rebuildAgent(); return agent!; };

  const question = (label: string, initialText?: string, kind: InputRequest["kind"] = "choice"): Promise<string | null> =>
    io.readLine({ kind, label: label.trimEnd(), ...(initialText ? { initialText } : {}) });
  const emit = (text: string, tone?: NoticeTone): void => {
    const clean = text.replace(/\n+$/, "");
    const inferred = tone ?? (/^(Could not|Invalid|Not authenticated|Unknown|Auth commands|Session .*not available)/i.test(clean) ? "error"
      : /^(Switched|Logged in|Logged out|Continued|Branched)/i.test(clean) ? "success"
      : /canceled|discarded/i.test(clean) ? "warning" : "info");
    io.append({ text: clean, tone: inferred });
  };

  try {
    while (true) {
      const prefill = pendingEditorText;
      pendingEditorText = "";
      const userMessage = await question("> ", prefill || undefined, "message");
      if (userMessage === null) return;
      if (userMessage === "") {
        if (prefill) {
          emit("Message discarded; branch kept.\n");
          continue;
        }
        return;
      }

      if (userMessage === "/status") {
        let sessionName = "unavailable";
        let eventCount = options.conversation?.entries().length ?? 0;
        if (options.sessions) {
          try {
            const activeSession = options.sessions.list().find((session) => session.active);
            if (activeSession) {
              sessionName = activeSession.name;
              if (!options.conversation) eventCount = activeSession.eventCount;
            }
          } catch {
            // Model status remains useful if session metadata cannot be read.
          }
        }
        emit(`Active model: ${model} (${provider})\nSession: ${sessionName}\nSession events: ${eventCount}\n`);
        continue;
      }

      if (userMessage === "/model") {
        const choice = await question(
          `Provider [${PROVIDERS.join("/")}] (current: ${provider}): `,
        );
        if (!choice) {
          emit("Model selection canceled.\n");
          continue;
        }

        const selected = parseProvider(choice);
        if (!selected) {
          emit(`Invalid provider. Choose ${PROVIDERS.join(" or ")}.\n`);
          continue;
        }
        let selectedModel = options.modelFor(selected);
        if (selected === "openai-codex") {
          if (!options.auth) { emit("ChatGPT authentication is unavailable. Run /login openai-codex.\n"); continue; }
          const statuses = await options.auth.status();
          if (!statuses.some((entry) => !entry.disabled)) { emit("Not authenticated. Run /login openai-codex.\n"); continue; }
          try {
            const models = await options.discoverCodexModels?.() ?? [];
            if (models.length) {
              const ids = models.map((entry) => entry.id);
              const answer = await question(`Model [${ids.join("/")}] (default: ${ids[0]}): `);
              if (answer?.trim() && !ids.includes(answer.trim())) { emit("Invalid Codex model.\n"); continue; }
              selectedModel = answer?.trim() || ids[0]!;
            }
          } catch (error) { emit(`Could not discover Codex models: ${error instanceof Error ? error.message : String(error)}\n`); continue; }
        }
        if (selected === provider && selectedModel === model) {
          options.saveModelSelection?.(provider, model);
          emit(`Already using ${provider} with ${model}. Conversation retained.\n`);
          continue;
        }
        provider = selected;
        model = selectedModel;
        rebuildAgent();
        options.saveModelSelection?.(provider, model);
        options.onRuntimeChange?.({ provider, model });
        emit(`Switched to ${provider} using ${model}. Conversation retained.\n`);
        continue;
      }

      if (userMessage.startsWith("/login ") || userMessage.startsWith("/logout ") || userMessage.startsWith("/status ")) {
        const parts = userMessage.trim().split(/\s+/);
        const command = parts[0];
        if (parts[1] !== "openai-codex" || !options.auth) { emit("Auth commands support only openai-codex.\n"); continue; }
        try {
          if (command === "/login") {
            const status = await options.auth.login(parts.includes("--device"), (message) => emit(`${message}\n`));
            emit(`Logged in: ${status.identity}${status.planType ? ` (${status.planType})` : ""}.\n`);
            if (provider === "openai-codex") rebuildAgent();
          } else if (command === "/logout") {
            const removed = await options.auth.logout(parts[2]);
            emit(removed ? "Logged out.\n" : "Account not found.\n");
            if (provider === "openai-codex") agent = undefined;
          } else {
            const statuses = await options.auth.status();
            if (!statuses.length) emit("No ChatGPT subscription accounts are logged in.\n");
            for (const status of statuses) emit(`${status.identity}: ${status.disabled ? "disabled" : "ready"}${status.planType ? `, ${status.planType}` : ""}\n`);
          }
        } catch (error) { emit(`${error instanceof Error ? error.message : String(error)}\n`); }
        continue;
      }

      if (userMessage === "/tree") {
        if (!options.conversation || !io.showTree) {
          emit("Session tree is not available in this session.\n");
          continue;
        }
        const entries = options.conversation.entries();
        if (entries.length === 0) {
          emit("Session tree is empty.\n");
          continue;
        }

        let index: number | null;
        try {
          index = await io.showTree(entries);
        } catch {
          index = null;
        }
        if (index === null) {
          emit("Branch canceled.\n");
          continue;
        }
        const selected = entries.find((entry) => entry.index === index);
        if (!selected) {
          emit("Could not branch: session history is inconsistent.\n");
          continue;
        }
        const branchIndex = selected.event.type === "user"
          ? (index === 0 ? null : index - 1)
          : index;
        if (!options.conversation.branchTo(branchIndex)) {
          emit("Could not branch: session history is inconsistent.\n");
          continue;
        }
        if (selected.event.type === "user") pendingEditorText = selected.event.content;
        rebuildAgent();
        options.onRuntimeChange?.({ eventCount: options.conversation.entries().length });
        emit(branchIndex === null
          ? "Branched to the start of the session.\n"
          : `Branched to session entry ${branchIndex + 1}.\n`);
        continue;
      }

      if (userMessage === "/sessions") {
        if (!options.sessions || !io.showSessions) {
          emit("Session selection is not available in this session.\n");
          continue;
        }
        let sessions: SessionSummary[];
        try {
          sessions = options.sessions.list();
        } catch (error) {
          emit(`Could not list sessions: ${error instanceof Error ? error.message : String(error)}\n`);
          continue;
        }
        if (sessions.length === 0) {
          emit("No sessions found for this workspace.\n");
          continue;
        }
        let path: string | null;
        try {
          path = await io.showSessions(sessions);
        } catch {
          path = null;
        }
        if (path === null) {
          emit("Session selection canceled.\n");
          continue;
        }
        try {
          const result = options.sessions.activate(path);
          if (result.status === "already-active") {
            emit("That session is already active.\n");
            continue;
          }
          pendingEditorText = "";
          rebuildAgent();
          const summary = sessions.find((session) => session.path === path);
          const name = summary?.name ?? path;
          options.onRuntimeChange?.({ sessionName: name, sessionNumber: summary?.number, eventCount: result.eventCount });
          emit(`Continued ${name} (${result.eventCount} events).\n`);
        } catch (error) {
          emit(`Could not continue session: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        continue;
      }

      if (userMessage.startsWith("/")) {
        emit(`Unknown command: ${userMessage}. Available commands: /model, /tree, /sessions, /login, /logout, /status\n`);
        continue;
      }

      await ensureAgent().runTurn(userMessage);
      options.onRuntimeChange?.({ eventCount: options.conversation?.entries().length ?? 0 });
    }
  } finally {
    io.close();
  }
}

export interface CliArguments {
  resumePath?: string;
  cwd?: string;
  noTui: boolean;
  debug: boolean;
}

export function parseArguments(argv: readonly string[]): CliArguments {
  let resumePath: string | undefined;
  let cwd: string | undefined;
  let noTui = false;
  let debug = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--resume") {
      const path = argv[++index];
      if (!path || path.startsWith("-")) throw new Error("--resume requires a session JSONL path");
      if (resumePath) throw new Error("--resume may only be specified once");
      resumePath = resolve(path);
    } else if (arg === "--no-tui") noTui = true;
    else if (arg === "--debug") debug = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
    else if (!cwd) cwd = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return { ...(resumePath ? { resumePath } : {}), ...(cwd ? { cwd } : {}), noTui, debug };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  if (args.cwd) chdir(args.cwd);
  const workspaceRoot = resolve(process.cwd());
  migrateLegacyState();
  ensureStateDirectories();

  const store = args.resumePath ? new SessionStore(args.resumePath) : createSessionStore(workspaceRoot);
  const initialRecords = args.resumePath ? store.loadPathRecords() : [];
  const initialEvents = initialRecords.map((record) => record.event);
  const conversation = new ConversationState(store, initialEvents, initialRecords.map((record) => record.id));
  const sessions = new SessionNavigator(conversation, store, workspaceRoot);
  const auth = new CodexAuthService();
  const savedSelection = auth.store.getModelSelection();
  const startupProvider = process.env.PROVIDER || process.env.MODEL
    ? PROVIDER
    : savedSelection?.provider ?? PROVIDER;
  const startupModel = process.env.MODEL
    ?? (savedSelection?.provider === startupProvider ? savedSelection.model : modelFor(startupProvider));

  const active = sessions.list().find((session) => session.active);
  const identity: TuiIdentity = {
    provider: startupProvider,
    model: startupModel,
    cwd: workspaceRoot,
    sessionName: active?.name ?? `session-${active?.number ?? "new"}`,
    sessionNumber: active?.number,
    eventCount: initialEvents.length,
  };
  const useTui = !args.noTui && !args.debug && stdin.isTTY === true && stdout.isTTY === true && process.env.TERM !== "dumb";
  const io: ReplIO = useTui ? new TuiApp({ identity }) : new PlainReplIO(stdin, stdout);
  if (args.debug) {
    stdout.write(`Session: ${store.path}${args.resumePath ? ` (resumed ${initialEvents.length} events)` : ""}\n`);
    stdout.write(`Startup: ${startupProvider}/${startupModel} · cwd ${workspaceRoot} · plain debug mode\n`);
  } else if (!useTui) {
    stdout.write(`Redwake Agent · ${startupModel} (${startupProvider}) · ${identity.sessionNumber ? `session ${identity.sessionNumber}` : identity.sessionName} · ${identity.eventCount ? `${identity.eventCount} events` : "new"}\n`);
  }

  const renderer = useTui ? undefined : new ProgressRenderer({ write: (text) => stdout.write(text), isTTY: false });
  const tui = useTui ? io as TuiApp : undefined;
  const createAgent = createAgentFactory({
    ctx: createToolContext({ workspaceRoot }),
    workspaceRoot,
    conversation,
    credentials: auth.credentials,
    progress: (event) => tui ? tui.handleProgress(event) : renderer?.handle(event),
  });
  const catalog = new ModelCatalog(auth.credentials, auth.store);
  try {
    await runRepl({
      provider: startupProvider,
      initialModel: startupModel,
      createAgent,
      modelFor,
      saveModelSelection: (provider, model) => auth.store.putModelSelection(provider, model),
      conversation,
      sessions,
      auth,
      discoverCodexModels: () => catalog.discover(true),
      onRuntimeChange: (patch) => tui?.updateRuntime(patch),
    }, io);
  } finally {
    renderer?.dispose();
    io.close();
  }
}
