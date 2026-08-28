# ChatGPT Subscription (`openai-codex`) Implementation Plan

## Goal and boundaries

Add ChatGPT subscription access as a third provider, `openai-codex`. It must remain separate from `openai`: the latter continues to use `OPENAI_API_KEY` and the public Responses API, while `openai-codex` uses OpenAI OAuth and the ChatGPT Codex backend.

```text
runRepl / ConversationState
  -> provider-neutral Conversation (AgentBase)
  -> CodexAgent + CodexTransport
  -> https://chatgpt.com/backend-api/codex/responses
```

Preserve Redwake's canonical session history, tools, branching, and provider switching. Credentials and quota state are global user state and must never enter project `.env` files or session JSONL.

> The ChatGPT backend and OAuth client details are not the public `api.openai.com` contract and can change. Isolate endpoint/header/event assumptions, pin a tested Codex client compatibility version, fail clearly on contract drift, and confirm OpenAI's current terms before release.

## Fit with the current source

Redwake already has the right runtime seam:

- `source/config.ts` owns provider/model defaults.
- `source/agent/factory.ts` selects provider adapters.
- `source/agent/base.ts` owns the provider-independent user/tool loop.
- `source/agent/openai.ts` demonstrates Responses history and function calls, but is API-key/SDK-specific.
- `source/agent/history.ts` reconstructs wire history from `ConversationState`, so changing provider or credential does not lose context.
- `source/main.ts` owns local slash commands.

Do **not** point `OpenAIAgent` at ChatGPT or give its SDK an OAuth token. Add a sibling `CodexAgent`, preventing accidental fallback to paid API usage.

## Proposed modules

```text
source/
  auth/
    types.ts
    store.ts                 # bun:sqlite schema and CRUD
    openai-codex-oauth.ts    # PKCE browser/device login and JWT claims
    credential-manager.ts    # refresh, rank, lease, and failure handling
  codex/
    constants.ts             # URLs, headers, pinned client version
    wire.ts                  # validated request/event/response types
    sse.ts                   # incremental SSE decoder
    transport.ts             # authenticated POST and event accumulation
    models.ts                # model discovery/cache normalization
    usage.ts                 # quota endpoint normalization
  agent/
    codex.ts                 # AgentBase adapter
```

Inject `fetch`, clock, random UUIDs, browser opener, and auth store where practical so tests never need live OpenAI access.

## 1. Provider and model selection

1. Extend `Provider` in `source/config.ts` to `"anthropic" | "openai" | "openai-codex"` and add a conservative Codex fallback model. `PROVIDER=openai-codex MODEL=<slug>` remains an explicit override.
2. Replace hard-coded provider checks/prompts in `source/main.ts` with shared parsing. Add `openai-codex` to `/model` and errors.
3. Add a small `ModelDescriptor`/`ModelCatalog`: static configured entries for Anthropic/OpenAI and authenticated discovery for Codex. Use `{ provider, id, displayName, contextWindow?, maxOutputTokens?, reasoning?, priority? }`.
4. Change the factory boundary from `factory(provider)` to `factory({ provider, model })`. Keep it synchronous by doing Codex discovery in startup/REPL orchestration and passing the chosen model to the constructor.
5. Selecting Codex in `/model` should list discovered model slugs and prompt for one, defaulting to the highest-priority usable model or `MODEL`. If unauthenticated, say `Run /login openai-codex`; do not create a broken adapter.
6. Keep `ConversationState` and `ToolContext` when changing provider/model, then reconstruct the adapter so it snapshots canonical history.
7. Never silently fall back from `openai-codex` to `openai`, since that can create API charges.

## 2. OAuth commands

Add an injected auth service to `ReplOptions`, then support:

- `/login openai-codex`
- `/login openai-codex --device`
- `/logout openai-codex [account-id]`
- `/status openai-codex`

These commands stay local and are not appended to `ConversationState`. Update unknown-command help, README setup, and examples.

### Browser PKCE flow

1. Generate independent high-entropy verifier/state values with Web Crypto and an S256 challenge.
2. Bind a temporary server only to loopback at the registered callback. The current reference uses `http://localhost:1455/auth/callback`; if that fixed port is occupied, suggest device login rather than selecting another port.
3. Build the authorize URL from centralized constants, with `openid profile email offline_access` and the currently required Codex scopes/parameters. Print it and attempt a best-effort platform browser open.
4. Validate path, state, OAuth error fields, and one authorization code. Apply timeout/cancellation and always close the listener.
5. Exchange code/verifier at `https://auth.openai.com/oauth/token`, validate the response, and only then persist it.
6. Decode JWT payloads to extract `chatgpt_account_id`, normalized email, plan, expiry, and optional data/compute residency. Decoding is not independent signature verification; trust comes from the successful TLS exchange. Reject tokens without a workspace ID.
7. Upsert by `(provider, account_id)`, allowing personal and Team/Enterprise workspaces for one email. Never log tokens, callback codes, or full JWTs.

Keep client ID, exact scopes, authorization extras, callback, and originator in one compatibility block and verify them against the current reference implementation when building the feature.

### Device flow

Request a device/user code from the current OpenAI device endpoint, display its URL/code, and poll at the server interval plus a safety margin. Bound polling by expiry/maximum duration and honor cancellation. On authorization, exchange the returned code/verifier and use the same validation/storage path as browser login.

`/logout` lists redacted identities if multiple workspaces exist, requires a choice, and transactionally removes tokens and related cache/quota rows.

## 3. Credential store and refresh

Use Bun's built-in `bun:sqlite` at a global path such as `~/redwake/agent/auth.sqlite`, exposed beside `SESSIONS_ROOT` in config. Include a `schema_migrations` table and initially store:

```text
oauth_credentials
  provider, account_id (unique), email, plan_type, residency
  access_token, refresh_token, id_token, expires_at
  created_at, updated_at, last_used_at, disabled_at, last_auth_error

quota_state
  provider, account_id, primary_used_percent, primary_reset_at
  secondary_used_percent, secondary_reset_at
  blocked_until, last_http_status, observed_at

model_cache
  provider, account_id, etag, payload_json, fetched_at
```

Requirements:

- Create the directory/database as user-only (`0700`/`0600`) where supported and reject obviously unsafe ownership/permissions. Document that filesystem protection is the initial design; OS-keychain encryption can follow.
- Enable foreign keys and transact upsert, logout, and refresh replacement.
- Refresh before expiry (for example, 60-second skew). Preserve an old refresh token if the response validly omits rotation; atomically replace it when rotated.
- Deduplicate refreshes in-process. Reread in a write transaction to account for another Redwake process refreshing first.
- Disable only the affected credential on `invalid_grant`/definitive auth failure. Do not erase it for network or 5xx errors.
- Never include secrets in exceptions, diagnostics, session files, or model caches.
- Optionally accept `OPENAI_CODEX_OAUTH_TOKEN` as an ephemeral, non-refreshable override; derive/require its workspace and never persist it implicitly.

`CredentialManager.lease(model)` returns a valid token/workspace pair. Rank enabled credentials by model eligibility, non-exhausted quota, lowest usage/earliest reset, then least recently used. Prefer session affinity until a credential is unavailable instead of rotating every request.

## 4. Model discovery

`source/codex/models.ts` should query `https://chatgpt.com/backend-api/codex/models`, with `/models` only as a tested compatibility fallback. Send bearer auth, `chatgpt-account-id`, current beta/version/originator headers, JSON accept, and token-derived residency when present.

Accept `{ models: [...] }` and `{ data: [...] }`. Normalize `slug`/`id`, display name, visibility, context window, reasoning levels, input modalities, priority, and transport hints; drop hidden/malformed entries. Display IDs as `openai-codex/<slug>`, but send only the slug to the backend.

Cache each workspace's validated response with ETag/time. Use conditional requests if supported. On transient failure, permit a recent cache or explicit `MODEL`, but do not invent a model. Refresh after login, explicit model selection, cache expiry, or model-not-found. Since catalogs differ by workspace, retain account eligibility per model and lease only eligible credentials.

## 5. Codex adapter and transport

### Agent integration

Implement `CodexAgent` as `AgentBase<CodexTurnResponse, CodexFunctionOutput>` and mirror—not inherit—`OpenAIAgent`:

- Initialize with `toOpenAIHistory(this.conversation.snapshot(...))`.
- Append Responses-style user items and use `buildSystemPrompt()`.
- Reuse `toOpenAITools()` so current tool schemas/names are unchanged.
- Preserve returned output items before appending `function_call_output`, as `OpenAIAgent.remember()` does.
- Convert calls to `NormalizedToolCall`; `AgentBase` remains the only tool executor and session-event writer.

`CodexTransport.createResponse()` posts a validated body containing the chosen model, instructions, input, tools, tested output/reasoning options, and `stream: true` to `/codex/responses`. Do not pass arbitrary OpenAI SDK options: the private subscription wire contract is not identical to the public API.

Generate one persisted installation ID, one session/thread ID per Redwake session, and one turn ID per user turn (reused for tool continuations if required). Centralize compatibility headers/metadata: bearer token, account ID, Responses beta negotiation, pinned version, content/accept types, user agent/originator, session identity, and optional residency. Snapshot-test the exact request.

### SSE

Build an incremental parser handling arbitrary chunk boundaries, CRLF/LF, multiline `data:`, comments/heartbeats, and a final unterminated line. Validate events and accumulate:

- output text deltas/final text;
- reasoning **summaries**, never hidden chain-of-thought;
- function call items and argument deltas keyed by item/call ID;
- final status/response ID;
- usage/rate-limit metadata;
- structured API errors.

The first slice may buffer SSE into `CodexTurnResponse` and let existing `AgentBase` print final text. A follow-up can add optional `onTextDelta` support to `Conversation`/`AgentBase`; ensure final text is persisted once and not printed twice. Do not use the OpenAI SDK's API-key assumptions for this transport.

Treat malformed/incomplete streams as failures, not successful partial assistant turns. A 401 triggers one refresh/retry. A pre-stream 429 can mark the credential blocked and lease another eligible workspace. Retry transient 5xx/network failures with bounded exponential backoff only before observable output; never replay automatically after text/tool-call output, where duplicate actions are possible. Honor `Retry-After` and cancellation.

WebSocket support is deliberately later. Ship correct SSE first, then add WS behind a capability flag with automatic fallback and its own protocol tests.

## 6. Usage and account routing

Query the current authenticated usage endpoint (currently observed as `GET https://chatgpt.com/backend-api/wham/usage`; also validate whether `/codex/usage` is the active contract for the pinned client). Keep this path configurable inside `constants.ts`, not user-facing configuration.

Normalize primary/secondary used percentages, window/reset times, plan, and exhausted state into `QuotaWindow`; preserve unknown fields only in debug fixtures, not runtime logic. Refresh usage:

- after login and `/status`;
- periodically with a reasonable TTL, not before every model request;
- after 429/rate-limit metadata;
- from rate-limit information included in response events/headers.

Routing rules:

1. Keep a healthy session-affine workspace.
2. Exclude credentials with an active exhausted/blocked window.
3. On pre-output 429, record reset/`Retry-After`, select another eligible workspace, and retry once per candidate.
4. If all are exhausted, report redacted accounts and nearest known reset; never switch to API-key OpenAI.
5. On success, update `last_used_at` and any streamed usage state.

Always send the leased credential's matching `chatgpt-account-id`; never combine a token from one workspace with another workspace ID.

## 7. Delivery order

### Phase A — seams and local auth

- Add provider/config/factory types and generic provider parsing.
- Add SQLite migrations/store and credential manager.
- Add browser/device OAuth plus login/logout/status commands.
- Unit-test all of the above without live credentials.

**Exit:** multiple workspaces can be added, listed redacted, refreshed, and removed; existing providers/tests still pass.

### Phase B — discovery and one-turn inference

- Add constants, wire validators, discovery/cache, SSE parser, and transport.
- Add `CodexAgent` and factory selection.
- Support text-only and tool-free turns, then function-call continuations using existing `AgentBase`.

**Exit:** `PROVIDER=openai-codex` and `/model` complete a subscription-backed turn, and request inspection proves no call to `api.openai.com`.

### Phase C — resilience and multiple accounts

- Add usage normalization, session affinity, quota ranking, 401 refresh, safe retry/rotation, cancellation, and redacted diagnostics.
- Handle account-specific model eligibility and stale discovery.

**Exit:** a simulated exhausted workspace rotates before output; invalid auth disables only that workspace; all exhausted produces a useful no-fallback error.

### Phase D — UX and optional streaming improvements

- Add live text deltas without duplicate persistence/printing.
- Add optional WebSocket transport only after SSE is stable.
- Document private-contract maintenance and compatibility-version upgrades.

## 8. Test plan

Add `tests/auth.*.test.ts`, `tests/codex.*.test.ts`, and extend factory/REPL tests.

- **OAuth:** PKCE challenge, state mismatch, callback error/timeout, occupied port, device pending/expiry, malformed token response, JWT base64url claims, refresh rotation, redacted errors.
- **Store:** migrations, permissions where testable, workspace uniqueness, same-email multiple accounts, transactions, logout cascade, concurrent refresh deduplication.
- **Discovery:** both envelope shapes, hidden/malformed models, sorting, ETag/cache fallback, per-workspace eligibility, 401/429.
- **SSE fixtures:** byte-by-byte chunks, CRLF, multiline data, heartbeats, text, reasoning summary, interleaved call argument deltas, API error, incomplete stream, usage metadata.
- **Adapter:** request model/instructions/tools/history; malformed tool JSON; tool success/error continuation; resumed/branched history; no secret in `ConversationState`.
- **Routing:** affinity, proactive refresh, pre-output 401/429 retry, quota exclusion/reset, all-exhausted error, no post-output replay, no API-provider fallback.
- **Regression:** expand `Provider` records in `tests/factory.test.ts` and `tests/repl.test.ts`; retain all Anthropic/OpenAI/session/tool tests.

Use a scripted local HTTP server or injected `fetch` with recorded, sanitized fixtures. Live smoke tests must be opt-in (for example `RUN_CODEX_LIVE_TESTS=1`), must not run in CI by default, and must never commit tokens or real workspace IDs.

## 9. Documentation and acceptance criteria

Update `README.md` with login/device/logout/status usage, provider distinction, auth DB location/security, model selection, quota behavior, and troubleshooting for callback-port, expired login, contract drift, and exhausted subscription. State clearly that ChatGPT subscription limits—not OpenAI API billing—apply only when `openai-codex` is selected.

The feature is complete when:

- `openai`, `anthropic`, and `openai-codex` are independently selectable.
- A user can authenticate interactively or headlessly and refresh without exposing secrets.
- Multiple workspace credentials are isolated and quota/model-aware.
- Models are discovered and selected under `openai-codex/<slug>`.
- Text and existing Redwake tools work through SSE and canonical history survives switching, resume, and branch operations.
- 401, 429, malformed streams, and all-accounts-exhausted states fail safely and clearly.
- Selecting Codex never sends a request to `api.openai.com` and never silently uses `OPENAI_API_KEY`.
- `bun test` and `bun run typecheck` pass, with all network behavior covered by deterministic fixtures.
