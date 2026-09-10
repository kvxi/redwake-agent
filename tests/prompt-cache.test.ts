import { expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateRepoMap } from "../source/repo-map.ts";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "@anthropic-ai/sdk/resources/messages";
import { AnthropicAgent } from "../source/agent/anthropic.ts";
import { SessionPrompt } from "../source/agent/session-prompt.ts";
import { buildSystemPromptParts } from "../source/agent/system-prompt.ts";

const response = {
  id: "message",
  type: "message",
  role: "assistant",
  model: "test",
  content: [],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 0, output_tokens: 0 },
} as unknown as Message;

test("Anthropic caches the final stable repository-map block", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    messages: {
      create: mock(async (params: Record<string, unknown>) => {
        calls.push(structuredClone(params));
        return response;
      }),
    },
  } as unknown as Anthropic;
  const prompt = buildSystemPromptParts({
    cwd: "/workspace",
    repoMap: "<repo_map>\n# files\nsource/main.ts\n</repo_map>",
  });
  const agent = new AnthropicAgent({ client, systemPrompt: prompt });

  await agent.createMessage();
  await agent.createMessage();

  expect(calls[0]!.system).toEqual([
    { type: "text", text: prompt.prefix },
    { type: "text", text: prompt.repoMap, cache_control: { type: "ephemeral" } },
  ]);
  expect(calls[1]!.system).toEqual(calls[0]!.system);
  expect(prompt.text.endsWith("</repo_map>")).toBe(true);
});

test("SessionPrompt refreshes only when explicitly requested", () => {
  let generations = 0;
  const session = new SessionPrompt("/workspace", {
    generateRepoMap: () => {
      generations += 1;
      return {
        text: `<repo_map>\ngeneration ${generations}\n</repo_map>`,
        estimatedTokens: 10,
        includedFiles: 0,
        omittedFiles: 0,
        includedSymbols: 0,
        omittedSymbols: 0,
      };
    },
  });
  const first = session.snapshot();
  expect(session.snapshot()).toBe(first);
  expect(generations).toBe(1);
  session.refresh();
  expect(generations).toBe(2);
  expect(session.snapshot()).not.toBe(first);
});

test("skipped and partial maps preserve context and immutable session snapshots", () => {
  const root = mkdtempSync(join(tmpdir(), "rwa-prompt-"));
  try {
    writeFileSync(join(root, "AGENTS.md"), "Project guidance.");
    let skipped = true;
    const session = new SessionPrompt(root, {
      customPrompt: "Custom instructions.",
      contextFiles: [{ path: "guide.md", content: "Extra context." }],
      generateRepoMap: (options) => generateRepoMap({
        ...options, homeDirectory: skipped ? root : join(root, "other-home"),
        gitFiles: () => ({ status: 128, stdout: "" }), limits: { entries: 0 },
      }),
    });
    const first = session.snapshot();
    expect(first.repoMap).toBeUndefined();
    for (const text of ["Custom instructions.", "Project guidance.", "Extra context."]) expect(first.text).toContain(text);
    skipped = false;
    expect(session.snapshot()).toBe(first);
    session.refresh();
    const partial = session.snapshot();
    expect(partial.repoMap).toContain("map truncated");
    expect(first.repoMap).toBeUndefined();
    expect(session.snapshot()).toBe(partial);
    skipped = true;
    session.refresh();
    expect(session.snapshot().repoMap).toBeUndefined();
    expect(partial.repoMap).toContain("map truncated");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
