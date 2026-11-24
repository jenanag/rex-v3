import { expect, test, vi } from "vitest";
import type { components } from "../contract/types.js";
import { loadConfig } from "../src/config.js";
import { findMentionOccurrences } from "../src/domain/mentions.js";
import { createHandlers } from "../src/handlers/index.js";
import { createLlm, fixtureKey } from "../src/llm/adapter.js";
import { buildGeminiBatch, gemini } from "../src/llm/gemini.js";
import { luna } from "../src/llm/luna.js";
import { checkResponse, postAnalysis as post, tool } from "./support.js";

const model = "gemini-2.5-flash-lite";
const lexicon = "det:lexicon";
const text = "Acme is better than Beta.";
const acme = { key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] } as const;
const brands: components["schemas"]["TrackedBrand"][] = [
  { ...acme, aliases: [], domains: [] },
  { key: "beta", kind: "competitor", name: "Beta", aliases: [], domains: [] },
];
const input = { text, brands, sentiment: { language: "en", analyzers: [lexicon, gemini.id] } };
const rows = [
  { brandKey: "b02", label: "negative", score: -0.7201, rationale: null },
  { brandKey: "b01", label: "positive", score: 0.7201, rationale: "Described as better." },
];
const json = (results: typeof rows = rows) => JSON.stringify({ results });
const usageMetadata = {
  promptTokenCount: 1_001,
  cachedContentTokenCount: 400,
  candidatesTokenCount: 180,
  totalTokenCount: 1_181,
  serviceTier: "standard",
};
const metered = {
  provider: "google",
  model,
  operation: "classify_sentiment",
  inputTokens: 1_001,
  outputTokens: 180,
  costMicrosUsd: 136,
};
const recordedLunaUsage = {
  provider: "openai",
  model: "gpt-6-luna",
  operation: "classify_sentiment",
  inputTokens: 261,
  outputTokens: 74,
  costMicrosUsd: 63,
};
const candidate = (content = json(), finishReason = "STOP") => ({
  finishReason,
  content: { role: "model", parts: [{ text: content }] },
});
const ok = { modelVersion: model, candidates: [candidate()], usageMetadata };

function stub(reply: (request: Request) => Response | Promise<Response> = () => Response.json(ok)) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) =>
    reply(new Request(input, init)),
  );
  const llm = createLlm({
    data: { LLM_MODE: "live", GEMINI_API_KEY: "synthetic-test-key" },
    fetch,
  });
  return { fetch, llm, handlers: createHandlers({ lunaEnabled: false, geminiEnabled: true, llm }) };
}

test.each([
  [undefined, false],
  ["true", true],
  ["false", false],
])("Gemini flag %s controls discovery and query eligibility", async (value, enabled) => {
  const config = loadConfig(value === undefined ? {} : { ANSWER_ANALYSIS_GEMINI_ENABLED: value });
  expect(config.ANSWER_ANALYSIS_GEMINI_ENABLED).toBe(enabled);
  const { fetch, llm } = stub();
  const handlers = createHandlers({
    lunaEnabled: true,
    geminiEnabled: config.ANSWER_ANALYSIS_GEMINI_ENABLED,
    llm,
  });
  const app = tool({}, handlers);
  try {
    const result = await app.inject({ method: "GET", url: "/v1/analyzers" });
    expect(result.statusCode).toBe(200);
    const payload = result.json();
    checkResponse("GET", "/v1/analyzers", 200, "application/json", payload);
    expect(payload.data.map(({ id }: { id: string }) => id)).toEqual([
      lexicon,
      "det:rules",
      luna.id,
      ...(enabled ? [gemini.id] : []),
    ]);
    if (enabled)
      expect(payload.data.at(-1)).toMatchObject({ id: gemini.id, kind: "llm", languages: ["*"] });
  } finally {
    await app.close();
  }
  const { data } = await post(handlers, input, enabled ? 200 : 422);
  expect(data).toMatchObject(enabled ? { usage: [metered] } : { code: "unsupported_analyzer" });
  expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
});

test("invalid flag fails at startup", async () => {
  vi.stubEnv("ANSWER_ANALYSIS_GEMINI_ENABLED", "enabled");
  try {
    await expect(import("../src/server.js")).rejects.toThrow(/ANSWER_ANALYSIS_GEMINI_ENABLED/);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("the pinned Gemini SDK sends text-only structured output settings and bounded evidence", async () => {
  let wire = "";
  const provider = stub(async (request) => {
    wire = await request.text();
    expect(request.url).toBe(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    );
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(request.headers.get("X-Server-Timeout")).toBe("60");
    expect(request.signal.aborted).toBe(false);
    return Response.json(ok);
  });
  const { data } = await post(provider.handlers, input);
  const planned = buildGeminiBatch(text, "en", findMentionOccurrences(text, brands));
  expect(JSON.parse(wire)).toEqual(planned.request.geminiGenerate!.body);
  const body = JSON.parse(wire);
  expect(Object.keys(body).sort()).toEqual([
    "contents",
    "generationConfig",
    "serviceTier",
    "systemInstruction",
  ]);
  expect(body.serviceTier).toBe("standard");
  expect(body.generationConfig).toEqual({
    maxOutputTokens: 12_288,
    thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
    responseMimeType: "application/json",
    responseJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["results"],
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["brandKey", "label", "score", "rationale"],
            properties: {
              brandKey: { type: "string" },
              label: { type: "string", enum: ["positive", "negative", "neutral"] },
              score: { type: "number", minimum: -1, maximum: 1 },
              rationale: { type: ["string", "null"] },
            },
          },
        },
      },
    },
  });
  expect(body.systemInstruction.parts[0].text).toMatch(/evidence only/);
  expect(JSON.parse(body.contents[0].parts[0].text)).toEqual({
    language: "en",
    brands: [
      { brandKey: "b01", excerpts: [{ text, start: 0, end: 4 }] },
      { brandKey: "b02", excerpts: [{ text, start: 20, end: 24 }] },
    ],
  });
  expect(data.usage).toEqual([metered]);
  expect(
    data.mentions.map(
      (mention: { sentimentByAnalyzer: unknown[] }) => mention.sentimentByAnalyzer[1],
    ),
  ).toMatchObject([
    { analyzer: gemini.id, label: "positive", score: 0.72 },
    { analyzer: gemini.id, label: "negative", score: -0.72 },
  ]);
  expect(provider.fetch).toHaveBeenCalledOnce();
  const alternate = {
    ...planned.request,
    geminiGenerate: {
      ...planned.request.geminiGenerate!,
      promptVersion: "changed",
    },
  };
  expect(fixtureKey(alternate)).not.toBe(fixtureKey(planned.request));
});

test("recorded Luna plus synthetic Gemini and the lexicon agree on deterministic mentions", async () => {
  const provider = stub();
  const noLiveFetch = vi.fn(async () => {
    throw new Error("Unexpected Luna traffic");
  });
  const replay = createLlm({ data: { LLM_MODE: "mock" }, fetch: noLiveFetch });
  const lunaStarted = Promise.withResolvers<void>();
  let lunaFinished = false;
  const llm = vi.fn<typeof replay>(async (request) => {
    if (request.provider === "google") {
      await lunaStarted.promise;
      const result = await provider.llm(request);
      expect(lunaFinished).toBe(true);
      return result;
    }
    const result = await replay(request);
    lunaFinished = true;
    lunaStarted.resolve();
    return result;
  });
  const analyzers = [lexicon, gemini.id, luna.id];
  const { data } = await post(createHandlers({ lunaEnabled: true, geminiEnabled: true, llm }), {
    ...input,
    sentiment: { ...input.sentiment, analyzers },
  });
  expect(llm.mock.calls.map(([request]) => request.provider)).toEqual(["google", "openai"]);
  expect(data.usage).toEqual([metered, recordedLunaUsage]);
  expect(
    data.analyzers.map(
      ({ analyzer, status, primary }: { analyzer: string; status: string; primary: boolean }) => [
        analyzer,
        status,
        primary,
      ],
    ),
  ).toEqual([
    [lexicon, "ok", true],
    [gemini.id, "ok", false],
    [luna.id, "ok", false],
  ]);
  for (const [i, label, sign] of [
    [0, "positive", 1],
    [1, "negative", -1],
  ] as const) {
    expect(data.mentions[i]).toMatchObject({
      brandKey: brands[i].key,
      position: i + 1,
      occurrences: 1,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      sentimentByAnalyzer: [
        { analyzer: lexicon, label: "neutral", score: 0 },
        { analyzer: gemini.id, label, score: sign * 0.72 },
        { analyzer: luna.id, label, score: sign * 0.7 },
      ],
      agreement: {
        analyzerCount: 3,
        majorityLabel: label,
        agreeingCount: 2,
        unanimous: false,
        scoreSpread: 0.72,
      },
    });
  }
  expect(provider.fetch).toHaveBeenCalledOnce();
  expect(noLiveFetch).not.toHaveBeenCalled();
});

test("French fallback promotes Gemini and strict language policy makes no provider call", async () => {
  const provider = stub();
  const french = {
    ...input,
    text: "Acme est meilleur que Beta.",
    sentiment: {
      ...input.sentiment,
      primary: lexicon,
      language: "fr",
      onUnsupportedLanguage: "fallback",
    },
  };
  const { data: failure } = await post(
    provider.handlers,
    {
      ...french,
      sentiment: { ...french.sentiment, onUnsupportedLanguage: "error" },
    },
    422,
  );
  expect(failure).toMatchObject({
    code: "unsupported_language",
    detail: expect.stringContaining("/sentiment/analyzers/0"),
  });
  expect(provider.fetch).not.toHaveBeenCalled();
  const { data } = await post(provider.handlers, french);
  expect(data).toMatchObject({
    language: "fr",
    primaryFallback: true,
    analyzers: [
      { analyzer: lexicon, status: "unsupported", primary: false },
      { analyzer: gemini.id, status: "ok", primary: true },
    ],
    mentions: [
      { brandKey: "acme", sentiment: "positive", agreement: null },
      { brandKey: "beta", sentiment: "negative", agreement: null },
    ],
    usage: [metered],
  });
  expect(provider.fetch).toHaveBeenCalledOnce();
});

test("no mentions means neither selected provider is called", async () => {
  const provider = stub();
  const { data } = await post(
    createHandlers({ geminiEnabled: true, lunaEnabled: true, llm: provider.llm }),
    {
      ...input,
      text: "No tracked brands.",
      sentiment: { ...input.sentiment, analyzers: [gemini.id, luna.id] },
    },
  );
  expect(data).toMatchObject({ mentions: [], usage: [] });
  expect(provider.fetch).not.toHaveBeenCalled();
});

test("all 50 brands fit on the wire under worst-case JSON escaping", async () => {
  const tracked = Array.from({ length: 50 }, (_, i) => ({
    ...brands[0],
    key: "brand-" + i,
    name: "Target" + String(i).padStart(2, "0"),
  }));
  const escaped = "\u0001".repeat(180);
  const pass = tracked.map(({ name }) => escaped + name + escaped).join("");
  const answer = (pass.repeat(3) + escaped.repeat(1200)).slice(0, 200_000);
  let wire = "";
  const provider = stub(async (request) => {
    wire = await request.text();
    const verdicts = tracked.map((_, i) => ({
      ...rows[1],
      brandKey: "b" + String(i + 1).padStart(2, "0"),
    }));
    return Response.json({ ...ok, candidates: [candidate(json(verdicts))] });
  });
  const { data } = await post(provider.handlers, { ...input, text: answer, brands: tracked });
  expect(data.mentions).toHaveLength(50);
  expect(provider.fetch).toHaveBeenCalledOnce();
  expect(Buffer.byteLength(wire, "utf8")).toBeGreaterThan(50_000);
  expect(Buffer.byteLength(wire, "utf8")).toBeLessThanOrEqual(65_536);
  const evidence = JSON.parse(JSON.parse(wire).contents[0].parts[0].text);
  expect(evidence.brands).toHaveLength(50);
  for (const [i, row] of evidence.brands.entries()) {
    expect(row.excerpts.length).toBeGreaterThanOrEqual(1);
    expect(row.excerpts.length).toBeLessThanOrEqual(3);
    for (const { text, start, end } of row.excerpts) {
      const chars = Array.from(text);
      expect(chars).toHaveLength(160);
      expect(chars.slice(start, end).join("")).toBe(tracked[i].name);
    }
  }
});

test.each([
  ["missing row", json([rows[0]])],
  ["duplicate ID", json([rows[0], rows[0]])],
  ["unexpected ID", json([rows[0], { ...rows[1], brandKey: "b03" }])],
  ["unknown label", json([rows[0], { ...rows[1], label: "mixed" }])],
  ["inconsistent label", json([rows[0], { ...rows[1], score: 0.2501 }])],
  ["out-of-range score", json([rows[0], { ...rows[1], score: 1.1 }])],
  ["oversized rationale", json([rows[0], { ...rows[1], rationale: "😀".repeat(121) }])],
  ["oversized reply", json() + " ".repeat(48 * 1024)],
  ["unstructured refusal", "I cannot answer."],
])(
  "invalid Gemini %s fails the whole secondary batch and retains valid usage",
  async (_name, reply) => {
    const provider = stub(() => Response.json({ ...ok, candidates: [candidate(reply)] }));
    const { data } = await post(provider.handlers, input);
    expect(data.analyzers[1]).toMatchObject({
      analyzer: gemini.id,
      status: "failed",
      primary: false,
    });
    for (const mention of data.mentions) {
      expect(mention.agreement).toBeNull();
      expect(mention.sentimentByAnalyzer[1]).toMatchObject({
        status: "failed",
        score: null,
        label: null,
      });
    }
    expect(data.usage).toEqual([metered]);
    expect(provider.fetch).toHaveBeenCalledOnce();
  },
);

test.each([
  { promptFeedback: { blockReason: "SAFETY" } },
  { candidates: [] },
  { candidates: [candidate(), candidate()] },
  { candidates: [candidate(" ", "STOP")] },
  { candidates: [candidate(json(), "MAX_TOKENS")] },
  { candidates: [candidate(json(), "SAFETY")] },
  { candidates: [{ ...candidate(), safetyRatings: [{ blocked: true }] }] },
])("unusable Gemini completion %j fails a primary and meters valid usage", async (changes) => {
  const provider = stub(() => Response.json({ ...ok, ...changes }));
  const report = vi.fn();
  const handlers = createHandlers({
    lunaEnabled: false,
    geminiEnabled: true,
    llm: provider.llm,
    reportFailedPrimaryUsage: report,
  });
  const { data } = await post(
    handlers,
    {
      ...input,
      sentiment: { ...input.sentiment, primary: gemini.id },
    },
    503,
  );
  expect(data).toMatchObject({ code: "provider_unavailable" });
  expect(data).not.toHaveProperty("usage");
  expect(report).toHaveBeenCalledExactlyOnceWith(expect.anything(), metered);
  expect(provider.fetch).toHaveBeenCalledOnce();
});

test("a failed Gemini primary retains both billed batches in telemetry", async () => {
  const provider = stub(() =>
    Response.json({ ...ok, candidates: [candidate(json(), "MAX_TOKENS")] }),
  );
  const replay = createLlm({ data: { LLM_MODE: "mock" } });
  const report = vi.fn();
  const handlers = createHandlers({
    lunaEnabled: true,
    geminiEnabled: true,
    llm: (request) => (request.provider === "google" ? provider.llm(request) : replay(request)),
    reportFailedPrimaryUsage: report,
  });
  const { data } = await post(
    handlers,
    {
      ...input,
      sentiment: { ...input.sentiment, analyzers: [luna.id, gemini.id], primary: gemini.id },
    },
    503,
  );
  expect(data).toMatchObject({ code: "provider_unavailable" });
  expect(data).not.toHaveProperty("usage");
  expect(report.mock.calls.map(([, usage]) => usage)).toEqual([recordedLunaUsage, metered]);
  expect(provider.fetch).toHaveBeenCalledOnce();
});

test("Gemini rejects an unexpected model without attributing it to the approved price", async () => {
  const provider = stub(() => Response.json({ ...ok, modelVersion: "unexpected-model" }));
  const { data } = await post(provider.handlers, input);
  expect(data.analyzers[1].status).toBe("failed");
  expect(data.usage).toEqual([]);
  expect(provider.fetch).toHaveBeenCalledOnce();
});

test.each([
  undefined,
  { ...usageMetadata, candidatesTokenCount: undefined },
  { ...usageMetadata, totalTokenCount: 0 },
  { ...usageMetadata, cachedContentTokenCount: 1002 },
  { ...usageMetadata, thoughtsTokenCount: -1 },
  { ...usageMetadata, candidatesTokenCount: 0.5 },
  { ...usageMetadata, promptTokenCount: 2 ** 53 },
  { ...usageMetadata, toolUsePromptTokenCount: 1, totalTokenCount: 1182 },
  { ...usageMetadata, serviceTier: "flex" },
  { ...usageMetadata, serviceTier: "priority" },
])(
  "invalid Gemini metering %j yields a failed secondary without priced usage",
  async (metadata) => {
    const provider = stub(() => Response.json({ ...ok, usageMetadata: metadata }));
    const { data } = await post(provider.handlers, input);
    expect(data.analyzers[1].status).toBe("failed");
    expect(data.usage).toEqual([]);
    expect(provider.fetch).toHaveBeenCalledOnce();
  },
);

test.each([
  [{ ...usageMetadata, thoughtsTokenCount: 21, totalTokenCount: 1202 }, 201, 145],
  [{ promptTokenCount: 1001, candidatesTokenCount: 180, totalTokenCount: 1181 }, 180, 172],
  [{ ...usageMetadata, serviceTier: "unspecified" }, 180, 136],
])("Gemini prices reconciled counts %j", async (metadata, outputTokens, costMicrosUsd) => {
  const provider = stub(() => Response.json({ ...ok, usageMetadata: metadata }));
  const { data } = await post(provider.handlers, input);
  expect(data.usage).toEqual([{ ...metered, outputTokens, costMicrosUsd }]);
});

test.each([
  ["7", "7"],
  ["Sun, 06 Nov 1994 08:49:37 GMT", "Sun, 06 Nov 1994 08:49:37 GMT"],
  ["Tue, 31 Nov 2026 08:00:00 GMT", undefined],
])("Gemini preserves valid Retry-After %s on one attempt", async (header, expected) => {
  const provider = stub(() =>
    Response.json(
      { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "busy" } },
      { status: 429, headers: { "Retry-After": header } },
    ),
  );
  const { data, retryAfter } = await post(
    provider.handlers,
    {
      ...input,
      sentiment: { ...input.sentiment, primary: gemini.id },
    },
    503,
  );
  expect(data).toMatchObject({ code: "provider_unavailable" });
  expect(retryAfter).toBe(expected);
  expect(provider.fetch).toHaveBeenCalledOnce();
});

test("Gemini propagates the 60-second deadline and aborts without retry", async () => {
  const controller = new AbortController();
  const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const aborted = vi.fn();
  const provider = stub(
    (request) =>
      new Promise((_resolve, reject) => {
        const { signal } = request;
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(signal.reason);
          },
          { once: true },
        );
        controller.abort(new DOMException("Synthetic deadline", "TimeoutError"));
      }),
  );
  try {
    const { data } = await post(provider.handlers, input);
    expect(data.analyzers[1].status).toBe("failed");
    expect(data.usage).toEqual([]);
    expect(deadline).toHaveBeenCalledWith(60_000);
    expect(aborted).toHaveBeenCalledOnce();
    expect(provider.fetch).toHaveBeenCalledOnce();
  } finally {
    deadline.mockRestore();
  }
});
