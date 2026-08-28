/** Private Codex compatibility surface. Upgrade and test this block atomically. */
export const CODEX_COMPATIBILITY = {
  // This is the Codex protocol/client version, not Redwake's package version.
  // The model-catalog endpoint validates it via both the query string and header.
  clientVersion: "0.144.1",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  deviceCodeUrl: "https://auth.openai.com/api/accounts/deviceauth/usercode",
  deviceTokenUrl: "https://auth.openai.com/api/accounts/deviceauth/token",
  redirectUri: "http://localhost:1455/auth/callback",
  scope: "openid profile email offline_access",
  originator: "redwake",
  responsesBeta: "responses=experimental",
} as const;

export const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const CODEX_RESPONSES_URL = `${CODEX_BASE_URL}/codex/responses`;
export const CODEX_MODELS_URL = `${CODEX_BASE_URL}/codex/models?client_version=${encodeURIComponent(CODEX_COMPATIBILITY.clientVersion)}`;
export const CODEX_USAGE_URL = `${CODEX_BASE_URL}/wham/usage`;

export function codexHeaders(accessToken: string, accountId: string, residency?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": accountId,
    "openai-beta": CODEX_COMPATIBILITY.responsesBeta,
    originator: CODEX_COMPATIBILITY.originator,
    version: CODEX_COMPATIBILITY.clientVersion,
    "user-agent": `redwake/${CODEX_COMPATIBILITY.clientVersion}`,
    accept: "application/json",
  };
  if (residency) headers["x-openai-data-residency"] = residency;
  return headers;
}
