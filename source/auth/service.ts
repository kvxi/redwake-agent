import { CredentialManager } from "./credential-manager.ts";
import { OpenAICodexOAuth } from "./openai-codex-oauth.ts";
import { AuthStore } from "./store.ts";
import { redactIdentity, type AuthStatus, type OAuthCredential, type TokenSet } from "./types.ts";

export interface AuthService {
  login(device?: boolean, notify?: (message:string)=>void): Promise<AuthStatus>;
  logout(accountId?: string): Promise<boolean>;
  status(): Promise<AuthStatus[]>;
  credentials: CredentialManager;
}

export class CodexAuthService implements AuthService {
  readonly credentials: CredentialManager;
  constructor(readonly store=new AuthStore(), private readonly oauth=new OpenAICodexOAuth(), private readonly now=Date.now){this.credentials=new CredentialManager(store,oauth,now);}
  async login(device=false,notify=(m: string)=>console.log(m)):Promise<AuthStatus>{const token=device?await this.oauth.loginDevice(notify):await this.oauth.loginBrowser(notify);this.persist(token);return this.toStatus(this.store.getCredential(token.accountId)!);}
  async logout(accountId?:string):Promise<boolean>{const entries=this.store.listCredentials();if(!accountId){if(entries.length!==1)throw new Error(entries.length===0?"No ChatGPT accounts are logged in":"Multiple workspaces exist; specify an account ID shown by /status openai-codex");accountId=entries[0]!.accountId;}return this.store.removeCredential(accountId);}
  async status():Promise<AuthStatus[]>{return this.store.listCredentials().map((c)=>this.toStatus(c));}
  private persist(t:TokenSet):void{const now=this.now();const old=this.store.getCredential(t.accountId);const c:OAuthCredential={provider:"openai-codex",accountId:t.accountId,email:t.email,planType:t.planType,residency:t.residency,accessToken:t.accessToken,refreshToken:t.refreshToken??old?.refreshToken,idToken:t.idToken,expiresAt:t.expiresAt,createdAt:old?.createdAt??now,updatedAt:now,lastUsedAt:old?.lastUsedAt};this.store.upsertCredential(c);}
  private toStatus(c:OAuthCredential):AuthStatus{return {accountId:c.accountId,identity:redactIdentity(c.email,c.accountId),planType:c.planType,disabled:c.disabledAt!==undefined,expiresAt:c.expiresAt};}
}
