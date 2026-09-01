import { chmodSync, cpSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** Directory containing compiled application code and bundled assets. */
export const INSTALL_ROOT = import.meta.dir;

export interface StatePaths {
  stateRoot: string;
  authDbPath: string;
  sessionsRoot: string;
  installationIdPath: string;
  legacyRoot: string;
}

export function statePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): StatePaths {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const configRoot = xdg && isAbsolute(xdg) ? resolve(xdg) : join(home, ".config");
  const stateRoot = join(configRoot, "redwake", "agent");
  return {
    stateRoot,
    authDbPath: join(stateRoot, "auth.sqlite"),
    sessionsRoot: join(stateRoot, "sessions"),
    installationIdPath: join(stateRoot, "installation-id"),
    legacyRoot: join(home, "redwake", "agent"),
  };
}

const defaults = statePaths();
export const STATE_ROOT = defaults.stateRoot;
export const AUTH_DB_PATH = defaults.authDbPath;
export const SESSIONS_ROOT = defaults.sessionsRoot;
export const INSTALLATION_ID_PATH = defaults.installationIdPath;
export const LEGACY_STATE_ROOT = defaults.legacyRoot;

/** Create a private directory and reject ownership by another user where supported. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = statSync(path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Refusing state directory owned by another user: ${path}`);
  }
  if ((stat.mode & 0o077) !== 0) chmodSync(path, 0o700);
}

export function ensureStateDirectories(paths: StatePaths = defaults): void {
  // Treat the shared parent as private without assuming ownership of its contents.
  ensurePrivateDirectory(dirname(paths.stateRoot));
  ensurePrivateDirectory(paths.stateRoot);
}

function moveWithoutOverwrite(from: string, to: string): void {
  if (!existsSync(from) || existsSync(to)) return;
  ensurePrivateDirectory(dirname(to));
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    // Deliberately retain the legacy copy: migration must be non-destructive if
    // a cross-device copy cannot be followed by an atomic move.
  }
}

function tighten(path: string, mode: number): void {
  if (!existsSync(path)) return;
  chmodSync(path, mode);
}

/** Conservative, idempotent migration from ~/redwake/agent. */
export function migrateLegacyState(
  paths: StatePaths = defaults,
  warn: (message: string) => void = (message) => process.stderr.write(`rwa: warning: ${message}\n`),
): void {
  if (resolve(paths.legacyRoot) === resolve(paths.stateRoot) || !existsSync(paths.legacyRoot)) return;
  try {
    ensureStateDirectories(paths);
    for (const name of ["auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm", "sessions", "installation-id"]) {
      moveWithoutOverwrite(join(paths.legacyRoot, name), join(paths.stateRoot, name));
    }
    tighten(paths.stateRoot, 0o700);
    tighten(paths.sessionsRoot, 0o700);
    for (const name of ["auth.sqlite", "auth.sqlite-wal", "auth.sqlite-shm", "installation-id"]) {
      tighten(join(paths.stateRoot, name), 0o600);
    }
    if (existsSync(paths.sessionsRoot)) {
      // cpSync preserves legacy modes, so recursively tighten copied session data.
      for (const path of new Bun.Glob("**/*").scanSync({ cwd: paths.sessionsRoot, absolute: true, onlyFiles: false })) {
        tighten(path, statSync(path).isDirectory() ? 0o700 : 0o600);
      }
    }
  } catch (error) {
    warn(`could not migrate legacy state from ${paths.legacyRoot}: ${error instanceof Error ? error.message : String(error)}. Legacy data was not deleted.`);
  }
}
