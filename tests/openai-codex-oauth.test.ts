import { describe, expect, test } from "bun:test";
import { OpenAICodexOAuth } from "../source/auth/openai-codex-oauth.ts";
import { CODEX_COMPATIBILITY } from "../source/codex/constants.ts";

describe("OpenAICodexOAuth", () => {
  test("builds the complete Codex authorization request", () => {
    const oauth = new OpenAICodexOAuth();
    const url = new URL(oauth.authorizeUrl("challenge", "state"));

    expect(url.origin + url.pathname).toBe(CODEX_COMPATIBILITY.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: CODEX_COMPATIBILITY.clientId,
      redirect_uri: CODEX_COMPATIBILITY.redirectUri,
      scope: CODEX_COMPATIBILITY.scope,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state: "state",
      originator: CODEX_COMPATIBILITY.originator,
    });
  });

  test("uses device authorization immediately in a headless/container environment", async () => {
    const requests: string[] = [];
    const notices: string[] = [];
    const oauth = new OpenAICodexOAuth({
      isHeadless: () => true,
      fetch: (async (input: string | URL | Request) => {
        requests.push(String(input));
        return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    });

    await expect(oauth.loginBrowser((message) => notices.push(message))).rejects.toThrow("Malformed device authorization response");
    expect(notices[0]).toContain("using device login instead");
    expect(requests).toEqual([CODEX_COMPATIBILITY.deviceCodeUrl]);
  });

  test("implements OpenAI's device-auth field contract", async () => {
    const requests: Array<{ url: string; body: Record<string, string> }> = [];
    const accessToken = `x.${Buffer.from(JSON.stringify({ chatgpt_account_id: "workspace", exp: 2_000_000_000 })).toString("base64url")}.x`;
    const responses = [
      { device_auth_id: "device-auth", usercode: "ABCD-EFGH", interval: "0" },
      { authorization_code: "authorization-code", code_verifier: "server-verifier", code_challenge: "server-challenge" },
      { access_token: accessToken, refresh_token: "refresh" },
    ];
    const notices: string[] = [];
    const oauth = new OpenAICodexOAuth({
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const rawBody = String(init?.body ?? "");
        requests.push({
          url: String(input),
          body: init?.headers && new Headers(init.headers).get("content-type") === "application/json"
            ? JSON.parse(rawBody) as Record<string, string>
            : Object.fromEntries(new URLSearchParams(rawBody)),
        });
        return Response.json(responses.shift());
      }) as typeof fetch,
    });

    const token = await oauth.loginDevice((message) => notices.push(message));
    expect(token.accountId).toBe("workspace");
    expect(notices).toEqual(["Open https://auth.openai.com/codex/device and enter code ABCD-EFGH"]);
    expect(requests).toEqual([
      { url: CODEX_COMPATIBILITY.deviceCodeUrl, body: { client_id: CODEX_COMPATIBILITY.clientId } },
      { url: CODEX_COMPATIBILITY.deviceTokenUrl, body: { device_auth_id: "device-auth", user_code: "ABCD-EFGH" } },
      { url: CODEX_COMPATIBILITY.tokenUrl, body: { grant_type: "authorization_code", code: "authorization-code", redirect_uri: "https://auth.openai.com/deviceauth/callback", code_verifier: "server-verifier", client_id: CODEX_COMPATIBILITY.clientId } },
    ]);
  });

  test("reports opener failure immediately instead of waiting for callback timeout", async () => {
    const oauth = new OpenAICodexOAuth({ isHeadless: () => false, openBrowser: async () => { throw new Error("not installed"); } });
    await expect(oauth.loginBrowser(() => {}, 30_000)).rejects.toThrow("Run /login openai-codex --device");
  });

  test("opens the browser after the callback server starts and can be aborted", async () => {
    const controller = new AbortController();
    let opened = "";
    const oauth = new OpenAICodexOAuth({
      randomBytes: (length) => new Uint8Array(length).fill(1),
      openBrowser: (url) => { opened = url; controller.abort(); },
    });

    await expect(oauth.loginBrowser(() => {}, 5_000, controller.signal)).rejects.toMatchObject({
      name: "AbortError",
      message: "Authentication canceled.",
    });
    expect(opened).toStartWith(`${CODEX_COMPATIBILITY.authorizeUrl}?`);
  });
});
