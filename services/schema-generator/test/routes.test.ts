import { afterAll, afterEach, expect, test, vi } from "vitest";
import { schemaContext } from "../src/domain/schema.js";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());
afterEach(() => vi.unstubAllGlobals());

const generate = "/v1/schema-markup";
const validate = "/v1/schema-markup/validate";
const script = (jsonLd: unknown) =>
  '<script type="application/ld+json">' + JSON.stringify(jsonLd) + "</script>";

async function post(path: string, payload: string | object, status: number) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode, response.payload).toBe(status);
  const media = status >= 400 ? "application/problem+json" : "application/json";
  expect(response.headers["content-type"]).toContain(media);
  const body = response.json();
  checkResponse("POST", path, status, media, body);
  return body;
}

test("validates an inline document with the bundled context", async () => {
  const result = await post(
    validate,
    {
      jsonLd: { "@context": schemaContext, "@type": "Article", headline: "News" },
    },
    200,
  );
  expect(result).toEqual({ valid: true, issues: [] });
});

test("validates mixed HTML blocks independently in source order", async () => {
  const html = [
    "<head>",
    script({ "@context": schemaContext, "@type": "Article", headlne: "News" }),
    '<script type="application/ld+json">{</script>',
    script({ "@context": schemaContext, headline: "Last block" }),
    "</head>",
  ].join("\n");
  const result = await post(validate, { html }, 200);
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([
    expect.objectContaining({
      severity: "warning",
      code: "unknown_schema_property",
      pointer: "line:2",
    }),
    expect.objectContaining({ severity: "error", code: "malformed_jsonld", pointer: "line:3" }),
    expect.objectContaining({ severity: "warning", code: "untyped_graph", pointer: "line:4" }),
  ]);
});

test("rejects every other remote context offline while keeping a 200 response", async () => {
  const fetch = vi.fn(() => {
    throw new Error("network access");
  });
  vi.stubGlobal("fetch", fetch);
  const remote = {
    "@context": [schemaContext, "https://blocked.example/context"],
    "@type": "Article",
  };
  const result = await post(validate, { jsonLd: remote }, 200);
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([
    expect.objectContaining({
      severity: "error",
      code: "disallowed_remote_context",
      pointer: "/jsonLd/@context/1",
    }),
  ]);
  const htmlResult = await post(validate, { html: "\n" + script(remote) }, 200);
  expect(htmlResult.valid).toBe(false);
  expect(htmlResult.issues[0]).toMatchObject({
    code: "disallowed_remote_context",
    pointer: "line:2",
  });
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  [{ html: "<title>No markup</title>" }, "missing_jsonld", "line:1"],
  [{ jsonLd: { "@graph": 7 } }, "jsonld_expansion_failed", "/jsonLd"],
])("returns a content finding for %j", async (payload, code, pointer) => {
  const result = await post(validate, payload, 200);
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual([expect.objectContaining({ severity: "error", code, pointer })]);
});

test("returns generated JSON-LD and a safe script tag for data", async () => {
  const name = "Example </script><script>alert('x')</script>";
  const result = await post(
    generate,
    { schemaType: "Organization", source: { data: { name } } },
    200,
  );
  expect(result.jsonLd).toEqual({ "@context": schemaContext, "@type": "Organization", name });
  const scriptStart = '<script type="application/ld+json">';
  const contents = result.scriptTag.slice(scriptStart.length, -"</script>".length);
  expect(result.scriptTag.startsWith(scriptStart)).toBe(true);
  expect(contents).not.toContain("<");
  expect(JSON.parse(contents)).toEqual(result.jsonLd);
  expect(result.validation).toEqual({ valid: true, issues: [] });
});

test("uses the first usable exact match, fills blanks, and applies pageUrl to URL fields", async () => {
  const html = [
    "<title>Ordinary title</title>",
    '<meta name="description" content="Ordinary description">',
    '<meta property="og:title" content="OG title">',
    '<meta property="og:description" content="OG description">',
    '<meta property="og:image" content="/other.png">',
    '<meta property="og:url" content="/other">',
    script({
      "@context": schemaContext,
      "@graph": [
        { "@type": "NewsArticle", headline: "Wrong type" },
        { "@type": "Article", headline: { "@value": " ", "@language": "en" } },
        {
          "@type": "https://schema.org/Article",
          "https://schema.org/headline": "A",
          image: "/cover.jpg",
        },
        { "@type": "Article", headline: "B" },
      ],
    }),
    script({ "@context": schemaContext, "@type": "Article", headline: "Later block" }),
  ].join("\n");
  const result = await post(
    generate,
    {
      schemaType: "Article",
      source: { html, pageUrl: "https://example.com/news/story" },
    },
    200,
  );
  expect(result.jsonLd).toEqual({
    "@context": schemaContext,
    "@type": "Article",
    headline: "A",
    description: "OG description",
    image: "https://example.com/cover.jpg",
    url: "https://example.com/news/story",
  });
});

test("falls back to ordinary metadata and omits a relative URL when no pageUrl is supplied", async () => {
  const html = [
    "<title>Ordinary title</title>",
    '<meta name="description" content="Ordinary description">',
    '<meta property="og:url" content="https://example.com/page">',
    '<meta property="og:image" content="/cover.jpg">',
    script({
      "@context": "https://blocked.example/context",
      "@type": "Article",
      headline: "Skip me",
    }),
  ].join("\n");
  const result = await post(generate, { schemaType: "Article", source: { html } }, 200);
  expect(result.jsonLd).toEqual({
    "@context": schemaContext,
    "@type": "Article",
    headline: "Ordinary title",
    description: "Ordinary description",
    url: "https://example.com/page",
  });
  expect(result.validation).toMatchObject({
    valid: true,
    issues: [
      expect.objectContaining({ severity: "warning", code: "unresolved_url", pointer: "line:4" }),
    ],
  });
});

test.each([{ data: {} }, { html: "<p>Only pageUrl</p>", pageUrl: "https://example.com/" }])(
  "returns a shared 422 Problem for %j",
  async (source) => {
    const result = await post(generate, { schemaType: "Article", source }, 422);
    expect(result).toMatchObject({ status: 422, code: "no_usable_content" });
  },
);

test.each([
  [validate, "{"],
  [validate, { html: "<p>x</p>", jsonLd: {} }],
  [generate, { schemaType: "NonContractedType", source: { data: { name: "x" } } }],
  [generate, { schemaType: "Article", source: { html: "x".repeat(250_001) } }],
])("keeps malformed or schema-invalid requests on the 400 path at %s", async (path, payload) => {
  const result = await post(path, payload, 400);
  expect(result).toMatchObject({ status: 400, code: "validation_failed" });
});
