import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRepoMap } from "../source/repo-map.ts";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "redwake-map-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ module: "src/index.ts" }));
  writeFileSync(join(root, "src/index.ts"), `
export { Service } from "./service";
export interface Options { name: string; secret?: boolean }
export const create = (options: Options): Service => new Service(options);
`);
  writeFileSync(join(root, "src/service.ts"), `
import type { Options } from "./index";
export class Service {
  constructor(readonly options: Options) {}
  protected start(): Promise<void> { return Promise.resolve(); }
  private token = "secret";
}
function localImplementation() { return 1; }
`);
  return root;
}

describe("generateRepoMap", () => {
  test("produces stable source-like skeletons under the configured budget", () => {
    const root = fixture();
    try {
      const first = generateRepoMap({ workspaceRoot: root, maxTokens: 400 });
      const second = generateRepoMap({ workspaceRoot: root, maxTokens: 400 });
      expect(first.text).toBe(second.text);
      expect(first.estimatedTokens).toBeLessThanOrEqual(400);
      expect(first.text.startsWith("<repo_map>\n# files")).toBe(true);
      expect(first.text.endsWith("</repo_map>")).toBe(true);
      expect(first.text).toContain("src/index.ts");
      expect(first.text).toContain("export interface Options");
      expect(first.text).toContain("export class Service");
      expect(first.text).toContain("constructor(readonly options: Options)");
      expect(first.text).not.toContain('token = "secret"');
      expect(first.text).not.toContain("return Promise.resolve");
      expect(first.text).not.toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fallback discovery excludes ignored output and binary files", () => {
    const root = fixture();
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist/generated.js"), "export const generated = true");
      writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
      const result = generateRepoMap({ workspaceRoot: root, maxTokens: 500 });
      expect(result.text).not.toContain("dist/generated.js");
      expect(result.text).not.toContain("binary.dat");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
