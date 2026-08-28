Oh My Pi treats a ChatGPT subscription as a separate provider—`openai-codex`—rather than using the normal `openai` API-key provider.

1. **Authentication:** `/login openai-codex` runs OpenAI’s Codex OAuth flow using PKCE and a localhost callback, with a device-code alternative for headless systems. It receives access, refresh, and identity tokens and extracts the ChatGPT workspace/account ID.
2. **Credential management:** Tokens are stored in the local SQLite auth store and refreshed automatically. Credentials are scoped per ChatGPT workspace; multiple subscriptions/accounts can be ranked and rotated based on quota and rate-limit state.
3. **Model discovery:** The OAuth token and workspace ID query ChatGPT’s Codex model endpoint. Returned models are normalized into Oh My Pi’s common model registry under names such as `openai-codex/<model>`.
4. **Inference adapter:** Agent messages, tools, reasoning settings, and history are translated into the Codex Responses wire format. Requests go to `https://chatgpt.com/backend-api/codex/responses`, carrying the OAuth bearer token, `chatgpt-account-id`, Codex compatibility headers, and session metadata. Responses stream back over SSE or WebSocket and are converted into Oh My Pi’s provider-neutral event format.
5. **Subscription accounting:** Because traffic reaches the ChatGPT Codex backend with the user’s OAuth identity—not `api.openai.com` with an API key—usage is charged against the subscription’s Codex limits. Oh My Pi also reads the Codex usage endpoint to monitor windows and route around exhausted credentials.

So the core pattern is:

**Agent runtime → provider-neutral model interface → Codex protocol adapter → ChatGPT subscription backend**, with OAuth/token refresh, model discovery, and quota-aware account selection alongside it.

Sources: [provider documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/providers.md), [OAuth implementation](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/registry/oauth/openai-codex.ts), [Codex transport](https://github.com/can1357/oh-my-pi/blob/main/packages/ai/src/providers/openai-codex-responses.ts), and [model discovery](https://github.com/can1357/oh-my-pi/blob/main/packages/catalog/src/discovery/codex.ts).
