import { tools } from "../tools/registry.ts";

export interface BuildSystemPromptOptions {
  customPrompt?: string;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
}
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
  const contextFiles = providedContextFiles ?? [];
  const toolDescriptions = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  if (customPrompt) {
    let prompt = customPrompt + appendSection;
    if (contextFiles.length > 0) {
      prompt += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
      for (const { path: filePath, content } of contextFiles) {
        prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
      }
      prompt += "</project_context>\n";
    }
    return `${prompt}\nCurrent working directory: ${promptCwd}\n`;
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

  let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolDescriptions}

Guidelines:
${guidelines}`;

  if (appendSection) {
		prompt += appendSection;
	}
  if (contextFiles.length > 0) {
		prompt += "\n\n<project_context>\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `<project_instructions path="${filePath}">\n${content}\n</project_instructions>\n\n`;
		}
		prompt += "</project_context>\n";
	}

  prompt += `\nCurrent working directory: ${promptCwd}`;

  return prompt;

}
