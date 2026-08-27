import { z } from "zod";
import { defineTool } from "./context.ts";

const schema = z.object({
  command: z.string(),
});

export const bashTool = defineTool({
  name: "bash",
  description: "Run a shell command and return stdout, stderr, and exit code.",
  schema,
  handler: async ({ command }) => {
    // `sh -c <command>` reproduces Python subprocess.run(shell=True); the
    // interpolation is passed as a single argument, not re-parsed by Bun.
    const result = await Bun.$`/bin/sh -c ${command}`.quiet().nothrow();
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exit_code: result.exitCode,
    };
  },
});
