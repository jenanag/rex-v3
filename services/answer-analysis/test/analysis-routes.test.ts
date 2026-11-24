import { afterAll, expect, test } from "vitest";
import { checkResponse, tool } from "./support.js";

const app = tool();
afterAll(() => app.close());
const path = "/v1/answer-analyses";
const brand = { key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] };
const beta = { ...brand, key: "beta", kind: "competitor", name: "Beta" };
const basic = { text: "Acme is good.", brands: [brand] };
const lex = "det:lexicon";
const rules = "det:rules";

async function post(payload: unknown, status = 200) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
  expect(response.statusCode, response.body).toBe(status);
  const media = status === 200 ? "application/json" : "application/problem+json";
  expect(response.headers["content-type"]).toContain(media);
  const result = response.json();
  checkResponse("POST", path, status, media, result);
  return result;
}

test("catalog advertises the two offline analyzers and registered English language", async () => {
  const url = "/v1/analyzers";
  const response = await app.inject({ method: "GET", url });
  expect(response.statusCode).toBe(200);
  const catalog = response.json();
  checkResponse("GET", url, 200, "application/json", catalog);
  expect(catalog.data).toMatchObject([
    { id: lex, kind: "deterministic", languages: ["en"] },
    { id: rules, kind: "deterministic", languages: ["en"] },
  ]);
});

test("the registered route applies equivalent HTTP defaults and preserves empty selection", async () => {
  expect(app.initialConfig.bodyLimit).toBe(3_145_728);
  const result = await post(basic);
  expect(await post({ ...basic, sentiment: {} })).toEqual(result);
  expect(
    await post({
      ...basic,
      sentiment: { analyzers: [lex], onUnsupportedLanguage: "fallback" },
    }),
  ).toEqual(result);
  expect(result).toMatchObject({
    language: "en",
    languageSource: "detected",
    primaryFallback: false,
    analyzers: [{ analyzer: lex, status: "ok", primary: true }],
    mentions: [{ brandKey: "acme", sentiment: "positive", sentimentScore: 0.5 }],
    usage: [],
  });
  expect(await post({ ...basic, sentiment: { analyzers: [] } })).toEqual({
    language: "en",
    languageSource: "detected",
    primaryFallback: false,
    analyzers: [],
    usage: [],
    mentions: [
      {
        brandKey: "acme",
        position: 1,
        occurrences: 1,
        snippet: basic.text,
        sentiment: null,
        sentimentScore: null,
        sentimentByAnalyzer: [],
        agreement: null,
      },
    ],
  });
});

test("analyzer order, explicit primary, tie agreement, and empty metering", async () => {
  const payload = { ...basic, text: "Acme is a top pick, but Acme is bad." };
  const answer = await post({
    ...payload,
    sentiment: { language: "en-GB", analyzers: [lex, rules] },
  });
  expect(answer).toMatchObject({
    language: "en-GB",
    languageSource: "given",
    primaryFallback: false,
    usage: [],
    analyzers: [
      { analyzer: lex, primary: true },
      { analyzer: rules, primary: false },
    ],
    mentions: [
      {
        brandKey: "acme",
        position: 1,
        occurrences: 2,
        snippet: payload.text,
        sentiment: "negative",
        sentimentScore: -0.5,
        sentimentByAnalyzer: [
          { analyzer: lex, status: "ok", label: "negative", score: -0.5, rationale: "bad (-0.5)" },
          {
            analyzer: rules,
            status: "ok",
            label: "positive",
            score: 0.75,
            rationale: "is a top pick (+0.75)",
          },
        ],
        agreement: {
          analyzerCount: 2,
          majorityLabel: null,
          agreeingCount: 1,
          unanimous: false,
          scoreSpread: 1.25,
        },
      },
    ],
  });
  const explicit = await post({
    ...payload,
    sentiment: { analyzers: [lex, rules], primary: rules },
  });
  expect(explicit.analyzers).toMatchObject([
    { analyzer: lex, primary: false },
    { analyzer: rules, primary: true },
  ]);
  expect(explicit.mentions[0]).toMatchObject({ sentiment: "positive", sentimentScore: 0.75 });
  const reversed = await post({ ...payload, sentiment: { analyzers: [rules, lex] } });
  expect(reversed.analyzers).toMatchObject([
    { analyzer: rules, primary: true },
    { analyzer: lex, primary: false },
  ]);
  expect(reversed.mentions[0].sentimentByAnalyzer).toMatchObject([
    { analyzer: rules },
    { analyzer: lex },
  ]);
  expect(reversed.mentions[0]).toMatchObject({ sentiment: "positive", sentimentScore: 0.75 });
  expect(reversed.mentions[0].agreement).toEqual(answer.mentions[0].agreement);
});

test("two neutral results are unanimous and no mentioned brands produce an empty list", async () => {
  const sentiment = { language: "en", analyzers: [lex, rules] };
  const result = await post({ ...basic, text: "Acme", sentiment });
  expect(result.mentions[0].agreement).toEqual({
    analyzerCount: 2,
    majorityLabel: "neutral",
    agreeingCount: 2,
    unanimous: true,
    scoreSpread: 0,
  });
  expect((await post({ ...basic, text: "Beta", sentiment })).mentions).toEqual([]);
});

test.each(["Acme", "Acme is good. Beta funciona muy bien.", "Acme is good 你好."])(
  "conservative omitted-language detection leaves %s undetermined",
  async (text) => {
    const answer = await post({ text, brands: [brand, beta] });
    expect(answer).toMatchObject({
      language: null,
      languageSource: "undetermined",
      primaryFallback: false,
      analyzers: [{ analyzer: lex, status: "unsupported", primary: false }],
    });
    expect(answer.mentions[0]).toMatchObject({
      brandKey: "acme",
      sentiment: null,
      sentimentScore: null,
      agreement: null,
      sentimentByAnalyzer: [{ analyzer: lex, status: "unsupported", label: null, score: null }],
    });
  },
);

test("given unsupported language keeps mentions and does not report a nonexistent fallback", async () => {
  const result = await post({
    ...basic,
    sentiment: { language: "fr", analyzers: [rules, lex], primary: rules },
  });
  expect(result).toMatchObject({
    language: "fr",
    languageSource: "given",
    primaryFallback: false,
    analyzers: [
      { analyzer: rules, status: "unsupported", primary: false },
      { analyzer: lex, status: "unsupported", primary: false },
    ],
    mentions: [{ brandKey: "acme", sentiment: null, sentimentScore: null, agreement: null }],
  });
  const disabled = await post({
    ...basic,
    sentiment: { language: "fr", analyzers: [], onUnsupportedLanguage: "error" },
  });
  expect(disabled).toMatchObject({ language: "fr", languageSource: "given", analyzers: [] });
});

test("transport and schema errors precede semantic issues", async () => {
  expect((await post("{", 400)).code).toBe("validation_failed");
  const result = await post(
    { ...basic, brands: [brand, brand], sentiment: { analyzers: [lex, lex] } },
    400,
  );
  expect(result.code).toBe("validation_failed");
  expect(result.errors).toEqual(
    expect.arrayContaining([expect.objectContaining({ pointer: "/sentiment/analyzers" })]),
  );
  expect((await post({ ...basic, sentiment: { analyzers: ["invalid"] } }, 400)).code).toBe(
    "validation_failed",
  );
});

test("422s use the approved precedence and first offending field", async () => {
  const sentiment = {
    language: "fr",
    onUnsupportedLanguage: "error",
    analyzers: [lex, "llm:openai/model", "det:fake"],
    primary: rules,
  };
  expect(await post({ ...basic, brands: [brand, brand, brand], sentiment }, 422)).toMatchObject({
    code: "duplicate_brand_key",
    detail: expect.stringContaining("/brands/1/key"),
  });
  expect(await post({ ...basic, sentiment }, 422)).toMatchObject({
    code: "invalid_primary",
    detail: expect.stringContaining("/sentiment/primary"),
  });
  expect(await post({ ...basic, sentiment: { ...sentiment, primary: lex } }, 422)).toMatchObject({
    code: "unsupported_analyzer",
    detail: expect.stringMatching(/^\/sentiment\/analyzers\/1: llm:openai\/model/),
  });
  expect(
    await post({ ...basic, sentiment: { ...sentiment, analyzers: [lex, rules] } }, 422),
  ).toMatchObject({
    code: "unsupported_language",
    detail: expect.stringMatching(/^\/sentiment\/analyzers\/0: det:lexicon .*fr.*en$/),
  });
  expect(
    await post({ ...basic, text: "Acme", sentiment: { onUnsupportedLanguage: "error" } }, 422),
  ).toMatchObject({
    code: "unsupported_language",
    detail: expect.stringContaining("undetermined"),
  });
});

test("comparative rules assign opposite verdicts to the two mentioned brands", async () => {
  const text = "Acme is better than Beta.";
  const result = await post({
    text,
    brands: [brand, beta],
    sentiment: { language: "en", analyzers: [rules] },
  });
  expect(result.mentions).toMatchObject([
    {
      brandKey: "acme",
      position: 1,
      occurrences: 1,
      snippet: text,
      sentiment: "positive",
      sentimentScore: 0.75,
      sentimentByAnalyzer: [{ rationale: "better than Beta (+0.75)" }],
    },
    {
      brandKey: "beta",
      position: 2,
      occurrences: 1,
      snippet: text,
      sentiment: "negative",
      sentimentScore: -0.75,
      sentimentByAnalyzer: [{ rationale: "Acme is better than Beta (-0.75)" }],
    },
  ]);
});

test.each([
  ["I recommend Acme's competitors.", [brand]],
  ["Avoid Acme’s competitor.", [brand]],
  ["Acme is better than Beta’s alternative.", [brand, beta]],
  ["Acme's alternative is better than Beta.", [brand, beta]],
  ["Avoid Acmes’ competitor.", [{ ...brand, name: "Acmes" }]],
  ["Avoid Acmes' competitor.", [{ ...brand, name: "Acmes" }]],
  ["‘Avoid Acmes’ competitor.’", [{ ...brand, name: "Acmes" }]],
  ["'Avoid Acmes' competitor.'", [{ ...brand, name: "Acmes" }]],
])("rules leave possessive references neutral in %s", async (text, brands) => {
  const result = await post({ text, brands, sentiment: { language: "en", analyzers: [rules] } });
  expect(result.mentions).toMatchObject(
    brands.map(({ key }, index) => ({
      brandKey: key,
      position: index + 1,
      occurrences: 1,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      sentimentByAnalyzer: [
        { analyzer: rules, status: "ok", label: "neutral", score: 0, rationale: "No rule cues" },
      ],
    })),
  );
});

test.each(["Acme", "Acme's", "O’Reilly"])(
  "rules attribute avoidance to the full name %s",
  async (name) => {
    const text = "Avoid " + name + ".";
    const result = await post({
      text,
      brands: [{ ...brand, name, aliases: ["Acme"] }],
      sentiment: { language: "en", analyzers: [rules] },
    });
    expect(result.mentions).toMatchObject([
      {
        brandKey: "acme",
        position: 1,
        occurrences: 1,
        snippet: text,
        sentiment: "negative",
        sentimentScore: -0.75,
        sentimentByAnalyzer: [
          {
            analyzer: rules,
            status: "ok",
            label: "negative",
            score: -0.75,
            rationale: "Avoid " + name + " (-0.75)",
          },
        ],
      },
    ]);
  },
);

test.each(["‘Avoid Acmes’.", "'Avoid Acmes'."])(
  "rules attribute avoidance inside single quotes in %s",
  async (text) => {
    const result = await post({
      text,
      brands: [{ ...brand, name: "Acmes" }],
      sentiment: { language: "en", analyzers: [rules] },
    });
    expect(result.mentions).toMatchObject([
      {
        brandKey: "acme",
        position: 1,
        occurrences: 1,
        snippet: text,
        sentiment: "negative",
        sentimentScore: -0.75,
        sentimentByAnalyzer: [
          {
            analyzer: rules,
            status: "ok",
            label: "negative",
            score: -0.75,
            rationale: "Avoid Acmes (-0.75)",
          },
        ],
      },
    ]);
  },
);
