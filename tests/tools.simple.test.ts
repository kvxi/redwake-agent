import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolContext, ToolError, type ToolContext } from "../source/tools/context.ts";
import { readTool } from "../source/tools/read.ts";
import { writeTool } from "../source/tools/write.ts";
import { editTool } from "../source/tools/edit.ts";
import { bashTool } from "../source/tools/bash.ts";

let dir: string;
let ctx: ToolContext;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "redwake-"));
  ctx = createToolContext();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("read", () => {
  test("numbers lines and honors view_range", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "a\nb\nc\n");
    expect(await readTool.handler({ file_path: file }, ctx)).toBe("1: a\n2: b\n3: c");
    expect(await readTool.handler({ file_path: file, view_range: [2, 3] }, ctx)).toBe(
      "2: b\n3: c",
    );
    expect(await readTool.handler({ file_path: file, view_range: [2, -1] }, ctx)).toBe(
      "2: b\n3: c",
    );
  });

  test("rejects directories and binary files", async () => {
    await expect(readTool.handler({ file_path: dir }, ctx)).rejects.toThrow(ToolError);
    const bin = join(dir, "b.bin");
    await writeFile(bin, Buffer.from([0x41, 0x00, 0x42]));
    await expect(readTool.handler({ file_path: bin }, ctx)).rejects.toThrow(
      /binary/,
    );
  });

  test("truncates at the line ceiling", async () => {
    const file = join(dir, "big.txt");
    const lines = Array.from({ length: 1001 }, (_, i) => `line${i}`);
    await writeFile(file, lines.join("\n"));
    const out = (await readTool.handler({ file_path: file }, ctx)) as string;
    const rendered = out.split("\n");
    expect(rendered).toHaveLength(1001); // 1000 lines + truncation marker
    expect(rendered[1000]).toContain("output truncated");
  });
});

describe("write", () => {
  test("creates files and parent dirs", async () => {
    const file = join(dir, "nested/deep/f.txt");
    const msg = await writeTool.handler({ file_path: file, contents: "hi" }, ctx);
    expect(msg).toContain("Successfully wrote");
    expect(await readFile(file, "utf-8")).toBe("hi");
  });

  test("refuses to overwrite an unread existing file", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "old");
    await expect(
      writeTool.handler({ file_path: file, contents: "new" }, ctx),
    ).rejects.toThrow(/unread/);
    await readTool.handler({ file_path: file }, ctx);
    await writeTool.handler({ file_path: file, contents: "new" }, ctx);
    expect(await readFile(file, "utf-8")).toBe("new");
  });
});

describe("edit", () => {
  test("replaces exactly one occurrence after a read", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "hello world");
    await readTool.handler({ file_path: file }, ctx);
    const msg = await editTool.handler(
      { file_path: file, old_string: "world", new_string: "there" },
      ctx,
    );
    expect(msg).toContain("Successfully replaced");
    expect(await readFile(file, "utf-8")).toBe("hello there");
  });

  test("enforces read-before-edit via the overwrite guard", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "hello world");
    await expect(
      editTool.handler({ file_path: file, old_string: "world", new_string: "x" }, ctx),
    ).rejects.toThrow(/unread/);
  });

  test("rejects zero and multiple matches", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "a a");
    await readTool.handler({ file_path: file }, ctx);
    await expect(
      editTool.handler({ file_path: file, old_string: "z", new_string: "y" }, ctx),
    ).rejects.toThrow(/No exact match/);
    await expect(
      editTool.handler({ file_path: file, old_string: "a", new_string: "y" }, ctx),
    ).rejects.toThrow(/multiple/);
  });

  test("treats new_string literally (no $-pattern expansion)", async () => {
    const file = join(dir, "f.txt");
    await writeFile(file, "cost X");
    await readTool.handler({ file_path: file }, ctx);
    await editTool.handler(
      { file_path: file, old_string: "X", new_string: "$1 & $&" },
      ctx,
    );
    expect(await readFile(file, "utf-8")).toBe("cost $1 & $&");
  });
});

describe("bash", () => {
  test("captures stdout, stderr, and exit code", async () => {
    expect(await bashTool.handler({ command: "echo hi" }, ctx)).toEqual({
      stdout: "hi\n",
      stderr: "",
      exit_code: 0,
    });
    expect(await bashTool.handler({ command: "echo err 1>&2" }, ctx)).toEqual({
      stdout: "",
      stderr: "err\n",
      exit_code: 0,
    });
    const failed = (await bashTool.handler({ command: "exit 3" }, ctx)) as {
      exit_code: number;
    };
    expect(failed.exit_code).toBe(3);
  });
});
