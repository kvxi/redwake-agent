import { decodeJwtClaims, OpenAICodexOAuth } from "./openai-codex-oauth.ts";
import { AuthStore } from "./store.ts";
import type { CredentialLease, OAuthCredential, TokenSet } from "./types.ts";

export class CredentialManager {
  private readonly refreshes = new Map<string, Promise<OAuthCredential>>();
  private affinity?: string;
  constructor(readonly store: AuthStore, private readonly oauth = new OpenAICodexOAuth(), private readonly now=Date.now) {}

  async lease(_model?: string): Promise<CredentialLease> {
    const override=process.env.OPENAI_CODEX_OAUTH_TOKEN;
    if(override){ const claims=decodeJwtClaims(override); const auth=claims["https://api.openai.com/auth"] as Record<string,unknown>|undefined; const account=claims.chatgpt_account_id??auth?.chatgpt_account_id; if(typeof account!=="string") throw new Error("OPENAI_CODEX_OAUTH_TOKEN has no workspace ID"); return {accessToken:override,accountId:account}; }
    const now=this.now(); const candidates=this.store.listCredentials(false).filter((c)=>{const q=this.store.quota(c.accountId);return !q?.blockedUntil||q.blockedUntil<=now;}).sort((a,b)=>{if(a.accountId===this.affinity)return -1;if(b.accountId===this.affinity)return 1;const aq=this.store.quota(a.accountId)?.primaryUsedPercent??0,bq=this.store.quota(b.accountId)?.primaryUsedPercent??0;return aq-bq||(a.lastUsedAt??0)-(b.lastUsedAt??0);});
    if(!candidates[0]) throw new Error("No usable ChatGPT subscription credential. Run /login openai-codex.");
    let selected=candidates[0]; if(selected.expiresAt<=now+60_000) selected=await this.refresh(selected.accountId); this.affinity=selected.accountId; this.store.markUsed(selected.accountId,now); return {accountId:selected.accountId,accessToken:selected.accessToken,residency:selected.residency};
  }
  invalidateAffinity():void{this.affinity=undefined;}
  async refresh(accountId:string,force=false):Promise<OAuthCredential>{ const pending=this.refreshes.get(accountId);if(pending)return pending;const operation=this.doRefresh(accountId,force).finally(()=>this.refreshes.delete(accountId));this.refreshes.set(accountId,operation);return operation; }
  private async doRefresh(accountId:string,force:boolean):Promise<OAuthCredential>{ const current=this.store.getCredential(accountId);if(!current)throw new Error("Credential no longer exists");if(!force&&current.expiresAt>this.now()+60_000)return current;if(!current.refreshToken)throw new Error("ChatGPT credential expired and cannot be refreshed; log in again");let token:TokenSet;try{token=await this.oauth.refresh(current.refreshToken);}catch(error){if((error as {oauthError?:string}).oauthError==="invalid_grant")this.store.disable(accountId,"Refresh authorization expired");throw error;}if(token.accountId!==accountId){this.store.disable(accountId,"Refresh returned a different workspace");throw new Error("OAuth refresh workspace mismatch");}const updated:OAuthCredential={...current,...token,provider:"openai-codex",refreshToken:token.refreshToken??current.refreshToken,updatedAt:this.now(),disabledAt:undefined,lastAuthError:undefined};this.store.upsertCredential(updated);return updated; }
  recordBlocked(accountId:string,status=429,until=this.now()+60_000):void{this.store.putQuota({provider:"openai-codex",accountId,blockedUntil:until,lastHttpStatus:status,observedAt:this.now()});if(this.affinity===accountId)this.affinity=undefined;}
}
