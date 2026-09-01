import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyState, statePaths, type StatePaths } from "../source/paths.ts";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "rwa-paths-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function paths(): StatePaths {
  const stateRoot = join(root, "xdg", "redwake", "agent");
  return {
    stateRoot,
    authDbPath: join(stateRoot, "auth.sqlite"),
    sessionsRoot: join(stateRoot, "sessions"),
    installationIdPath: join(stateRoot, "installation-id"),
    legacyRoot: join(root, "home", "redwake", "agent"),
  };
}

describe("state paths", () => {
  test("uses only an absolute non-empty XDG_CONFIG_HOME", () => {
    expect(statePaths({ XDG_CONFIG_HOME: join(root, "cfg") }, join(root, "home")).stateRoot)
      .toBe(join(root, "cfg", "redwake", "agent"));
    expect(statePaths({ XDG_CONFIG_HOME: "relative" }, join(root, "home")).stateRoot)
      .toBe(join(root, "home", ".config", "redwake", "agent"));
  });

  test("migrates without overwriting and tightens permissions idempotently", async () => {
    const value = paths();
    await mkdir(join(value.legacyRoot, "sessions", "workspace"), { recursive: true, mode: 0o755 });
    await writeFile(join(value.legacyRoot, "auth.sqlite"), "legacy-auth", { mode: 0o644 });
    await writeFile(join(value.legacyRoot, "installation-id"), "legacy-id", { mode: 0o644 });
    await writeFile(join(value.legacyRoot, "sessions", "workspace", "session-1.jsonl"), "{}\n", { mode: 0o644 });
    await mkdir(value.stateRoot, { recursive: true });
    await writeFile(value.authDbPath, "new-auth");

    migrateLegacyState(value, (message) => { throw new Error(message); });
    migrateLegacyState(value, (message) => { throw new Error(message); });

    expect(await readFile(value.authDbPath, "utf8")).toBe("new-auth");
    expect(await readFile(value.installationIdPath, "utf8")).toBe("legacy-id");
    expect(existsSync(join(value.sessionsRoot, "workspace", "session-1.jsonl"))).toBe(true);
    expect((await stat(value.stateRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(value.installationIdPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(value.sessionsRoot, "workspace", "session-1.jsonl"))).mode & 0o777).toBe(0o600);
    expect(existsSync(join(value.legacyRoot, "auth.sqlite"))).toBe(true);
  });
});
