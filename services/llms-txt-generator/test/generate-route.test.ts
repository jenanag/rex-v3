import { fromMarkdown } from "mdast-util-from-markdown";
import { afterAll, expect, test } from "vitest";
import { validateLlmsTxt } from "../src/domain/validate-llms-txt.js";
import { checkResponse, tool } from "./support.js";

const app = tool();
const path = "/v1/llms-txt";
const siteUrl = "https://example.org/";
afterAll(() => app.close());

test.each([undefined, false, true])("serves assembly with includeFull=%s", async (includeFull) => {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: {
      siteUrl,
      includeFull,
      pages: [
        { entry: { url: siteUrl, title: "Home", description: "Overview" }, markdown: "# Welcome" },
        { entry: { url: siteUrl + "docs(a)?q=&copy;", title: "Docs [1]", description: null } },
      ],
    },
  });
  expect(response.statusCode).toBe(200);
  const payload = response.json();
  checkResponse("POST", path, 200, "application/json", payload);
  const first = `- [Home](<${siteUrl}>): Overview`;
  const second = `- [Docs \\[1\\]](<${siteUrl}docs(a)?q=\\&copy;>)`;
  expect(payload.result).toEqual({
    content: `# Home\n\n> Overview\n\n## Pages\n\n${first}\n${second}\n`,
    fullContent: includeFull
      ? `# Home\n\n> Overview\n\n${first}\n\n> # Welcome\n\n---\n\n${second}\n`
      : null,
    pageCount: 2,
  });
  expect(validateLlmsTxt({ content: payload.result.content })).toMatchObject({
    valid: true,
    issues: [],
  });
});

test("preserves a thematic-break-like site description as literal summary text in both files", async () => {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: {
      siteUrl,
      includeFull: true,
      pages: [{ entry: { url: siteUrl, title: "Home", description: "---" } }],
    },
  });
  expect(response.statusCode).toBe(200);
  const payload = response.json();
  checkResponse("POST", path, 200, "application/json", payload);
  for (const file of [payload.result.content, payload.result.fullContent]) {
    expect(fromMarkdown(file).children[1]).toMatchObject({
      type: "blockquote",
      children: [{ type: "paragraph", children: [{ type: "text", value: "---" }] }],
    });
  }
});

test.each([
  ["siteUrl", "https://example.org:65536/", siteUrl, "/siteUrl"],
  ["a page entry URL", siteUrl, "https://example.org:65536/", "/pages/0/entry/url"],
])(
  "returns the shared 422 Problem for an invalid WHATWG URL in %s",
  async (_name, site, entryUrl, pointer) => {
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: {
        siteUrl: site,
        pages: [{ entry: { url: entryUrl, title: "Home", description: null } }],
      },
    });
    expect(response.statusCode).toBe(422);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    const payload = response.json();
    checkResponse("POST", path, 422, "application/problem+json", payload);
    expect(payload).toMatchObject({
      status: 422,
      code: "invalid_assembly_url",
      detail: pointer + " is not a valid WHATWG URL.",
    });
  },
);

test.each([1_999_999, 2_000_000, 2_000_001])(
  "validates the response contract near the %i-code-point full file size",
  async (target) => {
    const preamble = "# example.org\n\n- [Guide](<https://example.org/guide>)\n\n> ";
    const markdown = "😀".repeat(target - preamble.length - 3) + "e\u0301";
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: {
        siteUrl,
        includeFull: true,
        pages: [{ entry: { url: siteUrl + "guide", title: "Guide", description: null }, markdown }],
      },
    });
    expect(response.statusCode).toBe(200);
    const payload = response.json();
    checkResponse("POST", path, 200, "application/json", payload);
    expect(payload.result.pageCount).toBe(1);
    if (target > 2_000_000) {
      expect(payload.result.fullContent).toBe(
        "# example.org\n\n> llms-full.txt truncated. See llms.txt for the complete page list.\n",
      );
    } else {
      expect(payload.result.fullContent).toBe(preamble + markdown + "\n");
    }
  },
);
