import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, ToolError } from "./context.ts";
import { writeText } from "./write.ts";

// Strips the "N: " prefixes the `read` tool emits, so model-pasted snippets
// match the on-disk content.
const READ_LINE_PREFIX = /^[1-9]\d*: /gm;

const schema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
});

export const editTool = defineTool({
  name: "edit",
  description: "Replace one exact text occurrence in a previously read file.",
  schema,
  handler: async ({ file_path, old_string, new_string }, ctx) => {
    const oldString = old_string.replace(READ_LINE_PREFIX, "");
    const newString = new_string.replace(READ_LINE_PREFIX, "");
    if (!oldString) {
      throw new ToolError("old_string must not be empty");
    }

    const path = resolve(ctx.workspaceRoot, file_path);
    const content = await readFile(path, "utf-8");
    const matchCount = content.split(oldString).length - 1;
    if (matchCount === 0) {
      throw new ToolError("No exact match found for replacement text");
    }
    if (matchCount > 1) {
      throw new ToolError(
        "Found multiple exact matches; provide more replacement context",
      );
    }

    // Function replacement keeps `newString` literal (no $-pattern expansion).
    await writeText(file_path, content.replace(oldString, () => newString), ctx);
    return "Successfully replaced text at exactly one location.";
  },
});
