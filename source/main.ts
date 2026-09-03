// Parses args, resolves the working directory, and runs the interactive agent.
import { chdir, stdin, stdout } from "node:process";
import { resolve } from "node:path";
import { ensureStateDirectories, migrateLegacyState } from "./paths.ts";
import { modelFor, parseProvider, PROVIDER, PROVIDERS, type Provider } from "./config.ts";
import { createAgentFactory, type ProviderAgentFactory } from "./agent/factory.ts";
import { CodexAuthService, type AuthService } from "./auth/service.ts";
import { ModelCatalog, type ModelDescriptor } from "./codex/models.ts";
import { discoverApiModels, type ApiProvider } from "./api-models.ts";
import { createToolContext } from "./tools/context.ts";
import { createSessionStore, SessionStore } from "./session/store.ts";
import { ConversationState, type ConversationEntry } from "./session/conversation-state.ts";
import { SessionNavigator, type SessionCreation, type SessionSummary } from "./session/navigator.ts";
import { NEW_SESSION, type SessionSelection } from "./session/sessions-ui.ts";
import { ProgressRenderer } from "./ui/progress-renderer.ts";
import { PlainReplIO } from "./ui/plain-repl-io.ts";
import { TuiApp } from "./ui/tui-app.ts";
import type { NoticeTone, TuiIdentity } from "./ui/tui-state.ts";

export interface InputRequest {
  kind: "message" | "choice";
  label: string;
  initialText?: string;
  secret?: boolean;
}

export interface ReplIO {
  readLine(request: InputRequest): Promise<string | null>;
  append(message: { text: string; tone?: NoticeTone }): void;
  close(): void;
  /** Handle Ctrl-C while no input prompt is active (for example, during OAuth). */
  setInterruptHandler?(handler?: () => void): void;
  /** Replace the displayed transcript after loading or branching a session. */
  setConversation?(entries: readonly ConversationEntry[]): void;
  showTree?(entries: readonly ConversationEntry[]): Promise<number | null>;
  showSessions?(sessions: readonly SessionSummary[]): Promise<SessionSelection | null>;
}

export interface BranchableConversation {
  entries(): ReadonlyArray<ConversationEntry>;
  branchTo(index: number | null): boolean;
}

export interface SessionNavigation {
  list(): SessionSummary[];
  activate(path: string): { status: "switched" | "already-active"; eventCount: number };
  create?(): SessionCreation;
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
  getApiKey?: (provider: "anthropic" | "openai") => string | undefined;
  saveApiKey?: (provider: "anthropic" | "openai", apiKey: string) => void;
  removeApiKey?: (provider: "anthropic" | "openai") => boolean;
  /** Run interactive provider and credential setup before the first prompt. */
  onboarding?: boolean;
  discoverCodexModels?: () => Promise<ModelDescriptor[]>;
  discoverApiModels?: (provider: ApiProvider) => Promise<ModelDescriptor[]>;
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
  // Agents start lazily so a fresh install can select a provider and authenticate first.
  let agent: ReturnType<ProviderAgentFactory> | undefined = options.onboarding
    ? undefined
    : options.createAgent({ provider, model });
  let pendingEditorText = "";
  const rebuildAgent = () => { agent = options.createAgent({ provider, model }); };
  const ensureAgent = () => { if (!agent) rebuildAgent(); return agent!; };

  const question = (label: string, initialText?: string, kind: InputRequest["kind"] = "choice", secret = false): Promise<string | null> =>
    io.readLine({ kind, label: label.trimEnd(), ...(initialText ? { initialText } : {}), ...(secret ? { secret: true } : {}) });
  const emit = (text: string, tone?: NoticeTone): void => {
    const clean = text.replace(/\n+$/, "");
    const inferred = tone ?? (/^(Could not|Invalid|Not authenticated|Unknown|Auth commands|Session .*not available)/i.test(clean) ? "error"
      : /^(Switched|Logged in|Logged out|Continued|Branched|Started)/i.test(clean) ? "success"
      : /canceled|discarded/i.test(clean) ? "warning" : "info");
    io.append({ text: clean, tone: inferred });
  };

  const loginProvider = async (selected: Provider, device = false, onboardingLogin = false): Promise<"success" | "canceled"> => {
    if (selected === "openai-codex") {
      if (!options.auth) throw new Error("ChatGPT authentication is unavailable.");
      const controller = new AbortController();
      let interrupted = false;
      io.setInterruptHandler?.(() => { interrupted = true; controller.abort(); });
      try {
        const status = await options.auth.login(device, (message) => emit(`${message}\n`), controller.signal);
        const codexDefault = options.modelFor("openai-codex");
        if (provider === "openai-codex") {
          model = codexDefault;
          options.onRuntimeChange?.({ provider, model });
          if (!onboardingLogin) options.saveModelSelection?.(provider, model);
        }
        emit(`Logged in: ${status.identity}${status.planType ? ` (${status.planType})` : ""}.\n`);
        emit(`OpenAI Codex defaults to ${codexDefault}. Run /model openai-codex to choose another available model.\n`);
        agent = undefined;
        return "success";
      } catch (error) {
        if (interrupted || controller.signal.aborted) return "canceled";
        throw error;
      } finally {
        io.setInterruptHandler?.(undefined);
      }
    }
    if (!options.saveApiKey) throw new Error(`API key storage is unavailable for ${selected}.`);
    const apiKey = await question(`${selected === "anthropic" ? "Anthropic" : "OpenAI"} API key:`, undefined, "choice", true);
    if (!apiKey?.trim()) return "canceled";
    options.saveApiKey(selected, apiKey.trim());
    agent = undefined;
    emit(`Logged in to ${selected} with an API key.\n`);
    return "success";
  };

  try {
    if (options.onboarding) {
      emit("Welcome. First choose a model provider, then log in.\n");
      const choice = await question(`Provider [${PROVIDERS.join("/")}]:`);
      if (!choice) return;
      const selected = parseProvider(choice);
      if (!selected) { emit(`Invalid provider. Choose ${PROVIDERS.join(" or ")}.\n`); return; }
      provider = selected;
      model = options.modelFor(selected);
      options.onRuntimeChange?.({ provider, model });
      emit(`Selected ${provider} using ${model}.\n`);
      const result = await loginProvider(provider, false, true);
      if (result === "canceled") return;
      // Mark onboarding complete only after credentials were successfully saved.
      options.saveModelSelection?.(provider, model);
    }

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

      if (userMessage === "/model" || userMessage.startsWith("/model ") ||
          userMessage === "/api" || userMessage.startsWith("/api ")) {
        const command = userMessage.trim().split(/\s+/)[0];
        const availableProviders: readonly Provider[] = command === "/api" ? ["anthropic", "openai"] : PROVIDERS;
        const requestedProvider = userMessage.trim().split(/\s+/)[1];
        const choice = requestedProvider ?? await question(
          `Provider [${availableProviders.join("/")}] (current: ${provider}): `,
        );
        if (!choice) {
          emit("Model selection canceled.\n");
          continue;
        }

        const selected = parseProvider(choice);
        if (!selected || !availableProviders.includes(selected)) {
          emit(`Invalid provider. Choose ${availableProviders.join(" or ")}.\n`);
          continue;
        }
        let selectedModel = options.modelFor(selected);
        if (selected === "openai-codex" && options.auth) {
          const statuses = await options.auth.status();
          if (statuses.some((entry) => !entry.disabled)) {
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
        }
        if (selected !== "openai-codex" && options.getApiKey && !options.getApiKey(selected)) {
          try {
            const result = await loginProvider(selected);
            if (result === "canceled") {
              emit("Model selection canceled.\n");
              continue;
            }
          } catch (error) {
            emit(`${error instanceof Error ? error.message : String(error)}\n`);
            continue;
          }
        }
        if (selected !== "openai-codex" && options.discoverApiModels) {
          try {
            const models = await options.discoverApiModels(selected);
            if (!models.length) {
              emit(`No models are available for the ${selected} API key.\n`);
              continue;
            }
            const ids = models.map((entry) => entry.id);
            const defaultModel = ids.includes(selectedModel) ? selectedModel : ids[0]!;
            const answer = await question(`Model [${ids.join("/")}] (default: ${defaultModel}): `);
            if (answer?.trim() && !ids.includes(answer.trim())) {
              emit(`Invalid ${selected} API model.\n`);
              continue;
            }
            selectedModel = answer?.trim() || defaultModel;
          } catch (error) {
            emit(`Could not discover ${selected} API models: ${error instanceof Error ? error.message : String(error)}\n`);
            continue;
          }
        }
        if (selected === provider && selectedModel === model) {
          options.saveModelSelection?.(provider, model);
          emit(`Already using ${provider} with ${model}. Conversation retained.\n`);
          continue;
        }
        provider = selected;
        model = selectedModel;
        agent = selected === "openai-codex" || !options.getApiKey || options.getApiKey(selected)
          ? options.createAgent({ provider, model })
          : undefined;
        options.saveModelSelection?.(provider, model);
        options.onRuntimeChange?.({ provider, model });
        emit(`Switched to ${provider} using ${model}. Conversation retained.\n`);
        continue;
      }

      if (userMessage.startsWith("/login ") || userMessage.startsWith("/logout ") || userMessage.startsWith("/status ")) {
        const parts = userMessage.trim().split(/\s+/);
        const command = parts[0];
        const selected = parts[1] ? parseProvider(parts[1]) : undefined;
        if (!selected) { emit(`Auth commands require one of: ${PROVIDERS.join(", ")}.\n`); continue; }
        try {
          if (command === "/login") {
            const result = await loginProvider(selected, parts.includes("--device"));
            if (result === "canceled" && selected === "openai-codex") return;
          } else if (command === "/logout") {
            const removed = selected === "openai-codex"
              ? await options.auth?.logout(parts[2]) ?? false
              : options.removeApiKey?.(selected) ?? false;
            emit(removed ? "Logged out.\n" : "Credential not found.\n");
            if (provider === selected) agent = undefined;
          } else if (selected === "openai-codex") {
            const statuses = await options.auth?.status() ?? [];
            if (!statuses.length) emit("No ChatGPT subscription accounts are logged in.\n");
            for (const status of statuses) emit(`${status.identity}: ${status.disabled ? "disabled" : "ready"}${status.planType ? `, ${status.planType}` : ""}\n`);
          } else {
            emit(options.getApiKey?.(selected) ? `${selected}: API key configured.\n` : `${selected}: not logged in.\n`);
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
        const branchedEntries = options.conversation.entries();
        io.setConversation?.(branchedEntries);
        options.onRuntimeChange?.({ eventCount: branchedEntries.length });
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
        let selection: SessionSelection | null;
        try {
          selection = await io.showSessions(sessions);
        } catch {
          selection = null;
        }
        if (selection === null) {
          emit("Session selection canceled.\n");
          continue;
        }
        if (selection === NEW_SESSION) {
          if (!options.sessions.create) {
            emit("New session creation is not available in this session.\n");
            continue;
          }
          try {
            const created = options.sessions.create();
            pendingEditorText = "";
            rebuildAgent();
            if (options.conversation) io.setConversation?.(options.conversation.entries());
            options.onRuntimeChange?.({ sessionName: created.name, sessionNumber: created.number, eventCount: 0 });
            emit(`Started new session ${created.name}.\n`);
          } catch (error) {
            emit(`Could not create session: ${error instanceof Error ? error.message : String(error)}\n`);
          }
          continue;
        }
        const path = selection;
        try {
          const result = options.sessions.activate(path);
          if (result.status === "already-active") {
            emit("That session is already active.\n");
            continue;
          }
          pendingEditorText = "";
          rebuildAgent();
          if (options.conversation) io.setConversation?.(options.conversation.entries());
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
        emit(`Unknown command: ${userMessage}. Available commands: /model, /api, /tree, /sessions, /login, /logout, /status\n`);
        continue;
      }

      if (provider !== "openai-codex" && options.getApiKey && !options.getApiKey(provider)) {
        emit(`Not authenticated. Run /login ${provider}.\n`);
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
  const tui = useTui ? io as TuiApp : undefined;
  tui?.setConversation(conversation.entries());
  if (args.debug) {
    stdout.write(`Session: ${store.path}${args.resumePath ? ` (resumed ${initialEvents.length} events)` : ""}\n`);
    stdout.write(`Startup: ${startupProvider}/${startupModel} · cwd ${workspaceRoot} · plain debug mode\n`);
  } else if (!useTui) {
    stdout.write(`Redwake Agent · ${startupModel} (${startupProvider}) · ${identity.sessionNumber ? `session ${identity.sessionNumber}` : identity.sessionName} · ${identity.eventCount ? `${identity.eventCount} events` : "new"}\n`);
  }

  const renderer = useTui ? undefined : new ProgressRenderer({ write: (text) => stdout.write(text), isTTY: false });
  const apiKeyFor = (provider: Provider): string | undefined => provider === "anthropic"
    ? process.env.ANTHROPIC_API_KEY || auth.store.getApiKey("anthropic")
    : provider === "openai" ? process.env.OPENAI_API_KEY || auth.store.getApiKey("openai") : undefined;
  const createAgent = createAgentFactory({
    ctx: createToolContext({ workspaceRoot }),
    workspaceRoot,
    conversation,
    apiKeyFor,
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
      getApiKey: apiKeyFor,
      saveApiKey: (provider, apiKey) => auth.store.putApiKey(provider, apiKey),
      removeApiKey: (provider) => auth.store.removeApiKey(provider),
      onboarding: !savedSelection && !process.env.PROVIDER && !process.env.MODEL,
      discoverCodexModels: () => catalog.discover(true),
      discoverApiModels: (provider) => {
        const apiKey = apiKeyFor(provider);
        if (!apiKey) throw new Error(`No API key configured for ${provider}`);
        return discoverApiModels(provider, apiKey);
      },
      onRuntimeChange: (patch) => tui?.updateRuntime(patch),
    }, io);
  } finally {
    renderer?.dispose();
    io.close();
  }
}
