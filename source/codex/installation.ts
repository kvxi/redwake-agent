import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDirectory, INSTALLATION_ID_PATH } from "../paths.ts";

export function installationId(path = INSTALLATION_ID_PATH): string {
  try {
    const value = readFileSync(path, "utf8").trim();
    if (/^[0-9a-f-]{36}$/i.test(value)) return value;
  } catch {}
  const value = crypto.randomUUID();
  ensurePrivateDirectory(dirname(path));
  try {
    writeFileSync(path, `${value}\n`, { mode: 0o600, flag: "wx" });
  } catch {
    try {
      const existing = readFileSync(path, "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
    } catch {}
  }
  try { chmodSync(path, 0o600); } catch {}
  return value;
}
