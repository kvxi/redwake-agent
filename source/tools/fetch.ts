import { z } from "zod";
import { defineTool, ToolError } from "./context.ts";
import { htmlToMarkdown } from "./html-to-markdown.ts";
import { FETCH_WINDOW_CHARS, HTTP_TIMEOUT_MS } from "../config.ts";

const schema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (value) => /^https?:\/\//i.test(value),
      "url must be an absolute HTTP or HTTPS URL",
    ),
  offset: z.number().int().min(0).default(0),
});

export const fetchTool = defineTool({
  name: "fetch",
  description: "Fetch a web page as paginated Markdown.",
  schema,
  handler: async ({ url, offset }, ctx) => {
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new ToolError(`Could not fetch URL: ${url}`);
    }
    if (!response.ok) {
      throw new ToolError(`Could not fetch URL: ${url}`);
    }

    const pageUrl = response.url || url;
    const html = await response.text();
    const { title, markdown } = htmlToMarkdown(html, pageUrl);

    const totalLength = markdown.length;
    const end = offset + FETCH_WINDOW_CHARS;
    return {
      title,
      content_markdown: markdown.slice(offset, end),
      truncated: end < totalLength,
      total_length: totalLength,
    };
  },
});
