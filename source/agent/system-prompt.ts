import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tools } from "../tools/registry.ts";

export interface BuildSystemPromptOptions {
  customPrompt?: string;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
  repoMap?: string;
}

export interface BuiltSystemPrompt {
  /** Static instructions before the repository map. */
  prefix: string;
  /** The final static repository-map block, when available. */
  repoMap?: string;
  /** Complete provider-neutral prompt text. */
  text: string;
}

/** Build structured prompt parts for provider caching. */
export function buildSystemPromptParts(options: BuildSystemPromptOptions): BuiltSystemPrompt {
  const prefix = buildSystemPrompt({ ...options, repoMap: undefined });
  const repoMap = options.repoMap?.trim();
  return {
    prefix,
    ...(repoMap ? { repoMap } : {}),
    text: repoMap ? `${prefix}\n\n${repoMap}` : prefix,
  };
}

/** Legacy string builder; prefer buildSystemPromptParts for provider requests. */
export function buildSystemPrompt(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    promptGuidelines,
    appendSystemPrompt,
    cwd,
    contextFiles: providedContextFiles,
  } = options;

  const promptCwd = cwd.replace(/\\/g, "/");
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  let agentsContext: string | undefined;
  try {
    agentsContext = readFileSync(join(cwd, "AGENTS.md"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const contextFiles = [
    ...(agentsContext === undefined
      ? []
      : [{ path: "AGENTS.md", content: agentsContext }]),
    ...(providedContextFiles ?? []),
  ];
  const contextIntroduction = agentsContext === undefined
    ? "Project-specific instructions and guidelines:"
    : "Project-specific instructions and guidelines follow. The project_instructions block with path=\"AGENTS.md\" contains the AGENTS.md file from the project root:";
  const toolDescriptions = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  if (customPrompt) {
    let prompt = customPrompt + appendSection;
    if (contextFiles.length > 0) {
      prompt += `\n\n<project_context>\n\n${contextIntroduction}\n\n`;
      for (const { path: filePath, content } of contextFiles) {
        prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
      }
      prompt += "</project_context>\n";
    }
    const prefix = `${prompt}\nCurrent working directory: ${promptCwd}`;
    return options.repoMap?.trim() ? `${prefix}\n\n${options.repoMap.trim()}` : `${prefix}\n`;
  }

  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string): void => {
    if (!guidelinesSet.has(guideline)) {
      guidelinesSet.add(guideline);
      guidelinesList.push(guideline);
    }
  };
  addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}
  const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

  let prompt = `You are an expert coding assistant operating inside Redwake Agent, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files. The repo map reflects the working tree when the current session was initialized or loaded. Use tools to verify current file contents before editing. AGENTS.md is hand-maintained and may lag. Verify against the file before relying on a specific detail.

Available tools:
${toolDescriptions}

Guidelines:
${guidelines}`;

  if (appendSection) {
		prompt += appendSection;
	}
  if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += `${contextIntroduction}\n\n`;
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

  prompt += `\nCurrent working directory: ${promptCwd}`;
  if (options.repoMap?.trim()) prompt += `\n\n${options.repoMap.trim()}`;

  return prompt;

}
