/** Provider-independent interactive conversation boundary. */
export interface Conversation {
  runTurn(userMessage: string, signal?: AbortSignal): Promise<void>;
}
