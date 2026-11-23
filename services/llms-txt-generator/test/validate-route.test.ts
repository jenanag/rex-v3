import { afterAll, expect, test } from "vitest";
import type { components } from "../contract/types.js";
import { checkResponse, tool } from "./support.js";

const app = tool();
const path = "/v1/llms-txt/validate";
const url = "https://example.org/docs/llms.txt";
const relative = "# Example\n\n## Docs\n- [Guide](./guide.md)";
afterAll(() => app.close());

async function post(payload: Record<string, unknown> | string, status = 200) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(status);
  const media = status === 200 ? "application/json" : "application/problem+json";
  expect(response.headers["content-type"]).toContain(media);
  const body: unknown = response.json();
  checkResponse("POST", path, status, media, body);
  return body;
}

test.each([
  ["an H1-only file", "# Example"],
  ["heading syntax inside a fence", "# Example\n\n```md\n# Example only\n## Not a file list\n```"],
  [
    "a Setext H1 and a parenthesized destination",
    "Example\n=======\n\n## Docs\n- [Guide](https://example.org/a(b).md)",
  ],
])("returns a valid response for %s", async (_label, content) => {
  expect(await post({ content })).toEqual({
    valid: true,
    found: true,
    url: null,
    httpStatus: null,
    issues: [],
  });
});

test.each([
  ["No heading", "missing_title", "/content"],
  ["# Example\n\n# Duplicate", "duplicate_title", "line:3"],
  ["## Docs\n\n- [Guide](https://example.org)\n\n# Late title", "section_order", "line:1"],
  [
    "# Example\n\n## Docs\n- [Guide](https://example.org)\n\nLate details",
    "section_order",
    "line:6",
  ],
  [
    "Example\n=======\n\n## Docs\n- [Guide](https://example.org/a(b).md)\n- Missing a link",
    "invalid_file_list_entry",
    "line:6",
  ],
])("returns HTTP 200 with the structural finding for %j", async (content, code, pointer) => {
  expect(await post({ content })).toMatchObject({
    valid: false,
    found: true,
    issues: [expect.objectContaining({ severity: "error", code, pointer })],
  });
});

test("warns for inline relative links and resolves them against a supplied file URL", async () => {
  expect(await post({ content: relative })).toMatchObject({
    valid: true,
    found: true,
    url: null,
    httpStatus: null,
    issues: [
      expect.objectContaining({ severity: "warning", code: "relative_link", pointer: "line:4" }),
    ],
  });
  expect(await post({ file: { url, status: 200, content: relative } })).toEqual({
    valid: true,
    found: true,
    url,
    httpStatus: 200,
    issues: [],
  });
});

test.each([
  [{ content: "" }, null, null, "/content"],
  [{ file: { url, status: 204, content: " \n\t" } }, url, 204, "/file/content"],
])("reports blank strings as present files", async (request, expectedUrl, status, pointer) => {
  expect(await post(request)).toMatchObject({
    valid: false,
    found: true,
    url: expectedUrl,
    httpStatus: status,
    issues: [expect.objectContaining({ severity: "error", code: "empty_file", pointer })],
  });
});

test.each([
  [404, "# Unavailable", "/file/status"],
  [null, null, "/file/status"],
  [200, null, "/file/content"],
] satisfies [components["schemas"]["FetchedFile"]["status"], string | null, string][])(
  "reports an unavailable fetched file with status %s",
  async (status, content, pointer) => {
    expect(await post({ file: { url, status, content } })).toEqual({
      valid: false,
      found: false,
      url,
      httpStatus: status,
      issues: [expect.objectContaining({ severity: "error", code: "file_unavailable", pointer })],
    });
  },
);

test.each([
  "{",
  {},
  { content: null },
  { content: "# Two sources", file: { url, status: 200, content: "# Example" } },
  { file: { url, status: 200 } },
])("uses the existing HTTP 400 path for malformed or schema-invalid requests", async (payload) => {
  expect(await post(payload, 400)).toMatchObject({ status: 400, code: "validation_failed" });
});
