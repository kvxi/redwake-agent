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
