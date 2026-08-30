import { expect, test } from "bun:test";
import { compactHome, displayWidth, sanitizeSingleLine, truncateMiddle, wrapText } from "../source/ui/terminal-text.ts";

test("terminal text is ANSI-safe and display-width aware", () => {
  expect(displayWidth("\x1b[31m界é\x1b[0m")).toBe(3);
  expect(sanitizeSingleLine("a\n\x1b[2Jb\u0000")).toBe("a b");
  expect(wrapText("界界a", 3)).toEqual(["界", "界a"]);
});

test("paths compact home and truncate in the middle", () => {
  expect(compactHome("/home/me/work", "/home/me")).toBe("~/work");
  const value = truncateMiddle("~/one/two/three/file.ts", 12);
  expect(displayWidth(value)).toBeLessThanOrEqual(12);
  expect(value).toContain("…");
});
