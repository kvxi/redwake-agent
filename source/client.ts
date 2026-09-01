#!/usr/bin/env bun
/** Backward-compatible development wrapper. The authoritative CLI is cli.ts. */
import { runCli } from "./cli.ts";

process.exitCode = await runCli();
