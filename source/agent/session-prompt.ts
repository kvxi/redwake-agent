import { generateRepoMap, type RepoMapResult } from "../repo-map.ts";
import {
  buildSystemPromptParts,
  type BuildSystemPromptOptions,
  type BuiltSystemPrompt,
} from "./system-prompt.ts";

export interface SessionPromptOptions extends Omit<BuildSystemPromptOptions, "cwd" | "repoMap"> {
  maxTokens?: number;
  generateRepoMap?: (options: { workspaceRoot: string; maxTokens?: number }) => RepoMapResult;
}

/** Owns the immutable prompt snapshot shared by all provider agents in a session. */
export class SessionPrompt {
  private current: BuiltSystemPrompt;
  private readonly generator: NonNullable<SessionPromptOptions["generateRepoMap"]>;

  constructor(readonly workspaceRoot: string, private readonly options: SessionPromptOptions = {}) {
    this.generator = options.generateRepoMap ?? generateRepoMap;
    this.current = buildSystemPromptParts({ cwd: workspaceRoot });
    this.refresh();
  }

  refresh(): void {
    const result = this.generator({ workspaceRoot: this.workspaceRoot, maxTokens: this.options.maxTokens });
    this.current = buildSystemPromptParts({
      cwd: this.workspaceRoot,
      customPrompt: this.options.customPrompt,
      promptGuidelines: this.options.promptGuidelines,
      appendSystemPrompt: this.options.appendSystemPrompt,
      contextFiles: this.options.contextFiles,
      repoMap: result.text,
    });
  }

  snapshot(): BuiltSystemPrompt {
    return this.current;
  }
}
