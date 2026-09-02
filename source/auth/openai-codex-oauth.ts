import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { CODEX_COMPATIBILITY } from "../codex/constants.ts";
import type { TokenSet } from "./types.ts";

export interface OAuthDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  randomBytes?: (length: number) => Uint8Array;
  openBrowser?: (url: string) => void | Promise<void>;
  /** Override desktop/container detection (primarily useful to embedders and tests). */
  isHeadless?: () => boolean;
}
type Claims = Record<string, unknown>;
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

export function decodeJwtClaims(token: string): Claims {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Malformed OAuth JWT");
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Claims;
  } catch { throw new Error("Malformed OAuth JWT claims"); }
}

function claim(claims: Claims, ...names: string[]): string | undefined {
  for (const name of names) if (typeof claims[name] === "string") return claims[name] as string;
  const auth = claims["https://api.openai.com/auth"];
  if (auth && typeof auth === "object") {
    for (const name of names) {
      const value = (auth as Claims)[name];
      if (typeof value === "string") return value;
    }
  }
  return undefined;
}

function defaultHeadless(): boolean {
  if (process.platform !== "linux") return false;
  // A callback to 127.0.0.1 inside a container cannot be reached by a browser
  // on the host. Linux desktop openers also require a graphical session.
  return existsSync("/.dockerenv") || Boolean(process.env.container) || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
}

function defaultOpen(url: string): Promise<void> {
  const [command, args] = process.platform === "darwin"
    ? ["open", [url]]
    : process.platform === "win32"
      ? ["cmd", ["/d", "/s", "/c", "start", "", url]]
      : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => error ? reject(error) : resolve());
  });
}

function canceled(): Error {
  const error = new Error("Authentication canceled.");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(canceled());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener("abort", abort); resolve(); }
    function abort() { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(canceled()); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class OpenAICodexOAuth {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly random: (n: number) => Uint8Array;
  private readonly open: (url: string) => void | Promise<void>;
  private readonly headless: () => boolean;

  constructor(deps: OAuthDependencies = {}) {
    this.fetcher = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.random = deps.randomBytes ?? ((n) => crypto.getRandomValues(new Uint8Array(n)));
    this.open = deps.openBrowser ?? defaultOpen;
    // An injected opener is presumed usable unless detection is also injected.
    this.headless = deps.isHeadless ?? (deps.openBrowser ? () => false : defaultHeadless);
  }

  async pkce(): Promise<{ verifier: string; challenge: string; state: string }> {
    const verifier = b64url(this.random(48));
    const state = b64url(this.random(32));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, state, challenge: b64url(new Uint8Array(digest)) };
  }

  authorizeUrl(challenge: string, state: string): string {
    const url = new URL(CODEX_COMPATIBILITY.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CODEX_COMPATIBILITY.clientId,
      redirect_uri: CODEX_COMPATIBILITY.redirectUri,
      scope: CODEX_COMPATIBILITY.scope,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: CODEX_COMPATIBILITY.originator,
    }).toString();
    return url.toString();
  }

  async loginBrowser(notify: (message: string) => void, timeoutMs = 120_000, signal?: AbortSignal): Promise<TokenSet> {
    if (signal?.aborted) throw canceled();
    if (this.headless()) {
      notify("No local browser/callback is available; using device login instead.");
      return this.loginDevice(notify, signal);
    }
    const pkce = await this.pkce();
    const url = this.authorizeUrl(pkce.challenge, pkce.state);
    const code = await new Promise<string>((resolve, reject) => {
      let server: Server;
      let settled = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        server?.close();
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(canceled());
      const timer = setTimeout(() => finish(new Error("OAuth callback timed out; try device login")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      server = createServer((req, res) => {
        const callback = new URL(req.url ?? "/", CODEX_COMPATIBILITY.redirectUri);
        if (callback.pathname !== "/auth/callback") { res.writeHead(404).end(); return; }
        const oauthError = callback.searchParams.get("error");
        const code = callback.searchParams.get("code");
        if (oauthError || callback.searchParams.get("state") !== pkce.state || !code) {
          res.writeHead(400).end("Authentication failed. Return to Redwake Agent.");
          finish(new Error(oauthError ? `OAuth failed: ${oauthError}` : "OAuth callback validation failed"));
          return;
        }
        res.end("Authentication complete. You may close this window.");
        finish(undefined, code);
      });
      server.once("error", () => finish(new Error("OAuth callback port 1455 is unavailable; use /login openai-codex --device")));
      // Listen before opening the browser so a fast redirect cannot race the callback server.
      server.listen(1455, "127.0.0.1", () => {
        notify(`Opening this URL to authenticate:\n${url}`);
        // Do not leave the user waiting for a callback after the opener has
        // already told us that no browser can be launched.
        try {
          Promise.resolve(this.open(url)).catch(() => finish(new Error("Could not open a local browser. Run /login openai-codex --device.")));
        } catch {
          finish(new Error("Could not open a local browser. Run /login openai-codex --device."));
        }
      });
    });
    return this.exchange({
      grant_type: "authorization_code",
      code,
      redirect_uri: CODEX_COMPATIBILITY.redirectUri,
      code_verifier: pkce.verifier,
      client_id: CODEX_COMPATIBILITY.clientId,
    }, signal);
  }

  async loginDevice(notify: (message: string) => void, signal?: AbortSignal): Promise<TokenSet> {
    const pkce = await this.pkce();
    const response = await this.fetcher(CODEX_COMPATIBILITY.deviceCodeUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_COMPATIBILITY.clientId, code_challenge: pkce.challenge, code_challenge_method: "S256" }), signal,
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Device authorization failed (${response.status})`);
    const deviceCode = String(data.device_code ?? "");
    const userCode = String(data.user_code ?? "");
    const verification = String(data.verification_uri_complete ?? data.verification_uri ?? "");
    if (!deviceCode || !userCode || !verification) throw new Error("Malformed device authorization response");
    notify(`Open ${verification} and enter code ${userCode}`);
    const interval = Math.max(2, Number(data.interval ?? 5) + 1) * 1000;
    const deadline = this.now() + Math.min(Number(data.expires_in ?? 900) * 1000, 900_000);
    while (this.now() < deadline) {
      await delay(interval, signal);
      const poll = await this.fetcher(CODEX_COMPATIBILITY.deviceTokenUrl, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ device_code: deviceCode, client_id: CODEX_COMPATIBILITY.clientId }), signal,
      });
      const result = await poll.json() as Record<string, unknown>;
      if (poll.ok && typeof result.authorization_code === "string") {
        return this.exchange({ grant_type: "authorization_code", code: result.authorization_code, redirect_uri: CODEX_COMPATIBILITY.redirectUri, code_verifier: pkce.verifier, client_id: CODEX_COMPATIBILITY.clientId }, signal);
      }
      const error = String(result.error ?? "");
      if (error !== "authorization_pending" && error !== "slow_down") throw new Error(`Device authorization failed: ${error || poll.status}`);
    }
    throw new Error("Device authorization expired");
  }

  async refresh(refreshToken: string): Promise<TokenSet> {
    return this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CODEX_COMPATIBILITY.clientId });
  }

  private async exchange(params: Record<string, string>, signal?: AbortSignal): Promise<TokenSet> {
    const response = await this.fetcher(CODEX_COMPATIBILITY.tokenUrl, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal,
    });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const error = new Error(`OAuth token exchange failed (${response.status}): ${String(data.error ?? "unknown error")}`);
      (error as Error & { oauthError?: string }).oauthError = typeof data.error === "string" ? data.error : undefined;
      throw error;
    }
    const access = typeof data.access_token === "string" ? data.access_token : "";
    const id = typeof data.id_token === "string" ? data.id_token : undefined;
    if (!access) throw new Error("OAuth response omitted access token");
    const claims = decodeJwtClaims(id ?? access);
    const accountId = claim(claims, "chatgpt_account_id", "account_id");
    if (!accountId) throw new Error("OAuth token has no ChatGPT workspace ID");
    const expiresAt = typeof claims.exp === "number" ? claims.exp * 1000 : this.now() + Number(data.expires_in ?? 3600) * 1000;
    return { accessToken: access, refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : undefined, idToken: id, expiresAt, accountId, email: claim(claims, "email")?.toLowerCase(), planType: claim(claims, "chatgpt_plan_type", "plan_type"), residency: claim(claims, "data_residency", "compute_residency") };
  }
}
