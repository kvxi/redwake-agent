import { describe, expect, test } from "bun:test";
import { AuthStore } from "../source/auth/store.ts";

describe("AuthStore", () => {
  test("isolates workspaces and cascades account state", () => {
    const store = new AuthStore(":memory:");
    const now = Date.now();
    for (const accountId of ["personal", "team"]) {
      store.upsertCredential({
        provider: "openai-codex",
        accountId,
        email: "a@example.com",
        accessToken: `token-${accountId}`,
        expiresAt: now + 1000,
        createdAt: now,
        updatedAt: now,
      });
    }
    store.putQuota({ provider: "openai-codex", accountId: "personal", primaryUsedPercent: 100, observedAt: now });
    store.putModelCache("personal", { models: [] }, now);
    expect(store.listCredentials()).toHaveLength(2);
    expect(store.removeCredential("personal")).toBe(true);
    expect(store.quota("personal")).toBeUndefined();
    expect(store.getModelCache("personal")).toBeUndefined();
    expect(store.getCredential("team")?.accessToken).toBe("token-team");
    store.close();
  });

  test("persists one global provider and model selection independently of credentials", () => {
    const store = new AuthStore(":memory:");
    expect(store.getModelSelection()).toBeUndefined();

    store.putModelSelection("openai-codex", "gpt-codex-test", 123);
    expect(store.getModelSelection()).toEqual({
      provider: "openai-codex",
      model: "gpt-codex-test",
    });

    store.putModelSelection("openai", "gpt-api-test", 456);
    expect(store.getModelSelection()).toEqual({ provider: "openai", model: "gpt-api-test" });
    store.close();
  });
});
