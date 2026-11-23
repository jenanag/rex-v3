import { afterAll, expect, test } from "vitest";
import type { AuditRequest, AuditResult } from "../src/domain/types.js";
import { checkResponse, crawlers, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());
const path = "/v1/audits";
const url = "https://example.org/start";
const finalUrl = "https://example.org/guide";
const base: AuditRequest = {
  url,
  page: { finalUrl, status: 200, headers: {}, html: "<p>Guide</p>" },
  content: { text: "", markdown: "" },
};
const inline = { url: null, httpStatus: null, found: true, valid: true, issues: [] } as const;
const script = (value: unknown) =>
  '<script type="application/ld+json">' + JSON.stringify(value) + "</script>";
const article = { "@context": "https://schema.org", "@type": "Article" };
const lead =
  "Follow these steps to set up your account and verify that your first project is ready to use.";

async function audit(payload: AuditRequest) {
  const response = await app.inject({ method: "POST", url: path, payload });
  expect(response.statusCode).toBe(200);
  const result = response.json<AuditResult>();
  checkResponse("POST", path, 200, "application/json", result);
  expect(result.url).toBe(payload.url);
  expect(result.finalUrl).toBe(payload.page.finalUrl);
  return result;
}

const results = (audit: AuditResult) =>
  Object.fromEntries(audit.checks.map(({ id, result }) => [id, result]));

const mixed: AuditRequest = {
  ...base,
  page: {
    ...base.page,
    headers: { "x-robots-tag": "GPTBot: nosnippet" },
    html:
      '<link rel="canonical" href="/another"><meta name="robots" content="noindex">' +
      script({
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Example",
        sameAs: "/relative",
      }) +
      '<main><p>Setup guide</p><time datetime="2026-01-05">5 January</time></main>',
  },
  content: { text: "", markdown: "# Setup\n\n" + lead },
  llmsTxt: {
    ...inline,
    issues: [{ severity: "warning", message: "This is a synthetic warning." }],
  },
};

test("returns the approved mixed score of 66 in category, check, and crawler order", async () => {
  const result = await audit(mixed);
  expect(result.score).toBe(66);
  expect(result.categoryScores.map(({ category, score }) => [category, score])).toEqual([
    ["crawler_access", 50],
    ["structured_data", 100],
    ["llms_txt", 50],
    ["answer_readiness", 50],
    ["entity_signals", 50],
    ["technical", 63],
    ["freshness", 100],
  ]);
  expect(result.checks.map(({ id }) => id)).toEqual([
    ...crawlers.map(({ id }) => "robots_allows_" + id),
    "crawler_page_directives",
    "jsonld_present",
    "jsonld_shape",
    "llms_txt_valid",
    "answer_question_headings",
    "answer_direct_lead",
    "answer_chunkable_sections",
    "entity_identity",
    "entity_same_as",
    "http_status",
    "server_rendered_copy",
    "canonical_url",
    "page_indexability",
    "freshness_dates",
  ]);
  expect(
    result.checks.slice(0, crawlers.length).every(({ result }) => result === "not_applicable"),
  ).toBe(true);
  expect(results(result)).toMatchObject({
    crawler_page_directives: "warn",
    jsonld_shape: "pass",
    llms_txt_valid: "warn",
    answer_question_headings: "warn",
    answer_direct_lead: "pass",
    answer_chunkable_sections: "fail",
    entity_identity: "pass",
    entity_same_as: "fail",
    http_status: "pass",
    server_rendered_copy: "pass",
    canonical_url: "warn",
    page_indexability: "fail",
    freshness_dates: "pass",
  });
});

test("returns 81 using unrounded applicable category scores for a selected subset", async () => {
  const { llmsTxt: _, ...selected } = mixed;
  expect(_).toBeDefined();
  const result = await audit({ ...selected, categories: ["technical", "freshness", "llms_txt"] });
  expect(result.score).toBe(81);
  expect(result.categoryScores).toEqual([
    { category: "technical", score: 63 },
    { category: "freshness", score: 100 },
  ]);
  expect(result.checks.map(({ category }) => category)).toEqual([
    "llms_txt",
    "technical",
    "technical",
    "technical",
    "technical",
    "freshness",
  ]);
  expect(result.checks[0]).toMatchObject({ id: "llms_txt_valid", result: "not_applicable" });
});

test("returns 0 and explicit not_applicable findings when no selected checks apply", async () => {
  const result = await audit({ ...base, categories: ["freshness", "llms_txt"] });
  expect(result).toEqual({
    url,
    finalUrl,
    score: 0,
    categoryScores: [],
    checks: [
      {
        id: "llms_txt_valid",
        category: "llms_txt",
        result: "not_applicable",
        message: "No llms.txt validation result was supplied.",
      },
      {
        id: "freshness_dates",
        category: "freshness",
        result: "not_applicable",
        message: "No supported date signals were supplied.",
      },
    ],
  });
});

test("retains the zero scores of applicable categories whose checks all fail", async () => {
  const result = await audit({
    ...base,
    categories: ["llms_txt", "structured_data"],
    llmsTxt: {
      url: "https://example.org/llms.txt",
      httpStatus: 404,
      found: false,
      valid: false,
      issues: [],
    },
  });
  expect(result.score).toBe(0);
  expect(result.categoryScores).toEqual([
    { category: "structured_data", score: 0 },
    { category: "llms_txt", score: 0 },
  ]);
  expect(results(result)).toEqual({
    jsonld_present: "fail",
    jsonld_shape: "not_applicable",
    llms_txt_valid: "fail",
  });
});

test.each([
  [inline, "pass"],
  [{ ...inline, issues: [{ severity: "info", message: "Info." }] }, "pass"],
  [{ ...inline, url: "https://example.org/llms.txt" }, "warn"],
  [{ ...inline, issues: [{ severity: "error", message: "Invalid." }] }, "fail"],
] as const)("evaluates supplied llms.txt results with null status", async (file, outcome) => {
  const result = await audit({
    ...base,
    categories: ["llms_txt"],
    llmsTxt: { ...file, issues: [...file.issues] },
  });
  expect(results(result).llms_txt_valid).toBe(outcome);
});

test.each([
  [script(article), "pass"],
  [script({ ...article, "@context": { alias: "https://schema.org/Article" } }), "warn"],
  [script(article) + '<script type="application/ld+json">{</script>', "warn"],
  [script({ "@graph": [7] }), "fail"],
  [script({ "@graph": [] }), "fail"],
  [script([]), "fail"],
] as const)("checks local JSON-LD syntax and shape", async (html, outcome) => {
  const result = await audit({
    ...base,
    categories: ["structured_data"],
    page: { ...base.page, html },
  });
  expect(results(result)).toEqual({ jsonld_present: "pass", jsonld_shape: outcome });
});

test("fails blank eligible rendered copy and keeps header evidence available", async () => {
  const result = await audit({
    ...base,
    page: {
      ...base.page,
      html: " \n ",
      headers: { "content-type": "text/html", "x-robots-tag": "noindex" },
    },
  });
  expect(results(result)).toMatchObject({
    http_status: "pass",
    server_rendered_copy: "fail",
    canonical_url: "not_applicable",
    page_indexability: "fail",
    crawler_page_directives: "pass",
    entity_identity: "not_applicable",
    jsonld_present: "not_applicable",
  });
});

test.each([
  ["GPTBot: index, noindex, nosnippet", "warn", "pass"],
  ["noindex, GPTBot: index, nosnippet", "warn", "fail"],
  ["GPTBot: noindex, nofollow", "fail", "pass"],
] as const)(
  "scores ambiguous restrictive header clauses only once",
  async (header, crawler, generic) => {
    const response = await audit({
      ...base,
      categories: ["technical", "crawler_access"],
      page: { ...base.page, headers: { "x-robots-tag": header } },
    });
    expect(results(response)).toMatchObject({
      crawler_page_directives: crawler,
      page_indexability: generic,
    });
    expect(response.checks.filter(({ result }) => result === "warn")).toHaveLength(
      crawler === "warn" ? 2 : 1,
    );
  },
);

test.each([
  [
    { status: 200, content: "User-agent: GPTBot\nDisallow: /guide\nUser-agent: *\nAllow: /" },
    "fail",
    "pass",
  ],
  [{ status: 404, content: null }, "pass", "pass"],
  [{ status: 503, content: null }, "warn", "warn"],
  [{ status: 200, content: "" }, "pass", "pass"],
  [{ status: 200, content: null }, "warn", "warn"],
] as const)("evaluates robots.txt at the final page URL", async (file, gptBot, searchBot) => {
  const response = await audit({
    ...base,
    categories: ["crawler_access"],
    robotsTxt: { url: "https://example.org/robots.txt", ...file },
  });
  expect(results(response)).toMatchObject({
    robots_allows_gptbot: gptBot,
    robots_allows_oai_searchbot: searchBot,
  });
});

test("warns on robots.txt from another origin", async () => {
  const response = await audit({
    ...base,
    categories: ["crawler_access"],
    robotsTxt: { url: "https://example.com/robots.txt", status: 404, content: null },
  });
  expect(results(response).robots_allows_gptbot).toBe("warn");
});

test("uses local author references and rejects an invalid sameAs alongside usable links", async () => {
  const response = await audit({
    ...base,
    categories: ["entity_signals"],
    page: {
      ...base.page,
      html: script({
        "@context": "https://schema.org/",
        "@graph": [
          { "@type": "Article", author: { "@id": "#author" } },
          {
            "@id": "#author",
            "@type": "Person",
            name: "Example",
            sameAs: ["https://example.net/person", "/relative"],
          },
        ],
      }),
    },
  });
  expect(results(response)).toEqual({ entity_identity: "pass", entity_same_as: "warn" });
});

test("ignores fenced Markdown and recognizes headed prose and a table", async () => {
  const markdown =
    "~~~md\n# Synthetic code heading?\n~~~\n\n" +
    "# How do I start? ##\n\n" +
    lead +
    "\n\n## Next steps\n\nReview the settings.\n\nA | B\n--- | ---\n1 | 2";
  const response = await audit({
    ...base,
    categories: ["answer_readiness"],
    content: { text: "short", markdown },
  });
  expect(results(response)).toEqual({
    answer_question_headings: "pass",
    answer_direct_lead: "pass",
    answer_chunkable_sections: "pass",
  });
});

test("uses plain text for the lead only if Markdown is blank", async () => {
  const noProse = await audit({
    ...base,
    categories: ["answer_readiness"],
    content: { text: lead, markdown: "~~~\n# Heading?\n~~~" },
  });
  expect(results(noProse)).toEqual({
    answer_question_headings: "fail",
    answer_direct_lead: "fail",
    answer_chunkable_sections: "fail",
  });
  const fallback = await audit({
    ...base,
    categories: ["answer_readiness"],
    content: { text: lead, markdown: "" },
  });
  expect(results(fallback)).toEqual({
    answer_question_headings: "not_applicable",
    answer_direct_lead: "pass",
    answer_chunkable_sections: "not_applicable",
  });
});

test("lets confirmed restrictive HTML and header directives win and resolves a relative canonical", async () => {
  const response = await audit({
    ...base,
    categories: ["technical", "crawler_access"],
    page: {
      ...base.page,
      headers: { "X-Robots-Tag": "index, GPTBot: index" },
      html:
        '<link rel="canonical" href="./guide#frag"><meta name="GPTBot" content="noindex">' +
        '<meta name="robots" content="none"><body><noscript><p>Only fallback.</p></noscript></body>',
    },
  });
  expect(results(response)).toMatchObject({
    crawler_page_directives: "fail",
    page_indexability: "fail",
    canonical_url: "pass",
    server_rendered_copy: "warn",
  });
});

test.each([
  [{ datePublished: "2026-02-30" }, "", "", "fail"],
  [{ datePublished: "2026-02-24", dateModified: "2026-02-23" }, "", "Updated: 2026-03-01", "fail"],
  [
    { dateModified: "2026-02-25T00:30:00+01:00" },
    '<time itemprop="dateModified" datetime="2026-02-24"></time>',
    "",
    "pass",
  ],
  [{ datePublished: "2099-01-01" }, "", "Published: 2098-01-01", "warn"],
  [{ datePublished: "2099-01-01" }, "", "", "pass"],
] as const)(
  "evaluates dates by precedence and UTC calendar date alone",
  async (dates, html, text, outcome) => {
    const input = {
      ...base,
      categories: ["freshness"] as AuditRequest["categories"],
      page: { ...base.page, html: script({ ...article, ...dates }) + html },
      content: { text, markdown: "" },
    };
    const response = await audit(input);
    expect(results(response).freshness_dates).toBe(outcome);
    expect(await audit(input)).toEqual(response);
  },
);

test("keeps the schema-invalid API request on HTTP 400", async () => {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: { ...base, categories: [] },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toMatchObject({ code: "validation_failed" });
  checkResponse("POST", path, 400, "application/problem+json", response.json());
});

test("excludes hidden body copy from the rendered signal", async () => {
  const response = await audit({
    ...base,
    categories: ["technical"],
    page: { ...base.page, html: "<body hidden><p>Hidden copy.</p></body>" },
  });
  expect(results(response).server_rendered_copy).toBe("fail");
});

test.each([
  [undefined, "pass", "pass"],
  [null, "fail", "not_applicable"],
  [{ "@vocab": "https://example.net/" }, "fail", "not_applicable"],
  ["https://schema.org/", "pass", "pass"],
] as const)(
  "resolves nested publisher types under the effective context %j",
  async (context, identity, sameAs) => {
    const publisher = {
      ...(context === undefined ? {} : { "@context": context }),
      "@type": "Organization",
      name: "Example Publisher",
      sameAs: "https://example.net/publisher",
    };
    const response = await audit({
      ...base,
      categories: ["entity_signals"],
      page: { ...base.page, html: script({ ...article, publisher }) },
    });
    expect(results(response)).toEqual({ entity_identity: identity, entity_same_as: sameAs });
  },
);

test("restores the literal Schema.org context inside an overridden subtree", async () => {
  const response = await audit({
    ...base,
    categories: ["entity_signals"],
    page: {
      ...base.page,
      html: script({
        ...article,
        publisher: {
          "@context": null,
          "@type": "Organization",
          name: "Unrecognized Publisher",
          sameAs: "/invalid",
          department: [
            {
              "@context": "https://schema.org",
              "@type": "Organization",
              name: "Example Department",
              sameAs: "https://example.net/department",
            },
          ],
        },
      }),
    },
  });
  expect(results(response)).toEqual({ entity_identity: "pass", entity_same_as: "pass" });
});

test("reads the date of a nested article through containers", async () => {
  const response = await audit({
    ...base,
    categories: ["structured_data", "freshness"],
    page: {
      ...base.page,
      html: script({
        ...article,
        hasPart: [{ item: { "@type": "Article", datePublished: "2026-06-14" } }],
      }),
    },
  });
  expect(results(response)).toEqual({
    jsonld_present: "pass",
    jsonld_shape: "pass",
    freshness_dates: "pass",
  });
});

test("checks an invalid date even when the parseable block fails shape", async () => {
  const response = await audit({
    ...base,
    categories: ["structured_data", "freshness"],
    page: {
      ...base.page,
      html: script({
        ...article,
        "@type": 42,
        datePublished: "2026-02-30",
      }),
    },
  });
  expect(results(response)).toEqual({
    jsonld_present: "pass",
    jsonld_shape: "fail",
    freshness_dates: "fail",
  });
});

test.each([
  ["- Item\n\n  " + lead + "\n\nShort lead.", "warn"],
  ["1. Item\n\n   " + lead, "fail"],
] as const)("skips list continuation prose after a blank line", async (markdown, outcome) => {
  const response = await audit({
    ...base,
    categories: ["answer_readiness"],
    content: { text: "", markdown },
  });
  expect(results(response).answer_direct_lead).toBe(outcome);
});
