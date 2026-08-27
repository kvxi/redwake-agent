import { describe, expect, test } from "bun:test";
import {
  AgentBase,
  type NormalizedToolCall,
} from "../source/agent/base.ts";

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
});
