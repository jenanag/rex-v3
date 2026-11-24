import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { createLlm } from "../src/llm/adapter.js";
import { postAnswer, tool } from "./support.js";

const model = "gemini-3.5-flash-lite";
const query = {
  provider: "google",
  model,
  webSearch: false,
  prompt: "  Name two Canadian outdoor brands.\n",
};
const usage = {
  promptTokenCount: 1_001,
  cachedContentTokenCount: 400,
  candidatesTokenCount: 180,
  thoughtsTokenCount: 21,
  totalTokenCount: 1_202,
  serviceTier: "standard",
};
const text = "Arc’teryx and MEC.";
const candidate = {
  finishReason: "STOP",
  content: { role: "model", parts: [{ text: "Synthetic thinking.", thought: true }, { text }] },
};
const completion = { modelVersion: model, candidates: [candidate], usageMetadata: usage };
const expectedUsage = {
  provider: "google",
  model,
  operation: "answer_prompt",
  inputTokens: 1_001,
  outputTokens: 201,
  costMicrosUsd: 695,
};

function provider(fetch: typeof globalThis.fetch) {
  return tool({}, createLlm({ data: { LLM_MODE: "live", GEMINI_API_KEY: "test-only" }, fetch }));
}

test("Gemini omitted and explicit locale and country defaults send identical requests", async () => {
  const wires: Array<{ url: string; body: unknown }> = [];
  const transport = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    wires.push({ url: request.url, body: await request.json() });
    return Response.json(completion);
  });
  const app = provider(transport);
  try {
    const { body: omitted } = await postAnswer(app, query, 200);
    const { body: explicit } = await postAnswer(
      app,
      { ...query, locale: "en-US", country: "US" },
      200,
    );
    expect(explicit).toEqual({
      answer: { ...omitted.answer, model, latencyMs: expect.any(Number) },
      usage: [expectedUsage],
    });
    expect(omitted.usage).toEqual(explicit.usage);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(wires[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1/models/" + model + ":generateContent",
    );
    expect(wires[1]).toEqual(wires[0]);
  } finally {
    await app.close();
  }
});

test.each([
  [{}, "en-US", "US"],
  [{ webSearch: false, locale: "en-CA", country: "CA" }, "en-CA", "CA"],
])("Gemini serializes a text-only request with hints %j", async (fields, locale, country) => {
  const transport = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.url).toBe(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    );
    expect(request.method).toBe("POST");
    expect(request.redirect).toBe("error");
    expect(request.signal.aborted).toBe(false);
    expect(request.headers.get("X-Server-Timeout")).toBe("110");
    expect(await request.json()).toEqual({
      contents: [{ parts: [{ text: query.prompt }], role: "user" }],
      serviceTier: "standard",
      systemInstruction: {
        parts: [
          {
            text: `Answer in Markdown. Prefer locale ${locale}. Use ${country} as a regional relevance hint.`,
          },
        ],
        role: "user",
      },
      generationConfig: {
        maxOutputTokens: 2_048,
        thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false },
      },
    });
    return Response.json(completion);
  });
  const app = provider(transport);
  try {
    const { body } = await postAnswer(app, { ...query, ...fields }, 200);
    expect(body).toEqual({
      answer: { provider: "google", model, text, sources: [], latencyMs: expect.any(Number) },
      usage: [expectedUsage],
    });
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test.each([undefined, "unspecified"])(
  "Gemini allows omitted optional counts with tier %s",
  async (serviceTier) => {
    const app = provider(async () =>
      Response.json({
        ...completion,
        usageMetadata: {
          promptTokenCount: 11,
          candidatesTokenCount: 2,
          totalTokenCount: 13,
          serviceTier,
        },
      }),
    );
    try {
      const { body } = await postAnswer(app, query, 200);
      expect(body.usage).toEqual([
        { ...expectedUsage, inputTokens: 11, outputTokens: 2, costMicrosUsd: 8 },
      ]);
    } finally {
      await app.close();
    }
  },
);

test.each([
  ["wrong model", { modelVersion: "other-model" }],
  ["blocked prompt", { promptFeedback: { blockReason: "SAFETY" } }],
  ["no candidate", { candidates: [] }],
  ["multiple candidates", { candidates: [candidate, candidate] }],
  ["truncation", { candidates: [{ ...candidate, finishReason: "MAX_TOKENS" }] }],
  ["blocked candidate", { candidates: [{ ...candidate, finishReason: "SAFETY" }] }],
  [
    "thought-only answer",
    { candidates: [{ ...candidate, content: { parts: [candidate.content.parts[0]] } }] },
  ],
  ["blank answer", { candidates: [{ ...candidate, content: { parts: [{ text: " \n " }] } }] }],
  [
    "nontext candidate",
    { candidates: [{ ...candidate, content: { parts: [{ functionCall: { name: "other" } }] } }] },
  ],
  ["missing usage", { usageMetadata: undefined }],
  [
    "missing required candidate count",
    { usageMetadata: { ...usage, candidatesTokenCount: undefined } },
  ],
  [
    "missing thoughts needed for reconciliation",
    { usageMetadata: { ...usage, thoughtsTokenCount: undefined } },
  ],
  ["unsafe count", { usageMetadata: { ...usage, promptTokenCount: 2 ** 53 } }],
  ["fractional count", { usageMetadata: { ...usage, candidatesTokenCount: 0.5 } }],
  ["negative count", { usageMetadata: { ...usage, thoughtsTokenCount: -1 } }],
  ["null count", { usageMetadata: { ...usage, cachedContentTokenCount: null } }],
  ["excessive cache reads", { usageMetadata: { ...usage, cachedContentTokenCount: 1_002 } }],
  [
    "positive tool-use count",
    { usageMetadata: { ...usage, toolUsePromptTokenCount: 1, totalTokenCount: 1_203 } },
  ],
  ["inconsistent total", { usageMetadata: { ...usage, totalTokenCount: 1_201 } }],
  ["priority tier", { usageMetadata: { ...usage, serviceTier: "priority" } }],
  ["flex tier", { usageMetadata: { ...usage, serviceTier: "flex" } }],
])("Gemini returns 503 for %s without retry", async (_name, changes) => {
  const transport = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ ...completion, ...changes }),
  );
  const app = provider(transport);
  try {
    const { body } = await postAnswer(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(body).not.toHaveProperty("usage");
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test.each([
  ["7", "7"],
  ["Tue, 31 Nov 2026 08:00:00 GMT", undefined],
])("Gemini captures Retry-After %s before the SDK discards headers", async (value, expected) => {
  const transport = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(
      { error: { code: 429, message: "Synthetic quota error", status: "RESOURCE_EXHAUSTED" } },
      { status: 429, headers: { "Retry-After": value } },
    ),
  );
  const app = provider(transport);
  try {
    const { body, headers } = await postAnswer(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(headers["retry-after"]).toBe(expected);
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test("Gemini replays a synthetic recorded response without credentials or transport", async () => {
  const fixtureDir = await mkdtemp(join(tmpdir(), "rex-gemini-fixture-"));
  const record = tool(
    {},
    createLlm({
      data: { LLM_MODE: "record", GEMINI_API_KEY: "test-only" },
      fetch: async () => Response.json(completion),
      fixtureDir,
    }),
  );
  const unexpectedTransport = vi.fn(async () => {
    throw new Error("Unexpected provider traffic");
  });
  const mock = tool(
    {},
    createLlm({ data: { LLM_MODE: "mock" }, fetch: unexpectedTransport, fixtureDir }),
  );
  try {
    const { body: recorded } = await postAnswer(record, query, 200);
    expect(await readdir(fixtureDir)).toEqual([expect.stringMatching(/^[0-9a-f]{64}\.json$/)]);
    const { body: replayed } = await postAnswer(mock, { ...query, webSearch: false }, 200);
    expect(replayed).toEqual({
      ...recorded,
      answer: { ...recorded.answer, latencyMs: expect.any(Number) },
    });
    expect(replayed.usage).toEqual([expectedUsage]);
    expect(unexpectedTransport).not.toHaveBeenCalled();
  } finally {
    await record.close();
    await mock.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
});

test("Gemini replays the recorded Canadian outdoor brands answer offline", async () => {
  const recording = JSON.parse(
    await readFile(
      new URL(
        "./fixtures/llm/ff3ab438ba1224b1ee173121d2809c55c14bda4ffbe1b0e3364b67d5f4440c5e.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const transport = vi.fn(async () => {
    throw new Error("Unexpected provider traffic");
  });
  const app = tool({}, createLlm({ data: { LLM_MODE: "mock" }, fetch: transport }));
  try {
    const { body } = await postAnswer(
      app,
      {
        ...query,
        locale: "en-CA",
        country: "CA",
        prompt:
          "Name two Canadian outdoor brands and describe one product category each is known for.",
      },
      200,
    );
    expect(body).toEqual({
      answer: {
        provider: "google",
        model,
        text: recording.candidates[0].content.parts[0].text,
        sources: [],
        latencyMs: expect.any(Number),
      },
      usage: [{ ...expectedUsage, inputTokens: 35, outputTokens: 172, costMicrosUsd: 441 }],
    });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("Gemini sends the 110-second deadline and aborts without retry", async () => {
  const controller = new AbortController();
  const deadline = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const observed = vi.fn();
  const transport = vi.fn<typeof globalThis.fetch>((input, init) => {
    const request = new Request(input, init);
    expect(request.headers.get("X-Server-Timeout")).toBe("110");
    const { signal } = request;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          observed();
          reject(signal.reason);
        },
        { once: true },
      );
      controller.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    });
  });
  const app = provider(transport);
  try {
    const { body } = await postAnswer(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(deadline).toHaveBeenCalledWith(110_000);
    expect(transport).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
  } finally {
    deadline.mockRestore();
    await app.close();
  }
});
