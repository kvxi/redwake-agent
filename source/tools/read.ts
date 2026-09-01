import { resolve } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { z } from "zod";
import { defineTool, ToolError } from "./context.ts";
import { MAX_OUTPUT_CHARS, MAX_OUTPUT_LINES } from "../config.ts";

const viewRange = z
  .array(z.number().int())
  .length(2)
  .describe("Inclusive 1-based [start, end] lines; -1 ends at EOF.")
  .refine((range) => range[0]! >= 1, "view_range start must be at least 1")
  .refine(
    (range) => range[1] === -1 || range[1]! >= range[0]!,
    "view_range end must be at least the start or -1",
  );

const schema = z.object({
  file_path: z.string(),
  view_range: viewRange.optional(),
});

// Mirrors Python str.splitlines(): a trailing line terminator does not
// produce a spurious final empty line.
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export const readTool = defineTool({
  name: "read",
  description: "Read a UTF-8 text file with 1-based line numbers.",
  schema,
  handler: async ({ file_path, view_range }, ctx) => {
    const path = resolve(ctx.workspaceRoot, file_path);

    const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (stats?.isDirectory()) {
      throw new ToolError(`Cannot read directory: ${file_path}`);
    }

    const raw = await readFile(path);
    if (raw.includes(0)) {
      throw new ToolError(`Cannot read binary file: ${file_path}`);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      throw new ToolError(`Cannot read binary file: ${file_path}`);
    }

    const lines = splitLines(content);
    const start = view_range?.[0] ?? 1;
    const rawEnd = view_range?.[1];
    const end = rawEnd === undefined || rawEnd === -1 ? lines.length : rawEnd;
    ctx.readPaths.add(path);

    const output: string[] = [];
    let outputSize = 0;
    for (let i = start; i <= Math.min(end, lines.length); i++) {
      const rendered = `${i}: ${lines[i - 1]}`;
      const separatorSize = output.length ? 1 : 0;
      if (
        output.length === MAX_OUTPUT_LINES ||
        outputSize + separatorSize + rendered.length > MAX_OUTPUT_CHARS
      ) {
        output.push(
          "[output truncated; use view_range to request a smaller section]",
        );
        break;
      }
      output.push(rendered);
      outputSize += separatorSize + rendered.length;
    }

    return output.join("\n");
  },
});
