import { beforeEach, describe, expect, test } from "bun:test";
import { createToolContext } from "../source/tools/context.ts";
import { fetchTool } from "../source/tools/fetch.ts";
import { searchTool } from "../source/tools/search.ts";
import { FETCH_WINDOW_CHARS } from "../source/config.ts";

interface FetchResult {
  title: string;
  content_markdown: string;
  truncated: boolean;
  total_length: number;
}

describe("fetch", () => {
  test("preserves code blocks and absolutizes links, drops chrome", async () => {
    const html = `<html><head><title>My Page</title></head><body>
      <nav>Navigation should be removed</nav>
      <main>
        <p><a href="/rel">link</a></p>
        <pre><code class="language-python">print("hi")</code></pre>
      </main></body></html>`;
    const ctx = createToolContext({ fetch: async () => new Response(html) });

    const result = (await fetchTool.handler(
      { url: "https://example.com/page", offset: 0 },
      ctx,
    )) as FetchResult;

    expect(result.title).toBe("My Page");
    expect(result.content_markdown).toContain("```python");
    expect(result.content_markdown).toContain('print("hi")');
    expect(result.content_markdown).toContain("https://example.com/rel");
    expect(result.content_markdown).not.toContain("Navigation should be removed");
  });

  test("returns contiguous bounded windows", async () => {
    const big = "a".repeat(FETCH_WINDOW_CHARS + 5_000);
    const html = `<html><body><main><p>${big}</p></main></body></html>`;
    const ctx = createToolContext({ fetch: async () => new Response(html) });
    const url = "https://example.com/p";

    const first = (await fetchTool.handler({ url, offset: 0 }, ctx)) as FetchResult;
    const second = (await fetchTool.handler(
      { url, offset: FETCH_WINDOW_CHARS },
      ctx,
    )) as FetchResult;

    expect(first.content_markdown).toHaveLength(FETCH_WINDOW_CHARS);
    expect(first.truncated).toBe(true);
    expect(second.truncated).toBe(false);
    expect(first.content_markdown + second.content_markdown).toHaveLength(
      first.total_length,
    );
  });

  test("wraps network and non-OK responses", async () => {
    const failing = createToolContext({
      fetch: async () => {
        throw new Error("net");
      },
    });
    await expect(
      fetchTool.handler({ url: "https://example.com", offset: 0 }, failing),
    ).rejects.toThrow(/Could not fetch/);

    const notOk = createToolContext({
      fetch: async () => new Response("x", { status: 500 }),
    });
    await expect(
      fetchTool.handler({ url: "https://example.com", offset: 0 }, notOk),
    ).rejects.toThrow(/Could not fetch/);
  });
});

describe("search", () => {
  let payload: unknown;

  beforeEach(() => {
    payload = {
      web: {
        results: [
          {
            url: "https://good.com/a",
            title: "A",
            description: "da",
            page_age: "2024-01-01",
          },
          { url: "https://bad.com/b", title: "B", description: "db" },
          {
            url: "https://sub.good.com/c",
            title: "C",
            description: "dc",
            article: { date: "2023-05-05" },
          },
        ],
      },
    };
  });

  test("filters by domain and returns ranked, dated results", async () => {
    const ctx = createToolContext({
      env: () => "key",
      fetch: async () => new Response(JSON.stringify(payload)),
    });

    const results = (await searchTool.handler(
      { query: "q", domains: ["good.com"] },
      ctx,
    )) as Array<{ url: string; rank: number; published_date: string | null }>;

    expect(results.map((r) => r.url)).toEqual([
      "https://good.com/a",
      "https://sub.good.com/c",
    ]);
    expect(results.map((r) => r.rank)).toEqual([1, 2]);
    expect(results[0]!.published_date).toBe("2024-01-01");
    expect(results[1]!.published_date).toBe("2023-05-05"); // falls back to article.date
  });

  test("sends query, freshness and auth headers", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const ctx = createToolContext({
      env: () => "secret-key",
      fetch: async (url, init) => {
        captured = { url: String(url), init };
        return new Response(JSON.stringify({ web: { results: [] } }));
      },
    });

    await searchTool.handler({ query: "python", recency_days: 7 }, ctx);

    expect(captured?.url).toContain("q=python");
    expect(captured?.url).toContain("freshness=");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers["X-Subscription-Token"]).toBe("secret-key");
  });

  test("requires an API key", async () => {
    const ctx = createToolContext({ env: () => undefined });
    await expect(searchTool.handler({ query: "x" }, ctx)).rejects.toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
  });

  test("wraps backend failures", async () => {
    const ctx = createToolContext({
      env: () => "key",
      fetch: async () => {
        throw new Error("boom");
      },
    });
    await expect(searchTool.handler({ query: "x" }, ctx)).rejects.toThrow(
      /Web search request failed/,
    );
  });

  test("rejects invalid domains", async () => {
    const ctx = createToolContext({
      env: () => "key",
      fetch: async () => new Response("{}"),
    });
    await expect(
      searchTool.handler({ query: "x", domains: ["not a domain!"] }, ctx),
    ).rejects.toThrow(/Invalid domain/);
  });
});
