import { afterAll, expect, test } from "vitest";
import type { components } from "../contract/types.js";
import { robotsParser } from "../src/domain/robots-rules.js";
import { checkResponse, crawlers, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());

const path = "/v1/crawler-checks";
const siteUrl = "https://example.org/";
const robotsUrl = siteUrl + "robots.txt";
type Result = components["schemas"]["CrawlerCheck"];

async function post(payload: object | string, status = 200) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(response.statusCode).toBe(status);
  const contentType = status === 200 ? "application/json" : "application/problem+json";
  expect(response.headers["content-type"]).toContain(contentType);
  checkResponse("POST", path, status, contentType, response.json());
  return response;
}

async function check(content: string | null, status: number | null = 200) {
  const response = await post({ siteUrl, robotsTxt: { url: robotsUrl, status, content } });
  const result = response.json<Result>();
  expect(result).toMatchObject({ siteUrl, robotsTxtUrl: robotsUrl, robotsTxtStatus: status });
  expect(result).not.toHaveProperty("checkedAt");
  expect(result.crawlers.map(({ id }) => id)).toEqual(crawlers.map(({ id }) => id));
  return result;
}

test.each([400, 403, 404, 429, 499])("allows every crawler for fetch status %s", async (status) => {
  const result = await check("User-agent: *\nDisallow: /", status);
  for (const crawler of result.crawlers)
    expect(crawler).toMatchObject({ access: "allowed", matchedGroup: null });
});

test.each([null, -1, 99, 100, 199, 300, 399, 500, 599, 600, 900])(
  "returns unknown for fetch status %s",
  async (status) => {
    const result = await check("User-agent: *\nDisallow: /", status);
    for (const crawler of result.crawlers)
      expect(crawler).toMatchObject({ access: "unknown", matchedGroup: null });
  },
);

test("returns unknown for a 2xx result without a string body", async () => {
  const result = await check(null, 204);
  for (const crawler of result.crawlers)
    expect(crawler).toMatchObject({ access: "unknown", matchedGroup: null });
});

test.each(["", " \t\n", "# no rules", "User-agent: Unrelated\nDisallow: /"])(
  "allows every crawler with no matched rules (%j)",
  async (content) => {
    const result = await check(content, 299);
    for (const crawler of result.crawlers)
      expect(crawler).toMatchObject({ access: "allowed", matchedGroup: null });
  },
);

test.each([
  ["", "disallowed", "*"],
  ["Crawl-delay: 5", "allowed", "GPTBot"],
  ["Crawl-delay: invalid", "allowed", "GPTBot"],
  ["Disallow:", "allowed", "GPTBot"],
  ["Allow:", "allowed", "GPTBot"],
])("matches the pinned parser for named group suffix %j", async (suffix, access, matchedGroup) => {
  const content = "User-agent: *\r\nDisallow: /\r\nUSER-AGENT: gptBOT\r\n" + suffix;
  const { crawlers: results } = await check(content);
  expect(results.find(({ id }) => id === "gptbot")).toMatchObject({ access, matchedGroup });
  expect(results.find(({ id }) => id === "ccbot")).toMatchObject({
    access: "disallowed",
    matchedGroup: "*",
  });
  expect(robotsParser(robotsUrl, content).isAllowed(siteUrl, "GPTBot")).toBe(access === "allowed");
});

test.each([
  ["Disallow: /\nAllow: /open", "disallowed"],
  ["Disallow: /$\nAllow: /open", "disallowed"],
  ["Disallow: /\nAllow: /$", "partial"],
  ["Disallow: /private/*\nAllow: /private/open$", "partial"],
  ["Disallow: /private/*\nAllow: /private/*", "allowed"],
  ["Disallow: /abc$\nAllow: /abc*", "allowed"],
  ["Disallow: /abc$\nAllow: /*abc$", "allowed"],
  ["Disallow: /abc$\nAllow: /abc?more", "partial"],
  ["Disallow: /?q=*x$", "partial"],
  ["Disallow: /caf%C3%a9$", "partial"],
  ["Disallow: /café$\nAllow: /caf%C3%A9$", "allowed"],
  ["Disallow: /a**b$\nAllow: /*b$", "partial"],
  ["Disallow: /a**b$\nAllow: /**b*$", "allowed"],
  ["Disallow: /../sealed$", "unknown"],
])("classifies effective blocks for %j", async (rules, access) => {
  const result = await check("User-agent: *\n" + rules);
  for (const crawler of result.crawlers)
    expect(crawler).toMatchObject({ access, matchedGroup: "*" });
});

test("matches named groups exactly and merges repeated groups before falling back to wildcard", async () => {
  const result = await check(
    "User-agent: *\nDisallow: /\n" +
      "User-agent: GPTBot\nDisallow: /private\n" +
      "User-agent: gptbot/1.0\nAllow: /private\n" +
      "User-agent: CCBot-Other\nAllow: /",
  );
  expect(result.crawlers.find(({ id }) => id === "gptbot")).toMatchObject({
    access: "allowed",
    matchedGroup: "GPTBot",
  });
  expect(result.crawlers.find(({ id }) => id === "ccbot")).toMatchObject({
    access: "disallowed",
    matchedGroup: "*",
  });
});

test("checks the origin root and echoes the original URL strings", async () => {
  const original = "https://Example.org:443/open?q=1#part";
  const result = (
    await post({
      siteUrl: original,
      robotsTxt: { url: robotsUrl, status: 200, content: "User-agent: *\nDisallow: /$" },
    })
  ).json<Result>();
  expect(result.siteUrl).toBe(original);
  expect(result.robotsTxtUrl).toBe(robotsUrl);
  expect(result.crawlers.every(({ access }) => access === "disallowed")).toBe(true);
});

test.each([
  ["https://example.org:65536/", robotsUrl, "invalid_crawler_url", "/siteUrl"],
  [siteUrl, "https://example.org:65536/robots.txt", "invalid_crawler_url", "/robotsTxt/url"],
  [siteUrl, "http://example.org/robots.txt", "robots_origin_mismatch", "/robotsTxt/url"],
  [siteUrl, "https://example.org:444/robots.txt", "robots_origin_mismatch", "/robotsTxt/url"],
  ["https://example.org./", robotsUrl, "robots_origin_mismatch", "/robotsTxt/url"],
])("rejects invalid URL evidence (%s, %s)", async (siteUrl, url, code, field) => {
  const response = await post({ siteUrl, robotsTxt: { url, status: 404, content: null } }, 422);
  expect(response.json()).toMatchObject({ code, detail: expect.stringContaining(field) });
});

test.each([
  "{",
  {},
  { siteUrl: "example.org", robotsTxt: { url: robotsUrl, status: 200, content: null } },
])("returns the shared problem for malformed or schema-invalid requests (%j)", async (body) => {
  expect((await post(body, 400)).json()).toMatchObject({ code: "validation_failed" });
});

test("preserves known groups when a group hits its cutoff and repeats identically", async () => {
  const content =
    "User-agent: GPTBot\nDisallow: /" + "a".repeat(5_000) + "\nUser-agent: *\nDisallow: /";
  const first = await check(content);
  expect(await check(content)).toEqual(first);
  expect(first.crawlers.find(({ id }) => id === "gptbot")).toMatchObject({
    access: "unknown",
    matchedGroup: "GPTBot",
  });
  expect(first.crawlers.find(({ id }) => id === "ccbot")).toMatchObject({
    access: "disallowed",
    matchedGroup: "*",
  });
});

test("limits aggregate work across distinct selected groups", async () => {
  const content = crawlers
    .map(
      ({ robotsToken }) =>
        "User-agent: " + robotsToken + "\nDisallow: /\nAllow: /" + "x".repeat(1_800),
    )
    .join("\n");
  const first = await check(content);
  expect(await check(content)).toEqual(first);
  expect(first.crawlers[0]).toMatchObject({ access: "disallowed" });
  expect(first.crawlers.at(-1)).toMatchObject({
    access: "unknown",
    matchedGroup: crawlers.at(-1)?.robotsToken,
  });
});

test("reports a search cutoff after confirming the root is allowed", async () => {
  const content = "User-agent: *\nDisallow: /" + "x".repeat(1_000) + "$";
  expect(robotsParser(robotsUrl, content).isAllowed(siteUrl, "*")).toBe(true);
  const result = await check(content);
  expect(
    result.crawlers.every(
      ({ access, matchedGroup }) => access === "unknown" && matchedGroup === "*",
    ),
  ).toBe(true);
});

test("short-circuits an allow-only group even when its rules would exceed the analysis budget", async () => {
  const result = await check("User-agent: *\nAllow: /" + "x".repeat(50_000));
  expect(
    result.crawlers.every(
      ({ access, matchedGroup }) => access === "allowed" && matchedGroup === "*",
    ),
  ).toBe(true);
});
