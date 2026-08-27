import { z } from "zod";
import { defineTool, ToolError } from "./context.ts";
import { HTTP_TIMEOUT_MS, SEARCH_RESULT_COUNT } from "../config.ts";

const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const schema = z.object({
  query: z
    .string()
    .refine((value) => value.trim().length > 0, "query must be a non-empty string"),
  domains: z.array(z.string()).optional(),
  recency_days: z.number().int().min(1).optional(),
});

export interface SearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  published_date: string | null;
}

function normalizeDomains(domains: string[] | undefined): Set<string> | null {
  if (domains === undefined) return null;
  const normalized = new Set<string>();
  for (const domain of domains) {
    const hostname = domain.trim().toLowerCase().replace(/\.+$/, "");
    if (!HOSTNAME.test(hostname)) {
      throw new ToolError(`Invalid domain: ${domain}`);
    }
    normalized.add(hostname);
  }
  return normalized.size ? normalized : null;
}

function matchesDomains(url: string, domains: Set<string> | null): boolean {
  if (domains === null) return true;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.+$/, "");
  } catch {
    return false;
  }
  for (const domain of domains) {
    if (hostname === domain || hostname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

function freshnessRange(recencyDays: number | undefined): string | null {
  if (recencyDays === undefined) return null;
  const day = 86_400_000;
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - recencyDays * day).toISOString().slice(0, 10);
  return `${start}to${end}`;
}

export const searchTool = defineTool({
  name: "search",
  description: "Search the web and return ranked results for subsequent fetches.",
  schema,
  handler: async ({ query, domains, recency_days }, ctx): Promise<SearchResult[]> => {
    const normalizedDomains = normalizeDomains(domains);
    const freshness = freshnessRange(recency_days);
    const apiKey = ctx.env("BRAVE_SEARCH_API_KEY");
    if (!apiKey) {
      throw new ToolError("BRAVE_SEARCH_API_KEY must be configured for search");
    }

    const params = new URLSearchParams({
      q: query,
      count: String(SEARCH_RESULT_COUNT),
    });
    if (freshness) params.set("freshness", freshness);

    let response: Response;
    try {
      response = await ctx.fetch(`${BRAVE_ENDPOINT}?${params}`, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new ToolError("Web search request failed");
    }
    if (!response.ok) {
      throw new ToolError("Web search request failed");
    }

    let payload: { web?: { results?: unknown } };
    try {
      payload = (await response.json()) as { web?: { results?: unknown } };
    } catch {
      throw new ToolError("Web search returned invalid JSON");
    }

    const webResults = payload.web?.results;
    if (!Array.isArray(webResults)) {
      throw new ToolError("Web search returned an invalid result payload");
    }

    const results: SearchResult[] = [];
    for (const entry of webResults) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;

      const resultUrl = record.url;
      if (typeof resultUrl !== "string" || !matchesDomains(resultUrl, normalizedDomains)) {
        continue;
      }

      const article = record.article;
      let publishedDate = record.page_age;
      if (!publishedDate && typeof article === "object" && article !== null) {
        publishedDate = (article as Record<string, unknown>).date;
      }

      results.push({
        rank: results.length + 1,
        title: typeof record.title === "string" ? record.title : "",
        url: resultUrl,
        snippet: typeof record.description === "string" ? record.description : "",
        published_date: typeof publishedDate === "string" ? publishedDate : null,
      });
      if (results.length === 10) break;
    }

    return results;
  },
});
