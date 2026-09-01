#!/usr/bin/env bun
import packageJson from "../package.json" with { type: "json" };

export const HELP = `Usage: rwa [workspace] [options]

Options:
  --resume <path>  Resume a session JSONL file
  --no-tui         Use line-oriented output
  --debug          Show startup internals and use plain output
  -h, --help       Show help
  -v, --version    Show version
`;

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  process.title = "rwa";
  if (argv.includes("-h") || argv.includes("--help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.includes("-v") || argv.includes("--version")) {
    process.stdout.write(`rwa ${packageJson.version}\n`);
    return 0;
  }
  try {
    const { main } = await import("./main.ts");
    await main(argv);
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (argv.includes("--debug") && error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
    else process.stderr.write(`rwa: ${detail}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli();
