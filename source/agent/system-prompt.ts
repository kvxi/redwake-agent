import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tools } from "../tools/registry.ts";

// system_prompt.md / custom_system.md live in source/, one level up from agent/.
const sourceDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export function buildSystemPrompt(): string {
  const template = readFileSync(join(sourceDir, "system_prompt.md"), "utf-8");
  const custom = readFileSync(join(sourceDir, "custom_system.md"), "utf-8");
  const toolDescriptions = tools
    .map((tool) => `- ${tool.name}: ${tool.description}`)
    .join("\n");

  return (
    template
      .replace("{custom_system.md}", custom)
      .replace("{current_date}", new Date().toISOString().slice(0, 10))
      .replace("{cwd}", process.cwd()) +
    `\n\nAvailable tools:\n${toolDescriptions}`
  );
}

export interface BuildSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  promptGuideline?: string[];
  appendSystemPrompt?: string;
  cwd: string;
}

export function buildSystemPrompty(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    promptGuidelines,
    appendSystemPrompt,
    cwd
  } = options;
  const promptCwd = process.cwd().replace(/\\/g, "/");
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const contextFiles = providedContextFiles ?? [];

  if (customPrompt) {
    let prompt = customPrompt;
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

    prompt += `\nCurrent working directory: ${promptCwd}\n`;

    return prompt;
  }

  const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};
  addGuideline("Use bash or PowerShell for file operations like listing, searching, and finding files");
  addGuideline("Use PowerShell for file operations like listing, searching, and finding files");
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");


}
