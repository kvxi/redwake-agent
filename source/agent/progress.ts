export type AgentProgressEvent =
  | { type: "request_start" }
  | { type: "text_delta"; delta: string }
  | { type: "text_end" }
  | { type: "tool_start"; callId: string; name: string; input: unknown }
  | {
      type: "tool_finish";
      callId: string;
      name: string;
      durationMs: number;
      isError: boolean;
    }
  | { type: "status"; message: string }
  | { type: "turn_end" };

/** Progress handlers are synchronous presentation hooks. */
export type AgentProgressHandler = (event: AgentProgressEvent) => void;
