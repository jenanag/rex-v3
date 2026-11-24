import { afterAll, expect, test } from "vitest";
import type { components } from "../contract/types.js";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());
const path = "/v1/citation-extractions";
type Input = components["schemas"]["CitationExtractionRequest"];
type Output = components["schemas"]["CitationExtraction"];

async function extract(
  markdown: string,
  sources: Input["sources"] = [],
  brands: Input["brands"] = [],
) {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: { markdown, sources, brands },
  });
  expect(response.statusCode).toBe(200);
  const output = response.json<Output>();
  checkResponse("POST", path, 200, "application/json", output);
  return output.citations;
}

test("reads CommonMark links in order and ignores noncitation tokens", async () => {
  const markdown = [
    "https://example.test/bare [Relative](/guide) [No scheme](//example.test/a)",
    "[Script](javascript:alert(1)) <me@example.test> ![Image](https://example.test/img)",
    '<a href="https://example.test/html">HTML</a> `[Code](https://example.test/code)`',
    "Inline <code>[Raw code](https://example.test/raw-code) [Reference][ref] <https://example.test/raw-auto></code>",
    "",
    "```",
    "[Fence](https://example.test/fence)",
    "```",
    "",
    "    [Indented code](https://example.test/indent)",
    "",
    '> [ **Guide** and `setup` ](https://example.test/a "Tooltip")',
    "",
    "- [Reference][ref]",
    "- <https://example.test/c>",
    "- [![A &amp; B](https://example.test/img)](https://example.test/d)",
    "",
    '[ref]: https://example.test/b "Reference tooltip"',
    "[unused]: https://example.test/unused",
  ].join("\n");
  expect(
    (await extract(markdown)).map(({ url, title, position, sourceType }) => [
      url,
      title,
      position,
      sourceType,
    ]),
  ).toEqual([
    ["https://example.test/a", "Guide and setup", 1, "inline_link"],
    ["https://example.test/b", "Reference", 2, "inline_link"],
    ["https://example.test/c", "https://example.test/c", 3, "inline_link"],
    ["https://example.test/d", "A & B", 4, "inline_link"],
  ]);
});

test("decodes entities once and preserves escapes, codespans and autolinks", async () => {
  const markdown = [
    "[A &amp; B](https://example.test/?a=1&amp;b=2)",
    "[&#65; &#x1F600; &NotEqualTilde; &unrecognized; &amp;amp;](https://example.test/numeric&#47;test)",
    String.raw`[Escaped \&amp; and ` +
      "`&amp;`" +
      String.raw`](https://example.test/escaped?a=1\&amp;b=2)`,
    "[From reference][r]",
    "<https://example.test/auto?a=1&amp;b=2>",
    "[Unicode](https://example.test/f&ouml;&ouml;)",
    "",
    String.raw`[r]: <https://example.test/ref?a=1&amp;b=2&c=3\&amp;d=4>`,
  ].join("\n\n");
  expect((await extract(markdown)).map(({ url, title }) => [url, title])).toEqual([
    ["https://example.test/?a=1&b=2", "A & B"],
    ["https://example.test/numeric/test", "A 😀 ≂̸ &unrecognized; &amp;"],
    ["https://example.test/escaped?a=1&amp;b=2", "Escaped &amp; and &amp;"],
    ["https://example.test/ref?a=1&b=2&c=3&amp;d=4", "From reference"],
    ["https://example.test/auto?a=1&amp;b=2", "https://example.test/auto?a=1&amp;b=2"],
    ["https://example.test/f%C3%B6%C3%B6", "Unicode"],
  ]);
});

test("skips malformed and unrepresentable citations and normalizes usable URLs", async () => {
  const sources = [
    "https://",
    "http:///path",
    "https://example.test:65536/",
    "https://[2001:db8::1]/",
    "https://under_score.example.test/",
    "https://user:pass@example.test/",
    "https://WWW.Example.test.:443/A?x=1&x=2#intro",
    "http://example.test:86/A/",
  ].map((url, index) => ({ url, position: index + 1 }));
  const markdown = [
    "[Bad percent](https://example.test/%ZZ)",
    "[Bad syntax](https://example.test/a b)",
    "[Empty host](http:///repaired)",
    "[Bad port](https://example.test:65537/)",
    "[Credentials](https://user@example.test/)",
    "[IPv6](https://[::1]/)",
    "[Case](HTTPS://EXAMPLE.TEST:443/B#part)",
    "[Different query](https://example.test/B?q=2&q=1)",
  ].join("\n");
  expect((await extract(markdown, sources)).map(({ url, domain }) => [url, domain])).toEqual([
    ["https://www.example.test/A?x=1&x=2", "example.test"],
    ["http://example.test:86/A/", "example.test"],
    ["https://example.test/B", "example.test"],
    ["https://example.test/B?q=2&q=1", "example.test"],
  ]);
});

test("deduplicates in engine position and Markdown order and keeps the winning fields", async () => {
  const sources = [
    { url: "https://example.test/x#late", title: "Late", position: 9 },
    { url: "https://example.test/y", position: 5 },
    { url: "https://EXAMPLE.test.:443/x#early", title: null, position: 2 },
    { url: "https://example.test/y#tie", title: "Tie loser", position: 5 },
    { url: "https://example.test/stable-tie", title: "Later in array", position: 5 },
  ];
  const markdown =
    "[Do not backfill](https://example.test/x) [ First **Z** ](https://example.test/z#one) [Last Z](https://example.test/z#two)";
  expect(
    (await extract(markdown, sources)).map(({ url, title, position, sourceType }) => [
      url,
      title,
      position,
      sourceType,
    ]),
  ).toEqual([
    ["https://example.test/x", null, 1, "engine_source"],
    ["https://example.test/y", null, 2, "engine_source"],
    ["https://example.test/stable-tie", "Later in array", 3, "engine_source"],
    ["https://example.test/z", "First Z", 4, "inline_link"],
  ]);
});

const brand = (key: string, kind: Input["brands"][number]["kind"], ...domains: string[]) => ({
  key,
  kind,
  name: key,
  aliases: [],
  domains,
});

test("matches the most specific host, then primary and input order", async () => {
  const brands = [
    brand("first", "competitor", "docs.example.test", "equal.test"),
    brand("second", "competitor", "DOCS.EXAMPLE.TEST."),
    brand("primary", "primary", "example.test", "EQUAL.TEST.", "127.0.0.1"),
    brand("www-competitor", "competitor", "www.example.test"),
  ];
  const urls = [
    "api.example.test",
    "docs.example.test",
    "news.docs.example.test",
    "api.equal.test",
    "www.example.test",
    "notexample.test",
    "127.0.0.1",
  ];
  const sources = urls.map((host, index) => ({
    url: "https://" + host + (index === 4 ? ":8443/" : "/"),
    position: index + 1,
  }));
  expect(
    (await extract("", sources, brands)).map(({ domain, ownership, brandKey }) => [
      domain,
      ownership,
      brandKey,
    ]),
  ).toEqual([
    ["api.example.test", "own", "primary"],
    ["docs.example.test", "competitor", "first"],
    ["news.docs.example.test", "competitor", "first"],
    ["api.equal.test", "own", "primary"],
    ["example.test", "competitor", "www-competitor"],
    ["notexample.test", "third_party", null],
    ["127.0.0.1", "own", "primary"],
  ]);
});

test("returns a valid empty response when all potential citations are skipped", async () => {
  expect(
    await extract("[relative](/path) <me@example.test>", [{ url: "https://", position: 1 }]),
  ).toEqual([]);
});
