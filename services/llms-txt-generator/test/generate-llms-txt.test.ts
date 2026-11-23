import { fromMarkdown } from "mdast-util-from-markdown";
import { expect, test } from "vitest";
import { generateLlmsTxt } from "../src/domain/generate-llms-txt.js";
import { validateLlmsTxt } from "../src/domain/validate-llms-txt.js";

const siteUrl = "https://example.org/docs";
const firstUrl = siteUrl + "/a(b).md?name=&copy;&mode=raw";
const otherUrl = siteUrl + "/api";
const notice = "llms-full.txt truncated. See llms.txt for the complete page list.";

test("uses the first exact home entry, preserves input order and round-trips URL and text punctuation", () => {
  const { result } = generateLlmsTxt({
    siteUrl,
    includeFull: false,
    pages: [
      { entry: { url: firstUrl, title: "Guide [v2]\r\n*draft* &copy;", description: null } },
      { entry: { url: siteUrl + "/", title: "Not the exact site URL", description: null } },
      { entry: { url: siteUrl, title: "Site #1", description: "1. First\nsummary" } },
      { entry: { url: siteUrl, title: "Duplicate", description: null } },
    ],
  });
  expect(result.content.split("\n").slice(0, 5)).toEqual([
    "# Site \\#1",
    "",
    "> 1\\. First summary",
    "",
    "## Pages",
  ]);
  const list = fromMarkdown(result.content).children.find((node) => node.type === "list");
  const links = list?.children.map((item) => {
    const paragraph = item.children[0];
    const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    if (link?.type !== "link") throw new Error("Expected a link as the first inline node");
    return link;
  });
  expect(links?.map(({ url }) => url)).toEqual([firstUrl, siteUrl + "/", siteUrl, siteUrl]);
  expect(links?.[0].children).toMatchObject([{ type: "text", value: "Guide [v2] *draft* &copy;" }]);
  expect(validateLlmsTxt({ content: result.content })).toMatchObject({ valid: true, issues: [] });
  expect(result).toMatchObject({ fullContent: null, pageCount: 4 });
});

test.each([false, true])(
  "uses the host and path for an absent or blank matching title (%s)",
  (match) => {
    const blankTitleUrl = match ? siteUrl : otherUrl;
    const { result } = generateLlmsTxt({
      siteUrl,
      includeFull: false,
      pages: [
        { entry: { url: blankTitleUrl, title: " \r\n ", description: "\t  " }, markdown: "Unused" },
      ],
    });
    expect(result).toEqual({
      content: `# example.org/docs\n\n## Pages\n\n- [${blankTitleUrl}](<${blankTitleUrl}>)\n`,
      fullContent: null,
      pageCount: 1,
    });
    expect(validateLlmsTxt({ content: result.content }).valid).toBe(true);
  },
);

test.each(["```ts\nUnclosed", "<!--\nUnclosed"])(
  "keeps the separator and next page outside an unclosed Markdown block (%s)",
  (markdown) => {
    const { result } = generateLlmsTxt({
      siteUrl,
      includeFull: true,
      pages: [
        { entry: { url: siteUrl, title: "Home", description: "Summary" }, markdown },
        { entry: { url: otherUrl, title: "API", description: null } },
      ],
    });
    const full = result.fullContent ?? "";
    expect(full).toBe(
      `# Home\n\n> Summary\n\n- [Home](<${siteUrl}>): Summary\n\n> ${markdown.replaceAll("\n", "\n> ")}\n\n---\n\n- [API](<${otherUrl}>)\n`,
    );
    expect(fromMarkdown(full).children.map(({ type }) => type)).toEqual([
      "heading",
      "blockquote",
      "list",
      "blockquote",
      "thematicBreak",
      "list",
    ]);
    expect(result.pageCount).toBe(2);
    expect(validateLlmsTxt({ content: result.content }).valid).toBe(true);
  },
);

test.each([1_999_999, 2_000_000, 2_000_001])(
  "caps full output with an untruncated length of %i Unicode code points",
  (target) => {
    const firstBlock = `# example.org/docs\n\n- [Guide](<${otherUrl}>)\n\n> <!-- unclosed`;
    const lastUrl = siteUrl + "/last";
    const lastBlock = `\n\n---\n\n- [Last](<${lastUrl}>)\n\n> `;
    const overhead = firstBlock.length + lastBlock.length + 1;
    const markdown = "😀".repeat(target - overhead - 2) + "e\u0301";
    const { result } = generateLlmsTxt({
      siteUrl,
      includeFull: true,
      pages: [
        { entry: { url: otherUrl, title: "Guide", description: null }, markdown: "<!-- unclosed" },
        { entry: { url: lastUrl, title: "Last", description: null }, markdown },
      ],
    });
    const full = result.fullContent ?? "";
    if (target <= 2_000_000) {
      expect(full).toBe(firstBlock + lastBlock + markdown + "\n");
    } else {
      expect(full).toBe(firstBlock + "\n\n> " + notice + "\n");
      const blocks = fromMarkdown(full).children;
      expect(blocks.map(({ type }) => type)).toEqual([
        "heading",
        "list",
        "blockquote",
        "blockquote",
      ]);
      expect(blocks.at(-1)).toMatchObject({
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ type: "text", value: notice }] }],
      });
    }
    expect(result.pageCount).toBe(2);
    expect(result.content).toContain("- [Last]");
  },
);

test("makes room for the notice by removing complete blocks and never skips an oversized page", () => {
  const intro = `# example.org/docs\n\n- [Guide](<${otherUrl}>)\n\n> `;
  const { result } = generateLlmsTxt({
    siteUrl,
    includeFull: true,
    pages: [
      {
        entry: { url: otherUrl, title: "Guide", description: null },
        markdown: "a".repeat(2_000_000 - intro.length - 1),
      },
      { entry: { url: siteUrl + "/next", title: "Next", description: null } },
      { entry: { url: siteUrl + "/last", title: "Last", description: null } },
    ],
  });
  expect(result.fullContent).toBe("# example.org/docs\n\n> " + notice + "\n");
  expect(result.pageCount).toBe(3);
});
