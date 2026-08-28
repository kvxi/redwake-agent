In sessions storage: in addition to normal user/assistant/tool message objects, persist one lightweight **turn-completion event** for every model request—even when nothing visible was returned:

```json
{
  "id": 51,
  "parent": 50,
  "event": {
    "type": "turn_result",
    "turnId": "turn-17",
    "timestamp": "2026-08-28T13:04:12.381Z",
    "provider": "openai",
    "model": "gpt-5.6",
    "responseId": "resp_...",
    "responseStatus": "incomplete",
    "finishReason": "max_output_tokens",
    "outputItemTypes": ["reasoning"],
    "visibleTextChars": 0,
    "toolCallCount": 0,
    "inputTokens": 42110,
    "outputTokens": 4096,
    "reasoningTokens": 4096,
    "durationMs": 18432,
    "attempt": 1,
    "outcome": "empty_response"
  }
}
```

That completion event provides the key benefit: every user turn leaves a diagnostic result, including turns that produce no assistant message. Avoid storing raw hidden reasoning, credentials, or complete provider responses by default.