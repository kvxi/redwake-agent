import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { parseArguments } from "../source/main.ts";

let root: string;
const cli = resolve(import.meta.dir, "../source/cli.ts");
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rwa-cli-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

async function invoke(args: string[]) {
  const xdg = join(root, "config");
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: xdg },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write("\n");
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, xdg };
}

describe("rwa CLI", () => {
  for (const flag of ["--help", "-h"]) test(`${flag} is fast and state-free`, async () => {
    const result = await invoke([flag]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toStartWith("Usage: rwa [workspace] [options]");
    expect(existsSync(result.xdg)).toBe(false);
  });

  for (const flag of ["--version", "-v"]) test(`${flag} reports the package version without state`, async () => {
    const result = await invoke([flag]);
    expect(result).toMatchObject({ exitCode: 0, stdout: `rwa ${packageJson.version}\n` });
    expect(existsSync(result.xdg)).toBe(false);
  });

  test("argument errors are concise and nonzero", async () => {
    for (const args of [["--unknown"], ["one", "two"], ["--resume"], ["-x"]]) {
      const result = await invoke(args);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toStartWith("rwa: ");
      expect(result.stderr).not.toContain(" at ");
    }
  });

  test("starts outside the checkout with workspace identity and XDG-only state", async () => {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await Bun.write(join(workspace, ".keep"), "workspace");
    const result = await invoke([workspace, "--no-tui"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Redwake");
    const stateRoot = join(result.xdg, "redwake", "agent");
    expect(existsSync(join(stateRoot, "auth.sqlite"))).toBe(true);
    expect(existsSync(join(stateRoot, "sessions"))).toBe(true);
    expect(await readdir(workspace)).toEqual([".keep"]);
    expect((await stat(stateRoot)).mode & 0o777).toBe(0o700);
  });

  test("passes workspace and runtime options through one parser", () => {
    expect(parseArguments([root, "--no-tui", "--debug", "--resume", "session.jsonl"])).toEqual({
      cwd: root,
      noTui: true,
      debug: true,
      resumePath: resolve("session.jsonl"),
    });
  });
});
