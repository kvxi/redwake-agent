const MAX_VISIBLE_LENGTH = 120;

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const flattened = value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!flattened) return undefined;
  if (flattened.length <= MAX_VISIBLE_LENGTH) return flattened;
  return `${flattened.slice(0, MAX_VISIBLE_LENGTH - 1)}…`;
}

function field(input: unknown, name: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  return clean((input as Record<string, unknown>)[name]);
}

export function summarizeToolName(name: string): string {
  return clean(name) ?? "tool";
}

/** Summarizes only allowlisted fields; arbitrary input is never serialized. */
export function summarizeToolCall(name: string, input: unknown): string {
  let prefix: string | undefined;
  let value: string | undefined;
  switch (name) {
    case "read": prefix = "Reading"; value = field(input, "file_path"); break;
    case "write": prefix = "Writing"; value = field(input, "file_path"); break;
    case "edit": prefix = "Editing"; value = field(input, "file_path"); break;
    case "bash": prefix = "Running:"; value = field(input, "command"); break;
    case "search": prefix = "Searching:"; value = field(input, "query"); break;
    case "fetch": prefix = "Fetching"; value = field(input, "url"); break;
  }
  return prefix && value ? `${prefix} ${value}` : `Running ${summarizeToolName(name)}`;
}

export function formatDuration(durationMs: number): string {
  const safe = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  return safe < 1000 ? `${Math.round(safe)} ms` : `${(safe / 1000).toFixed(1)} s`;
}
