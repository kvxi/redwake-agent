import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { generateRepoMap, isBroadWorkspace, readRepoMapPrefix } from "../source/repo-map.ts";

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

const nonGit = () => ({ status: 128, stdout: "" });

describe("repository map safety budgets", () => {
  test("home, root, and home aliases skip discovery, but projects do not", () => {
    const root = fixture();
    const alias = `${root}-alias`;
    const gitFiles = mock(nonGit);
    try {
      symlinkSync(root, alias);
      for (const workspaceRoot of [root, alias, parse(root).root]) {
        const result = generateRepoMap({ workspaceRoot, homeDirectory: root, gitFiles });
        expect(result.text).toBe("");
        expect(result.estimatedTokens).toBe(0);
      }
      expect(gitFiles).not.toHaveBeenCalled();
      expect(isBroadWorkspace(join(root, "src"), root)).toBe(false);
    } finally {
      rmSync(alias, { force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const limits of [{ files: 1 }, { entries: 1 }, { depth: 0 }, { sourceFiles: 1 }, { totalSourceBytes: 1 }]) {
    test(`returns a partial map for ${JSON.stringify(limits)}`, () => {
      const root = fixture();
      try {
        const result = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit, limits, maxTokens: 500 });
        expect(result.text).toContain("map truncated by scan limits");
        expect(result.estimatedTokens).toBeLessThanOrEqual(500);
        expect(result.includedFiles).toBeLessThanOrEqual(1);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }

  test("wide and deep trees stop with bounded traversal and a tiny output budget", () => {
    const root = fixture();
    try {
      for (let index = 0; index < 50; index++) mkdirSync(join(root, `empty-${index}`));
      mkdirSync(join(root, "deep/a/b/c/d/e/f"), { recursive: true });
      writeFileSync(join(root, "deep/a/b/c/d/e/f/hidden.ts"), "export const hidden = true;");
      const result = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit, limits: { entries: 10, depth: 2 }, maxTokens: 32 });
      expect(result.text).toContain("map truncated by scan limits");
      expect(result.text).not.toContain("hidden");
      expect(result.estimatedTokens).toBeLessThanOrEqual(32);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("deadline and Git transport failures omit work without unbounded fallback", () => {
    const root = fixture();
    try {
      let ticks = 0;
      const expired = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit, now: () => ticks++, limits: { discoveryMs: 1 } });
      expect(expired.text).not.toContain("src/index.ts");
      expect(expired.text).toContain("map truncated");
      for (const code of ["ETIMEDOUT", "ENOBUFS"]) {
        const result = generateRepoMap({ workspaceRoot: root, gitFiles: () => ({ status: null, stdout: "src/index.ts\0", error: { code } }) });
        expect(result.text).not.toContain("src/index.ts");
        expect(result.text).toContain("map truncated");
      }
      const missingGit = generateRepoMap({ workspaceRoot: root, gitFiles: () => ({ status: null, stdout: "", error: { code: "ENOENT" } }) });
      expect(missingGit.text).toContain("src/index.ts");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Git candidates obey limits and reject symlinks, escaping and missing paths", () => {
    const root = fixture();
    try {
      symlinkSync(join(root, "src"), join(root, "linked"));
      symlinkSync(join(root, "src/index.ts"), join(root, "alias.ts"));
      const gitFiles = () => ({ status: 0, stdout: "../escape.ts\0/missing.ts\0linked/index.ts\0alias.ts\0missing.ts\0src/index.ts\0src/service.ts\0" });
      const result = generateRepoMap({ workspaceRoot: root, gitFiles, maxTokens: 500 });
      expect(result.text).toContain("src/index.ts");
      for (const excluded of ["escape", "missing", "linked", "alias"]) expect(result.text).not.toContain(excluded);
      const capped = generateRepoMap({ workspaceRoot: root, gitFiles, limits: { files: 1 }, maxTokens: 500 });
      expect(capped.text).toContain("map truncated");
      expect(capped.text).not.toContain("src/service.ts");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("prefix reads are bounded and oversized sources receive no skeletons", () => {
    const root = fixture();
    try {
      const path = join(root, "large.ts");
      writeFileSync(path, `export const oversized = true;\n${" ".repeat(300_000)}`);
      expect(readRepoMapPrefix(path, 8_192)).toHaveLength(8_192);
      expect(readRepoMapPrefix(path, 10).toString()).toBe("export con");
      const result = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit, maxTokens: 500 });
      expect(result.text).toContain("large.ts");
      expect(result.text).not.toContain("export const oversized");
      expect(result.text).toContain("map truncated");
      // TypeScript must not load excluded sources via tsconfig or imports.
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist/hidden.ts"), "export const hidden = 1;");
      writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ files: ["dist/hidden.ts"] }));
      writeFileSync(join(root, "src/index.ts"), 'export { hidden } from "../dist/hidden";');
      const isolated = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit, maxTokens: 500 });
      expect(isolated.text).not.toContain("export const hidden");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("prefix reads cap actual IO and close descriptors on success and failure", () => {
  const root = fixture();
  const read = spyOn(fs, "readSync");
  const close = spyOn(fs, "closeSync");
  try {
    const path = join(root, "large.bin");
    writeFileSync(path, Buffer.alloc(1_000_000, 1));
    expect(readRepoMapPrefix(path, 8_192)).toHaveLength(8_192);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[2]).toEqual({ offset: 0, length: 8_192 });
    expect(close).toHaveBeenCalledTimes(1);
    read.mockImplementation(() => { throw Object.assign(new Error("Unreadable"), { code: "EACCES" }); });
    expect(() => readRepoMapPrefix(path, 8_192)).toThrow("Unreadable");
    expect(close).toHaveBeenCalledTimes(2);
    const result = generateRepoMap({ workspaceRoot: root, gitFiles: nonGit });
    expect(result.text).not.toContain("large.bin");
    expect(result.text).not.toContain("Repository map unavailable");
  } finally {
    read.mockRestore();
    close.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
