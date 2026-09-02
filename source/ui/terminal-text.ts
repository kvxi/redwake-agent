import stringWidth from "string-width";

// Includes OSC (including OSC 8 hyperlinks), CSI, and short ESC sequences.
// Keeping this centralized makes width/wrapping code treat trusted hyperlinks
// as zero-width while also removing controls supplied by transcript text.
export const ANSI_ESCAPE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

/** Remove terminal controls while retaining intentional line boundaries. */
export function sanitizeTerminalText(text: string): string {
  return stripAnsi(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export function sanitizeSingleLine(text: string): string {
  return sanitizeTerminalText(text)
    .replace(/[\n]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

const URL_TOKEN = /https?:\/\/[^\s<>"']+/g;

/** Add OSC 8 only around URLs found in already-sanitized, trusted output. */
export function linkifyUrls(text: string): string {
  const clean = sanitizeTerminalText(text);
  return clean.replace(URL_TOKEN, (token) => {
    const suffix = token.match(/[.,;:!?]+$/)?.[0] ?? "";
    const url = suffix ? token.slice(0, -suffix.length) : token;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return token;
      // The complete URL is also the label, so terminals without OSC 8 support
      // still show (and copies retain) exactly the usable plain URL.
      return `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\${suffix}`;
    } catch { return token; }
  });
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
