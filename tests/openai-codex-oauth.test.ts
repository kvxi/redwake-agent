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
