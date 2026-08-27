import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export interface ExtractedPage {
  title: string;
  markdown: string;
}

const STRIP_SELECTORS =
  "aside, footer, form, header, nav, noscript, script, style, template";

/**
 * Convert an HTML document to reader-focused Markdown.
 *
 * Code blocks are extracted and re-inserted verbatim (with a dynamically sized
 * backtick fence and any `language-*` hint) so the Markdown converter cannot
 * mangle their contents — the same strategy the original Python used.
 */
export function htmlToMarkdown(html: string, pageUrl: string): ExtractedPage {
  const $ = cheerio.load(html);

  const titleText = $("title").first().text().trim().replace(/\s+/g, " ");
  const title = titleText || pageUrl;

  let content = $("main").first();
  if (!content.length) content = $("article").first();
  if (!content.length) content = $("body").first();
  if (!content.length) content = $("html").first();

  content.find(STRIP_SELECTORS).remove();

  content.find("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    try {
      $(el).attr("href", new URL(href, pageUrl).href);
    } catch {
      // leave unparseable hrefs untouched
    }
  });

  const codeBlocks: Array<[marker: string, block: string]> = [];
  content.find("pre").each((index, el) => {
    const marker = `REDWAKECODEBLOCK${index}END`;
    const code = $(el).text();
    const classes = $(el).find("code").attr("class") ?? "";
    const language =
      classes
        .split(/\s+/)
        .find((name) => name.startsWith("language-"))
        ?.slice("language-".length) ?? "";
    const longestBacktickRun = Math.max(
      0,
      ...[...code.matchAll(/`+/g)].map((match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    const trailingNewline = code.endsWith("\n") ? "" : "\n";
    codeBlocks.push([
      marker,
      `\n${fence}${language}\n${code}${trailingNewline}${fence}\n`,
    ]);
    $(el).replaceWith(marker);
  });

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  turndown.use(gfm);

  let markdown = turndown.turndown($.html(content));
  for (const [marker, block] of codeBlocks) {
    markdown = markdown.split(marker).join(block);
  }

  return { title, markdown };
}
