import { dirname, resolve } from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, ToolError, type ToolContext } from "./context.ts";

/**
 * Shared write core used by both the `write` and `edit` tools. Enforces the
 * read-before-overwrite invariant (existing files must have been read this
 * session), which is what makes `edit` a "previously read file" operation.
 */
export async function writeText(
  filePath: string,
  contents: string,
  ctx: ToolContext,
): Promise<string> {
  const path = resolve(ctx.workspaceRoot, filePath);

  const stats = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stats?.isDirectory()) {
    throw new ToolError(`Cannot write to directory: ${filePath}`);
  }
  if (stats && !ctx.readPaths.has(path)) {
    throw new ToolError(`Cannot overwrite unread file: ${filePath}`);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf-8");
  ctx.readPaths.add(path);
  return `Successfully wrote ${filePath}`;
}

const schema = z.object({
  file_path: z.string(),
  contents: z.string(),
});

export const writeTool = defineTool({
  name: "write",
  description: "Create or fully replace a UTF-8 text file.",
  schema,
  handler: ({ file_path, contents }, ctx) => writeText(file_path, contents, ctx),
});
