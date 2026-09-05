import { describe, expect, test } from "bun:test";
import {
  AgentBase,
  type NormalizedToolCall,
} from "../source/agent/base.ts";
import type { AgentProgressEvent } from "../source/agent/progress.ts";
import { ConversationState } from "../source/session/conversation-state.ts";

interface FakeResponse {
  text: string;
  calls: NormalizedToolCall[];
}

interface FakeToolResult {
  id: string;
  content: string;
  isError: boolean;
}

class FakeAgent extends AgentBase<FakeResponse, FakeToolResult> {
  readonly userMessages: string[] = [];
  readonly remembered: FakeResponse[] = [];
  readonly submittedResults: FakeToolResult[][] = [];
  private readonly responses: FakeResponse[];

  constructor(responses: FakeResponse[], print: (text: string) => void) {
    super({ print });
    this.responses = responses;
  }

  protected appendUser(userMessage: string): void {
    this.userMessages.push(userMessage);
  }

  protected request(): Promise<FakeResponse> {
    const response = this.responses.shift();
    if (!response) throw new Error("Unexpected provider request");
    return Promise.resolve(response);
  }

  protected remember(response: FakeResponse): void {
    this.remembered.push(response);
  }

  protected responseText(response: FakeResponse): string {
    return response.text;
  }

  protected toolCalls(response: FakeResponse): Iterable<NormalizedToolCall> {
    return response.calls;
  }

  protected encodeToolResult(
    call: NormalizedToolCall,
    content: string,
    isError: boolean,
  ): FakeToolResult {
    return { id: call.id, content, isError };
  }

  protected appendToolResults(results: FakeToolResult[]): void {
    this.submittedResults.push(results);
  }
}

class ControlledAgent extends AgentBase<FakeResponse, FakeToolResult> {
  readonly remembered: FakeResponse[] = [];

  constructor(
    conversation: ConversationState,
    progress: (event: AgentProgressEvent) => void,
    private readonly requester: (signal?: AbortSignal) => Promise<FakeResponse>,
  ) {
    super({ conversation, progress });
  }

  protected appendUser(): void {}
  protected request(signal?: AbortSignal): Promise<FakeResponse> { return this.requester(signal); }
  protected remember(response: FakeResponse): void { this.remembered.push(response); }
  protected responseText(response: FakeResponse): string { return response.text; }
  protected toolCalls(response: FakeResponse): Iterable<NormalizedToolCall> { return response.calls; }
  protected encodeToolResult(call: NormalizedToolCall, content: string, isError: boolean): FakeToolResult {
    return { id: call.id, content, isError };
  }
  protected appendToolResults(): void {}
}

describe("AgentBase", () => {
  test("continues through tools then emits the final response", async () => {
    const printed: string[] = [];
    const agent = new FakeAgent(
      [
        {
          text: "",
          calls: [
            {
              id: "call-1",
              name: "bash",
              decodeInput: () => ({ command: "echo hi" }),
            },
          ],
        },
        { text: "done", calls: [] },
      ],
      (text) => printed.push(text),
    );

    await agent.runTurn("go");

    expect(agent.userMessages).toEqual(["go"]);
    expect(agent.remembered).toHaveLength(2);
    expect(agent.submittedResults).toEqual([
      [
        {
          id: "call-1",
          content: JSON.stringify({ stdout: "hi\n", stderr: "", exit_code: 0 }),
          isError: false,
        },
      ],
    ]);
    expect(printed).toEqual(["done"]);
  });

  test("encodes input decoding failures as tool errors", async () => {
    const agent = new FakeAgent(
      [
        {
          text: "",
          calls: [
            {
              id: "call-2",
              name: "bash",
              decodeInput: () => {
                throw new Error("Invalid JSON arguments");
              },
            },
          ],
        },
        { text: "", calls: [] },
      ],
      () => {},
    );

    await agent.runTurn("go");

    expect(agent.submittedResults).toEqual([
      [
        {
          id: "call-2",
          content: JSON.stringify({ error: "Invalid JSON arguments" }),
          isError: true,
        },
      ],
    ]);
  });

  test("records cancellation while a provider request is pending", async () => {
    const conversation = new ConversationState();
    const progress: AgentProgressEvent[] = [];
    const agent = new ControlledAgent(conversation, (event) => progress.push(event), (signal) =>
      new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    );
    const controller = new AbortController();

    const turn = agent.runTurn("stop", controller.signal);
    controller.abort();

    await expect(turn).rejects.toHaveProperty("name", "AbortError");
    expect(conversation.events).toEqual([
      { type: "user", content: "stop" },
      { type: "turn_interrupted" },
    ]);
    expect(progress.slice(-2).map((event) => event.type)).toEqual(["turn_interrupted", "turn_end"]);
  });

  test("does not accept a response that races with cancellation", async () => {
    const conversation = new ConversationState();
    const controller = new AbortController();
    const agent = new ControlledAgent(conversation, () => {}, async () => {
      controller.abort();
      return { text: "too late", calls: [{ id: "late", name: "bash", input: { command: "echo no" } }] };
    });

    await expect(agent.runTurn("race", controller.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(agent.remembered).toEqual([]);
    expect(conversation.events).toEqual([
      { type: "user", content: "race" },
      { type: "turn_interrupted" },
    ]);
  });

  test("does not mark unrelated provider failures as interruptions", async () => {
    const conversation = new ConversationState();
    const agent = new ControlledAgent(conversation, () => {}, async () => { throw new Error("provider failed"); });

    await expect(agent.runTurn("fail", new AbortController().signal)).rejects.toThrow("provider failed");
    expect(conversation.events).toEqual([{ type: "user", content: "fail" }]);
  });
});
