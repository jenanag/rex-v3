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
