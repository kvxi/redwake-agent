/** Provider-independent interactive conversation boundary. */
export interface Conversation {
  runTurn(userMessage: string): Promise<void>;
}
