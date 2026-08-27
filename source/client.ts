#!/usr/bin/env bun
// CLI entry point: sets the process title, then hands off to main().
import { main } from "./main.ts";

process.title = "redwake";

await main();
