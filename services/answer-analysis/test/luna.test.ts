import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type { components } from "../contract/types.js";
import { loadConfig } from "../src/config.js";
import { findMentionOccurrences } from "../src/domain/mentions.js";
import { createHandlers } from "../src/handlers/index.js";
import { createLlm, fixtureKey } from "../src/llm/adapter.js";
import { buildLunaBatch, luna } from "../src/llm/luna.js";
import { checkResponse, postAnalysis as post, tool } from "./support.js";

type Brand = components["schemas"]["TrackedBrand"];
const model = luna.id;
const lexicon = "det:lexicon";
const rules = "det:rules";
const brand: Brand = { key: "acme", kind: "primary", name: "Acme", aliases: [], domains: [] };
const beta: Brand = { ...brand, key: "beta", kind: "competitor", name: "Beta" };
const text = "Acme is better than Beta.";
const brands = [brand, beta];
const rows = [
  { brandKey: "b02", label: "negative", score: -0.5001, rationale: null },
  { brandKey: "b01", label: "positive", score: 0.6001, rationale: "Acme is favored." },
];
const validUsage = {
  prompt_tokens: 1000,
  completion_tokens: 200,
  total_tokens: 1200,
  prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
};
const metered = {
  provider: "openai",
  model: "gpt-6-luna",
  operation: "classify_sentiment",
  inputTokens: 1000,
  outputTokens: 200,
  costMicrosUsd: 167,
};

function completion(
  content = JSON.stringify({ results: rows }),
  {
    usage = validUsage as unknown,
    finish = "stop",
    refusal = null as string | null,
    serviceTier = "default",
  } = {},
) {
  return Response.json({
    choices: [{ finish_reason: finish, message: { content, refusal } }],
    usage,
    service_tier: serviceTier,
  });
}

function stub(reply: () => Response | Promise<Response>) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => reply());
  return {
    fetch,
    llm: createLlm({ data: { LLM_MODE: "live", OPENAI_API_KEY: "synthetic-test-key" }, fetch }),
  };
}

test.each([
  [undefined, false],
  ["true", true],
  ["false", false],
])("startup flag %s drives discovery and request eligibility", async (value, lunaEnabled) => {
  const config = loadConfig(value === undefined ? {} : { ANSWER_ANALYSIS_LUNA_ENABLED: value });
  expect(config.ANSWER_ANALYSIS_LUNA_ENABLED).toBe(lunaEnabled);
  const provider = stub(() => completion());
  const handlers = createHandlers({
    lunaEnabled: config.ANSWER_ANALYSIS_LUNA_ENABLED,
    llm: provider.llm,
  });
  const app = tool({}, handlers);
  try {
    const reply = await app.inject({ method: "GET", url: "/v1/analyzers" });
    expect(reply.statusCode).toBe(200);
    checkResponse("GET", "/v1/analyzers", 200, "application/json", reply.json());
    expect(reply.json().data.map(({ id }: { id: string }) => id)).toEqual(
      lunaEnabled ? [lexicon, rules, model] : [lexicon, rules],
    );
    if (lunaEnabled)
      expect(reply.json().data.at(-1)).toMatchObject({
        id: model,
        kind: "llm",
        languages: ["*"],
      });
  } finally {
    await app.close();
  }
  const { data } = await post(handlers, { text, brands }, 200);
  expect(data.analyzers).toMatchObject([{ analyzer: lexicon, primary: true }]);
  expect(data.usage).toEqual([]);
  const requested = await post(
    handlers,
    { text, brands, sentiment: { analyzers: [model] } },
    lunaEnabled ? 200 : 422,
  );
  expect(requested.data).toMatchObject(
    lunaEnabled ? { usage: [metered] } : { code: "unsupported_analyzer" },
  );
  expect(provider.fetch).toHaveBeenCalledTimes(lunaEnabled ? 1 : 0);
});

test("authorized Luna recording replays offline and preserves mention and analyzer ordering", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error("Recorded fixture replay must stay offline");
  });
  const replay = createLlm({ data: { LLM_MODE: "mock" }, fetch });
  const llm = vi.fn(replay);
  const handlers = createHandlers({ lunaEnabled: true, llm });
  const { data } = await post(handlers, {
    text,
    brands,
    sentiment: { language: "en", analyzers: [model, lexicon, rules] },
  });
  expect(llm).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(data.analyzers).toMatchObject([
    { analyzer: model, kind: "llm", status: "ok", primary: false },
    { analyzer: lexicon, status: "ok", primary: true },
    { analyzer: rules, status: "ok", primary: false },
  ]);
  expect(data.mentions).toMatchObject([
    {
      brandKey: "acme",
      position: 1,
      occurrences: 1,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      sentimentByAnalyzer: [
        { analyzer: model, label: "positive", score: 0.7 },
        { analyzer: lexicon, score: 0 },
        { analyzer: rules, score: 0.75 },
      ],
      agreement: {
        analyzerCount: 3,
        majorityLabel: "positive",
        agreeingCount: 2,
        unanimous: false,
        scoreSpread: 0.75,
      },
    },
    {
      brandKey: "beta",
      position: 2,
      occurrences: 1,
      snippet: text,
      sentiment: "neutral",
      sentimentScore: 0,
      sentimentByAnalyzer: [
        { analyzer: model, label: "negative", score: -0.7 },
        { analyzer: lexicon, score: 0 },
        { analyzer: rules, score: -0.75 },
      ],
      agreement: {
        analyzerCount: 3,
        majorityLabel: "negative",
        agreeingCount: 2,
        unanimous: false,
        scoreSpread: 0.75,
      },
    },
  ]);
  expect(data.usage).toEqual([
    { ...metered, inputTokens: 261, outputTokens: 74, costMicrosUsd: 63 },
  ]);
  const request = llm.mock.calls[0][0];
  expect(request.timeoutMs).toBe(60_000);
  const chat = request.openAiChat!;
  expect(fixtureKey({ ...request, openAiChat: { ...chat, promptVersion: "different" } })).not.toBe(
    fixtureKey(request),
  );
  expect(
    fixtureKey({
      ...request,
      openAiChat: { ...chat, body: { ...chat.body, max_completion_tokens: 1 } },
    }),
  ).not.toBe(fixtureKey(request));
  expect(
    fixtureKey({
      ...request,
      openAiChat: { ...chat, body: { ...chat.body, response_format: { type: "json_object" } } },
    }),
  ).not.toBe(fixtureKey(request));
});

test("wildcard includes undetermined language and strict language validation runs before any provider call", async () => {
  const provider = stub(() => completion(JSON.stringify({ results: [rows[1]] })));
  const handlers = createHandlers({ lunaEnabled: true, llm: provider.llm });
  const input = { text: "Acme.", brands, sentiment: { analyzers: [lexicon, model] } };
  const { data: rejected } = await post(
    handlers,
    { ...input, sentiment: { ...input.sentiment, onUnsupportedLanguage: "error" } },
    422,
  );
  expect(rejected.code).toBe("unsupported_language");
  const { data: empty } = await post(handlers, { ...input, text: "No targets here." });
  expect(empty.mentions).toEqual([]);
  expect(empty.usage).toEqual([]);
  expect(provider.fetch).not.toHaveBeenCalled();
  const { data } = await post(handlers, input);
  expect(data).toMatchObject({
    language: null,
    languageSource: "undetermined",
    primaryFallback: false,
    analyzers: [
      { analyzer: lexicon, status: "unsupported", primary: false },
      { analyzer: model, status: "ok", primary: true },
    ],
    mentions: [{ sentiment: "positive", sentimentScore: 0.6, agreement: null }],
  });
  const promoted = await post(handlers, {
    ...input,
    sentiment: { ...input.sentiment, primary: lexicon },
  });
  expect(promoted.data.primaryFallback).toBe(true);
  const explicit = await post(handlers, {
    ...input,
    sentiment: { ...input.sentiment, primary: model, language: "en" },
  });
  expect(explicit.data).toMatchObject({
    primaryFallback: false,
    mentions: [{ sentiment: "positive", sentimentScore: 0.6 }],
  });
  expect(provider.fetch).toHaveBeenCalledTimes(3);
});

test("actual SDK request fits 64 KiB with all 50 brands and worst-case JSON escaping", async () => {
  const tracked = Array.from({ length: 50 }, (_, i) => ({
    ...brand,
    key: "brand-" + i,
    name: "Target" + String(i).padStart(2, "0"),
  }));
  const escaped = "\u0001".repeat(180);
  const pass = tracked.map(({ name }) => escaped + name + escaped).join("");
  const answer = (pass.repeat(3) + escaped.repeat(1200)).slice(0, 200_000);
  const provider = stub(() =>
    completion(
      JSON.stringify({
        results: tracked.map((_, i) => ({
          ...rows[1],
          brandKey: "b" + String(i + 1).padStart(2, "0"),
        })),
      }),
    ),
  );
  const { data } = await post(createHandlers({ lunaEnabled: true, llm: provider.llm }), {
    text: answer,
    brands: tracked,
    sentiment: { language: "en", analyzers: [model] },
  });
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  const [url, init] = provider.fetch.mock.calls[0];
  expect(String(url)).toMatch(/\/chat\/completions$/);
  const wire = init?.body;
  expect(typeof wire).toBe("string");
  const planned = buildLunaBatch(answer, "en", findMentionOccurrences(answer, tracked));
  expect(wire).toBe(JSON.stringify(planned.request.openAiChat!.body));
  expect(Buffer.byteLength(wire as string, "utf8")).toBeLessThanOrEqual(65_536);
  expect(Buffer.byteLength(wire as string, "utf8")).toBeGreaterThan(50_000);
  const request = JSON.parse(wire as string);
  expect(request).toMatchObject({
    model: "gpt-6-luna",
    reasoning_effort: "none",
    service_tier: "default",
    store: false,
    max_completion_tokens: 12_288,
    response_format: { type: "json_schema", json_schema: { strict: true } },
    messages: [{ role: "developer" }, { role: "user" }],
  });
  const evidence = JSON.parse(request.messages[1].content).brands as {
    brandKey: string;
    excerpts: { text: string; start: number; end: number }[];
  }[];
  expect(evidence).toHaveLength(50);
  for (const [index, { excerpts }] of evidence.entries()) {
    expect(excerpts.length).toBeGreaterThanOrEqual(1);
    expect(excerpts.length).toBeLessThanOrEqual(3);
    for (const excerpt of excerpts) {
      const chars = Array.from(excerpt.text);
      expect(chars).toHaveLength(160);
      expect(chars.slice(excerpt.start, excerpt.end).join("")).toBe(tracked[index].name);
    }
  }
  expect(data.mentions).toHaveLength(50);
  expect(data.mentions.every(({ occurrences }: { occurrences: number }) => occurrences === 3)).toBe(
    true,
  );
});

test("oversized span is clipped, with in-excerpt offsets and the same brand ID", () => {
  const text = "Acme" + "\u0307".repeat(240);
  const found = findMentionOccurrences(text, [brand]);
  expect(found[0].spans[0].end).toBe(text.length);
  const batch = buildLunaBatch(text, null, found);
  expect(batch.keys.get("b01")).toBe(brand.key);
  const input = JSON.parse(batch.request.openAiChat!.body.messages[1].content as string);
  expect(input.brands).toEqual([
    { brandKey: "b01", excerpts: [{ text: text.slice(0, 160), start: 0, end: 160 }] },
  ]);
});

const input = { text, brands, sentiment: { language: "en", analyzers: [lexicon, model] } };
const jsonRows = (...results: unknown[]) => JSON.stringify({ results });

test.each([
  ["missing row", jsonRows(rows[1])],
  ["duplicate key", jsonRows(rows[1], rows[1])],
  ["unknown key", jsonRows(rows[0], { ...rows[1], brandKey: "b99" })],
  ["bad score", jsonRows(rows[0], { ...rows[1], score: 1.1 })],
  ["nonfinite score", jsonRows(rows[0], rows[1]).replace("0.6001", "1e999")],
  ["bad label", jsonRows(rows[0], { ...rows[1], label: "mixed" })],
  ["label conflicts after rounding", jsonRows(rows[0], { ...rows[1], score: 0.2504 })],
  ["oversized rationale", jsonRows(rows[0], { ...rows[1], rationale: "😀".repeat(121) })],
  ["oversized reply", jsonRows(...rows) + " ".repeat(49_152)],
  ["invalid JSON", "{"],
])("invalid %s fails the whole secondary batch and preserves usage", async (_, content) => {
  const provider = stub(() => completion(content));
  const { data } = await post(createHandlers({ lunaEnabled: true, llm: provider.llm }), input);
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  expect(data.analyzers[1]).toMatchObject({ analyzer: model, status: "failed", primary: false });
  expect(data.mentions).toHaveLength(2);
  for (const mention of data.mentions) {
    expect(mention).toMatchObject({
      sentiment: "neutral",
      agreement: null,
      sentimentByAnalyzer: [
        { analyzer: lexicon, status: "ok" },
        { analyzer: model, status: "failed", label: null, score: null },
      ],
    });
  }
  expect(data.usage).toEqual([metered]);
});

test.each([{ refusal: "refused" }, { finish: "content_filter" }, { finish: "length" }])(
  "primary failure preserves only valid usage in telemetry for %j",
  async (metadata) => {
    const provider = stub(() => completion(undefined, metadata));
    const meter = vi.fn();
    const handlers = createHandlers({
      lunaEnabled: true,
      llm: provider.llm,
      reportFailedPrimaryUsage: meter,
    });
    const { data, retryAfter } = await post(
      handlers,
      { ...input, sentiment: { ...input.sentiment, primary: model } },
      503,
    );
    expect(data.code).toBe("provider_unavailable");
    expect(data).not.toHaveProperty("usage");
    expect(retryAfter).toBeUndefined();
    expect(meter).toHaveBeenCalledExactlyOnceWith(expect.anything(), metered);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  },
);

test.each([
  null,
  { ...validUsage, total_tokens: 1201 },
  { ...validUsage, prompt_tokens_details: { cached_tokens: 999, cache_write_tokens: 100 } },
])(
  "missing or inconsistent usage fails the analyzer without fabricating metering",
  async (usage) => {
    const provider = stub(() => completion(undefined, { usage }));
    const { data } = await post(createHandlers({ lunaEnabled: true, llm: provider.llm }), input);
    expect(data.analyzers[1].status).toBe("failed");
    expect(data.usage).toEqual([]);
    expect(provider.fetch).toHaveBeenCalledTimes(1);
  },
);

test.each([
  ["40", "40"],
  ["Sun, 06 Nov 1994 08:49:37 GMT", "Sun, 06 Nov 1994 08:49:37 GMT"],
  ["Sunday, 06-Nov-94 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT"],
  ["Sun Nov  6 08:49:37 1994", "Sun Nov  6 08:49:37 1994"],
  ["Tue, 31 Nov 2026 08:00:00 GMT", undefined],
  ["-1", undefined],
])("503 only forwards valid Retry-After (%s)", async (header, expected) => {
  const provider = stub(() =>
    Response.json(
      { error: { message: "busy" } },
      { status: 429, headers: { "retry-after": header } },
    ),
  );
  const { data, retryAfter } = await post(
    createHandlers({ lunaEnabled: true, llm: provider.llm }),
    {
      ...input,
      sentiment: { ...input.sentiment, primary: model },
    },
    503,
  );
  expect(data.code).toBe("provider_unavailable");
  expect(retryAfter).toBe(expected);
  expect(provider.fetch).toHaveBeenCalledTimes(1);
});

test("timeout fails the secondary with no retries", async () => {
  const provider = stub(() => {
    throw new DOMException("test timeout", "TimeoutError");
  });
  const { data } = await post(createHandlers({ lunaEnabled: true, llm: provider.llm }), input);
  expect(data.analyzers[1].status).toBe("failed");
  expect(data.usage).toEqual([]);
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  expect(provider.fetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
});

test("stub-only recording preserves completion metadata and replays with no credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rex-luna-offline-"));
  try {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      completion(undefined, { finish: "length" }),
    );
    const recorder = createLlm({
      data: { LLM_MODE: "record", OPENAI_API_KEY: "synthetic-test-key" },
      fixtureDir: directory,
      fetch,
    });
    const { request } = buildLunaBatch(text, "en", findMentionOccurrences(text, brands));
    const result = await recorder(request);
    expect(result).toMatchObject({ finishReason: "length", refused: false, usage: metered });
    expect(await readdir(directory)).toEqual([fixtureKey(request) + ".json"]);
    const replay = createLlm({ data: { LLM_MODE: "mock" }, fixtureDir: directory });
    await expect(replay(request)).resolves.toEqual(result);
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["enabled", "TRUE", "1", "0", ""])("rejects invalid Luna env value %j", (value) => {
  expect(() => loadConfig({ ANSWER_ANALYSIS_LUNA_ENABLED: value })).toThrow(
    /ANSWER_ANALYSIS_LUNA_ENABLED/,
  );
});

test("an invalid Luna flag aborts the server entry point at startup", async () => {
  vi.stubEnv("ANSWER_ANALYSIS_LUNA_ENABLED", "enabled");
  try {
    await expect(import("../src/server.js")).rejects.toThrow(/ANSWER_ANALYSIS_LUNA_ENABLED/);
  } finally {
    vi.unstubAllEnvs();
  }
});

test.each(["priority", "flex"])(
  "stub and replay refuse to price %s as Standard",
  async (serviceTier) => {
    const provider = stub(() => completion(undefined, { serviceTier }));
    const directory = await mkdtemp(join(tmpdir(), "rex-luna-tier-"));
    try {
      const request = buildLunaBatch(text, "en", findMentionOccurrences(text, brands)).request;
      await writeFile(
        join(directory, fixtureKey(request) + ".json"),
        JSON.stringify({
          text: jsonRows(...rows),
          inputTokens: 1000,
          outputTokens: 200,
          cachedInputTokens: 400,
          cacheWriteTokens: 100,
          finishReason: "stop",
          refused: false,
          serviceTier,
        }),
      );
      const mock = createLlm({ data: { LLM_MODE: "mock" }, fixtureDir: directory });
      for (const llm of [provider.llm, mock]) {
        const report = vi.fn();
        const warn = vi.fn();
        const handlers = createHandlers({
          lunaEnabled: true,
          llm,
          reportFailedPrimaryUsage: report,
        });
        const { data } = await post(handlers, input, 200, warn);
        expect(data.analyzers[1]).toMatchObject({ analyzer: model, status: "failed" });
        expect(data.usage).toEqual([]);
        for (const mention of data.mentions) {
          expect(mention.sentimentByAnalyzer[1]).toEqual({
            analyzer: model,
            status: "failed",
            label: null,
            score: null,
          });
        }
        const primary = await post(
          handlers,
          { ...input, sentiment: { ...input.sentiment, primary: model } },
          503,
          warn,
        );
        expect(primary.data.code).toBe("provider_unavailable");
        expect(primary.data).not.toHaveProperty("usage");
        expect(report).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(2);
        for (const [fields] of warn.mock.calls) {
          expect(fields).toEqual({
            code: "llm_unexpected_service_tier",
            analyzer: model,
            requestedTier: "default",
            reportedTier: serviceTier,
          });
        }
      }
      expect(provider.fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
