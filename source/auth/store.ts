import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { AUTH_DB_PATH, parseProvider, type Provider } from "../config.ts";
import type { OAuthCredential, QuotaState } from "./types.ts";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS oauth_credentials (
 provider TEXT NOT NULL, account_id TEXT NOT NULL, email TEXT, plan_type TEXT, residency TEXT,
 access_token TEXT NOT NULL, refresh_token TEXT, id_token TEXT, expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_used_at INTEGER,
 disabled_at INTEGER, last_auth_error TEXT, PRIMARY KEY(provider, account_id)
);
CREATE TABLE IF NOT EXISTS quota_state (
 provider TEXT NOT NULL, account_id TEXT NOT NULL, primary_used_percent REAL, primary_reset_at INTEGER,
 secondary_used_percent REAL, secondary_reset_at INTEGER, blocked_until INTEGER, last_http_status INTEGER,
 observed_at INTEGER NOT NULL, PRIMARY KEY(provider, account_id),
 FOREIGN KEY(provider, account_id) REFERENCES oauth_credentials(provider, account_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS model_cache (
 provider TEXT NOT NULL, account_id TEXT NOT NULL, etag TEXT, payload_json TEXT NOT NULL, fetched_at INTEGER NOT NULL,
 PRIMARY KEY(provider, account_id), FOREIGN KEY(provider, account_id) REFERENCES oauth_credentials(provider, account_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS model_selection (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1), provider TEXT NOT NULL, model TEXT NOT NULL, updated_at INTEGER NOT NULL
);`;

type CredentialRow = { provider: "openai-codex"; account_id: string; email: string | null; plan_type: string | null; residency: string | null; access_token: string; refresh_token: string | null; id_token: string | null; expires_at: number; created_at: number; updated_at: number; last_used_at: number | null; disabled_at: number | null; last_auth_error: string | null };
type QuotaRow = { provider: "openai-codex"; account_id: string; primary_used_percent: number | null; primary_reset_at: number | null; secondary_used_percent: number | null; secondary_reset_at: number | null; blocked_until: number | null; last_http_status: number | null; observed_at: number };

function credential(row: CredentialRow): OAuthCredential {
  return { provider: row.provider, accountId: row.account_id, email: row.email ?? undefined, planType: row.plan_type ?? undefined, residency: row.residency ?? undefined, accessToken: row.access_token, refreshToken: row.refresh_token ?? undefined, idToken: row.id_token ?? undefined, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at, lastUsedAt: row.last_used_at ?? undefined, disabledAt: row.disabled_at ?? undefined, lastAuthError: row.last_auth_error ?? undefined };
}

/** Global OAuth persistence. Secrets never enter project/session files. */
export class AuthStore {
  readonly db: Database;
  constructor(path = AUTH_DB_PATH) {
    if (path !== ":memory:") {
      const directory = dirname(path);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = statSync(directory);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Refusing auth directory owned by another user");
      if ((stat.mode & 0o077) !== 0) chmodSync(directory, 0o700);
    }
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.db.transaction(() => {
      this.db.exec(MIGRATION);
      const now = Date.now();
      this.db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, ?)").run(now);
      this.db.query("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, ?)").run(now);
    })();
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  close(): void { this.db.close(); }

  listCredentials(includeDisabled = true): OAuthCredential[] {
    const where = includeDisabled ? "" : " WHERE disabled_at IS NULL";
    return (this.db.query(`SELECT * FROM oauth_credentials${where} ORDER BY updated_at DESC`).all() as CredentialRow[]).map(credential);
  }
  getCredential(accountId: string): OAuthCredential | undefined {
    const row = this.db.query("SELECT * FROM oauth_credentials WHERE provider='openai-codex' AND account_id=?").get(accountId) as CredentialRow | null;
    return row ? credential(row) : undefined;
  }
  upsertCredential(value: OAuthCredential): void {
    this.db.query(`INSERT INTO oauth_credentials(provider,account_id,email,plan_type,residency,access_token,refresh_token,id_token,expires_at,created_at,updated_at,last_used_at,disabled_at,last_auth_error)
      VALUES($provider,$accountId,$email,$planType,$residency,$accessToken,$refreshToken,$idToken,$expiresAt,$createdAt,$updatedAt,$lastUsedAt,$disabledAt,$lastAuthError)
      ON CONFLICT(provider,account_id) DO UPDATE SET email=excluded.email,plan_type=excluded.plan_type,residency=excluded.residency,access_token=excluded.access_token,refresh_token=COALESCE(excluded.refresh_token,oauth_credentials.refresh_token),id_token=excluded.id_token,expires_at=excluded.expires_at,updated_at=excluded.updated_at,disabled_at=excluded.disabled_at,last_auth_error=excluded.last_auth_error`).run({ ...value, email: value.email ?? null, planType: value.planType ?? null, residency: value.residency ?? null, refreshToken: value.refreshToken ?? null, idToken: value.idToken ?? null, lastUsedAt: value.lastUsedAt ?? null, disabledAt: value.disabledAt ?? null, lastAuthError: value.lastAuthError ?? null });
  }
  removeCredential(accountId: string): boolean {
    return this.db.transaction(() => this.db.query("DELETE FROM oauth_credentials WHERE provider='openai-codex' AND account_id=?").run(accountId).changes > 0)();
  }
  markUsed(accountId: string, now = Date.now()): void { this.db.query("UPDATE oauth_credentials SET last_used_at=? WHERE provider='openai-codex' AND account_id=?").run(now, accountId); }
  disable(accountId: string, reason: string, now = Date.now()): void { this.db.query("UPDATE oauth_credentials SET disabled_at=?,last_auth_error=? WHERE provider='openai-codex' AND account_id=?").run(now, reason.slice(0, 500), accountId); }
  quota(accountId: string): QuotaState | undefined {
    const r = this.db.query("SELECT * FROM quota_state WHERE provider='openai-codex' AND account_id=?").get(accountId) as QuotaRow | null;
    return r ? { provider: r.provider, accountId: r.account_id, primaryUsedPercent: r.primary_used_percent ?? undefined, primaryResetAt: r.primary_reset_at ?? undefined, secondaryUsedPercent: r.secondary_used_percent ?? undefined, secondaryResetAt: r.secondary_reset_at ?? undefined, blockedUntil: r.blocked_until ?? undefined, lastHttpStatus: r.last_http_status ?? undefined, observedAt: r.observed_at } : undefined;
  }
  putQuota(q: QuotaState): void { this.db.query(`INSERT INTO quota_state(provider,account_id,primary_used_percent,primary_reset_at,secondary_used_percent,secondary_reset_at,blocked_until,last_http_status,observed_at) VALUES($provider,$accountId,$primaryUsedPercent,$primaryResetAt,$secondaryUsedPercent,$secondaryResetAt,$blockedUntil,$lastHttpStatus,$observedAt) ON CONFLICT(provider,account_id) DO UPDATE SET primary_used_percent=excluded.primary_used_percent,primary_reset_at=excluded.primary_reset_at,secondary_used_percent=excluded.secondary_used_percent,secondary_reset_at=excluded.secondary_reset_at,blocked_until=excluded.blocked_until,last_http_status=excluded.last_http_status,observed_at=excluded.observed_at`).run({ ...q, primaryUsedPercent: q.primaryUsedPercent ?? null, primaryResetAt: q.primaryResetAt ?? null, secondaryUsedPercent: q.secondaryUsedPercent ?? null, secondaryResetAt: q.secondaryResetAt ?? null, blockedUntil: q.blockedUntil ?? null, lastHttpStatus: q.lastHttpStatus ?? null }); }
  getModelCache(accountId: string): { etag?: string; payload: unknown; fetchedAt: number } | undefined { const r = this.db.query("SELECT etag,payload_json,fetched_at FROM model_cache WHERE provider='openai-codex' AND account_id=?").get(accountId) as {etag:string|null;payload_json:string;fetched_at:number}|null; return r ? { etag:r.etag??undefined,payload:JSON.parse(r.payload_json),fetchedAt:r.fetched_at } : undefined; }
  putModelCache(accountId: string, payload: unknown, fetchedAt=Date.now(), etag?: string): void { this.db.query("INSERT INTO model_cache(provider,account_id,etag,payload_json,fetched_at) VALUES('openai-codex',?,?,?,?) ON CONFLICT(provider,account_id) DO UPDATE SET etag=excluded.etag,payload_json=excluded.payload_json,fetched_at=excluded.fetched_at").run(accountId,etag??null,JSON.stringify(payload),fetchedAt); }

  /** The last provider/model chosen with /model, shared across workspaces. */
  getModelSelection(): { provider: Provider; model: string } | undefined {
    const row = this.db.query("SELECT provider,model FROM model_selection WHERE singleton=1").get() as {provider:string;model:string}|null;
    if (!row) return undefined;
    const provider = parseProvider(row.provider);
    return provider && row.model.trim() ? { provider, model: row.model } : undefined;
  }
  putModelSelection(provider: Provider, model: string, updatedAt=Date.now()): void {
    if (!model.trim()) throw new Error("Cannot persist an empty model selection");
    this.db.query("INSERT INTO model_selection(singleton,provider,model,updated_at) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET provider=excluded.provider,model=excluded.model,updated_at=excluded.updated_at").run(provider,model,updatedAt);
  }
}
