import { expect, test } from "vitest";
import { validateLlmsTxt } from "../src/domain/validate-llms-txt.js";

test("allows a BOM, normal whitespace, a summary, and Markdown details before the lists", () => {
  const content = [
    "\uFEFF",
    "  # Example",
    "",
    "> Summary",
    "",
    "- A freeform detail without a link",
    "",
    "> Another blockquote in the details",
    "",
    "```md",
    "# An example heading",
    "## An example section",
    "```",
    "",
    "## Docs",
    "1. [**Guide**](https://example.org/guide): A note",
  ].join("\r\n");

  expect(validateLlmsTxt({ content })).toEqual({
    found: true,
    valid: true,
    url: null,
    httpStatus: null,
    issues: [],
  });
});

test.each([
  [" \r\n\t", "empty_file", "/content"],
  ["```md\n# Example only\n```", "missing_title", "/content"],
  ["#", "missing_title", "line:1"],
  ["# Example\n\n# Duplicate", "duplicate_title", "line:3"],
  ["Details\n\n# Example", "section_order", "line:1"],
  ["# Example\n\n### Unexpected heading", "section_order", "line:3"],
  ["# Example\n\n## Docs\n\n> Misplaced summary", "section_order", "line:5"],
  ["# Example\n\n## Docs", "missing_file_list", "line:3"],
  [
    "# Example\n\n## Docs\n- Text [Guide](https://example.org)",
    "invalid_file_list_entry",
    "line:4",
  ],
  ["# Example\n\n## Docs\n- [ ](https://example.org)", "invalid_file_list_entry", "line:4"],
  ["# Example\n\n## Docs\n- [Guide]()", "invalid_file_list_entry", "line:4"],
  ["# Example\n\n## Docs\n- [Guide](https://[)", "invalid_file_list_entry", "line:4"],
  [
    "# Example\n\n## Docs\n- [Guide](https://example.org)\n  - Text without a link",
    "invalid_file_list_entry",
    "line:5",
  ],
])("reports the structure error for %j", (content, code, pointer) => {
  const result = validateLlmsTxt({ content });
  expect(result).toMatchObject({ found: true, valid: false });
  expect(result.issues).toEqual([expect.objectContaining({ severity: "error", code, pointer })]);
});

test("uses CommonMark reference destinations and original source lines", () => {
  const content = "\uFEFF# Example\r\n\r\n## Docs\r\n- [Guide][ref]\r\n\r\n[ref]: ./guide.md";
  const inline = validateLlmsTxt({ content });
  expect(inline.valid).toBe(true);
  expect(inline.issues).toEqual([
    expect.objectContaining({ severity: "warning", code: "relative_link", pointer: "line:4" }),
  ]);
  const file = { url: "https://example.org/docs/llms.txt", status: 200, content };
  expect(validateLlmsTxt({ file })).toEqual({
    valid: true,
    found: true,
    url: file.url,
    httpStatus: 200,
    issues: [],
  });
});
