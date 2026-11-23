import { afterAll, expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

const app = tool();
const path = "/v1/llms-txt/page-entries";
const metadata = { title: null, description: null, canonicalUrl: null, language: null };
const base = { url: "https://example.org/", metadata, content: { text: "", markdown: "" } };
afterAll(() => app.close());

async function post(payload: Record<string, unknown> | string, status: number) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(status);
  const media = status === 200 ? "application/json" : "application/problem+json";
  expect(response.headers["content-type"]).toContain(media);
  const result: unknown = response.json();
  checkResponse("POST", path, status, media, result);
  return result;
}

test("returns the extractive result using supplied Markdown and blank metadata fallbacks", async () => {
  expect(
    await post(
      {
        ...base,
        summarizer: "extractive",
        metadata: {
          ...metadata,
          title: " \t",
          description: "\n",
          canonicalUrl: "https://www.example.org/",
        },
        content: {
          text: "Unrelated text.",
          markdown:
            "## **Quick** [start](https://example.org/guide)\n\nStart here. Then run setup. Later details.",
        },
      },
      200,
    ),
  ).toEqual({
    entry: { url: base.url, title: "Quick start", description: "Start here. Then run setup." },
    usage: [],
  });
});

test.each([
  ["<br>", "<br />"],
  ["<BR>", "<br/>"],
])(
  "normalizes inline HTML breaks %s and %s in extractive text",
  async (headingBreak, proseBreak) => {
    expect(
      await post(
        {
          ...base,
          summarizer: "extractive",
          metadata: { ...metadata, title: " ", description: "\t" },
          content: {
            text: "",
            markdown: `# Quick${headingBreak}start\n\nStart${proseBreak}here. Then run setup.`,
          },
        },
        200,
      ),
    ).toEqual({
      entry: { url: base.url, title: "Quick start", description: "Start here. Then run setup." },
      usage: [],
    });
  },
);

test.each([
  ["https://example.org:8443/", "example.org:8443"],
  ["https://example.org/guide?a=1", "/guide"],
])("uses the fallback title for %s and echoes the original URL", async (url, title) => {
  expect(await post({ ...base, url, summarizer: "extractive" }, 200)).toEqual({
    entry: { url, title, description: null },
    usage: [],
  });
});

test("clipped Unicode text satisfies the response schema", async () => {
  expect(
    await post(
      {
        ...base,
        summarizer: "extractive",
        metadata: { ...metadata, title: "😀".repeat(301), description: "e\u0301".repeat(501) },
      },
      200,
    ),
  ).toEqual({
    entry: {
      url: base.url,
      title: "😀".repeat(299) + "…",
      description: "e\u0301".repeat(499) + "…",
    },
    usage: [],
  });
});

test("returns the shared 422 Problem for a schema-valid URL rejected by WHATWG", async () => {
  expect(
    await post({ ...base, url: "https://example.org:65536/", summarizer: "extractive" }, 422),
  ).toMatchObject({
    status: 422,
    code: "invalid_page_url",
    detail: "/url is not a valid WHATWG URL.",
  });
});

test.each(["{", { ...base, url: "not a URL", summarizer: "extractive" }])(
  "uses HTTP 400 for malformed or schema-invalid API requests",
  async (payload) => {
    expect(await post(payload, 400)).toMatchObject({ status: 400, code: "validation_failed" });
  },
);

test.each([{}, { summarizer: "llm" }])(
  "keeps the default and explicit llm scaffold responses",
  async (options) => {
    // The URL is checked only by the extractive handler.
    expect(
      await post({ ...base, url: "https://example.org:65536/", ...options }, 501),
    ).toMatchObject({ status: 501, code: "not_implemented" });
  },
);
