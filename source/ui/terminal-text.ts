import stringWidth from "string-width";

export const ANSI_ESCAPE = /\x1B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export function sanitizeSingleLine(text: string): string {
  return stripAnsi(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function displayWidth(text: string): number {
  return stringWidth(stripAnsi(text));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function graphemes(text: string): string[] {
  return [...segmenter.segment(text)].map((item) => item.segment);
}

export function truncateEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  let result = "";
  for (const part of graphemes(stripAnsi(text))) {
    if (displayWidth(result + part) > width - 1) break;
    result += part;
  }
  return `${result}…`;
}

export function truncateStart(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  let result = "";
  for (const part of graphemes(stripAnsi(text)).reverse()) {
    if (displayWidth(part + result) > width - 1) break;
    result = part + result;
  }
  return `…${result}`;
}

export function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  if (width === 1) return "…";
  const parts = graphemes(stripAnsi(text));
  let left = "", right = "", takeLeft = true;
  while (parts.length) {
    const part = takeLeft ? parts.shift()! : parts.pop()!;
    const nextLeft = takeLeft ? left + part : left;
    const nextRight = takeLeft ? right : part + right;
    if (displayWidth(nextLeft) + displayWidth(nextRight) + 1 > width) break;
    left = nextLeft;
    right = nextRight;
    takeLeft = !takeLeft;
  }
  return `${left}…${right}`;
}

export function compactHome(path: string, home = process.env.HOME): string {
  if (!home) return path;
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function compactPath(path: string, width: number, home = process.env.HOME): string {
  return truncateMiddle(compactHome(path, home), width);
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [""];
  const output: string[] = [];
  for (const sourceLine of stripAnsi(text).split("\n")) {
    if (!sourceLine) { output.push(""); continue; }
    let line = "";
    for (const part of graphemes(sourceLine)) {
      if (displayWidth(line + part) > width && line) {
        output.push(line);
        line = part.trimStart();
      } else line += part;
    }
    output.push(line);
  }
  return output.length ? output : [""];
}

export function padDisplay(text: string, width: number): string {
  const clean = truncateEnd(text, width);
  return clean + " ".repeat(Math.max(0, width - displayWidth(clean)));
}
