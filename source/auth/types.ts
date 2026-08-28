export const CODEX_PROVIDER = "openai-codex" as const;

export interface OAuthCredential {
  provider: typeof CODEX_PROVIDER;
  accountId: string;
  email?: string;
  planType?: string;
  residency?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  disabledAt?: number;
  lastAuthError?: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  accountId: string;
  email?: string;
  planType?: string;
  residency?: string;
}

export interface QuotaState {
  provider: typeof CODEX_PROVIDER;
  accountId: string;
  primaryUsedPercent?: number;
  primaryResetAt?: number;
  secondaryUsedPercent?: number;
  secondaryResetAt?: number;
  blockedUntil?: number;
  lastHttpStatus?: number;
  observedAt: number;
}

export interface CredentialLease {
  accountId: string;
  accessToken: string;
  residency?: string;
}

export interface AuthStatus {
  accountId: string;
  identity: string;
  planType?: string;
  disabled: boolean;
  expiresAt: number;
}

export function redactIdentity(email: string | undefined, accountId: string): string {
  const shortId = accountId.length > 8 ? `${accountId.slice(0, 4)}…${accountId.slice(-4)}` : accountId;
  if (!email) return shortId;
  const [local, domain] = email.split("@");
  if (!local || !domain) return shortId;
  return `${local.slice(0, 2)}…@${domain} (${shortId})`;
}
