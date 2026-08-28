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
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  providedContextFiles?: Array<{ path: string; content: string }>;
  cwd: string;
}

export function buildSystemPrompty(options: BuildSystemPromptOptions): string {
  const {
    customPrompt,
    selectedTools,
    promptGuidelines,
    appendSystemPrompt,
    providedContextFiles,
    cwd,
  } = options;
  const promptCwd = cwd.replace(/\\/g, "/");
  const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";
  const contextFiles = providedContextFiles ?? [];

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
  for (const guideline of promptGuidelines ?? []) addGuideline(guideline);
  const selected = new Set(selectedTools ?? tools.map((tool) => tool.name));
  const toolDescriptions = tools.filter((tool) => selected.has(tool.name)).map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");
  let prompt = `You are a helpful coding agent.\n\nGuidelines:\n${guidelinesList.map((item) => `- ${item}`).join("\n")}\n\nCurrent working directory: ${promptCwd}\n\nAvailable tools:\n${toolDescriptions}`;
  if (contextFiles.length) prompt += `\n\n<project_context>\n${contextFiles.map((file) => `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`).join("\n")}\n</project_context>`;
  return prompt + appendSection;
}
