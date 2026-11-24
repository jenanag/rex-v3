import { afterEach, expect, test, vi } from "vitest";
import { createLlm, type LlmRequest } from "../src/llm/adapter.js";
import { defaultModel, pricedModels } from "../src/llm/models.js";

const { provider, model, price } = pricedModels.get(defaultModel)!;
const request: LlmRequest = {
  provider,
  model,
  price,
  operation: "summarize_page",
  prompt: "Synthetic prompt",
  maxOutputTokens: 256,
  reasoningEffort: "none",
  timeoutMs: 60_000,
};
const llm = createLlm({ data: { LLM_MODE: "live", OPENAI_API_KEY: "offline-fixture-key" } });
afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  // Exercise the actual OpenAI SDK locally with synthetic HTTP replies.
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

test("calls Chat Completions once and prices each token once, rounding only the total", async () => {
  const fetch = stubFetch().mockImplementation(async () =>
    Response.json({
      model,
      choices: [{ message: { content: '{"description":"Synthetic."}' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 20 },
      },
    }),
  );
  const output = await llm(request);
  expect(output).toEqual({
    text: '{"description":"Synthetic."}',
    usage: {
      provider,
      model,
      operation: "summarize_page",
      inputTokens: 100,
      outputTokens: 10,
      costMicrosUsd: 13, // 5 + 0.3 + 2.5 + 5 microdollars.
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, options] = fetch.mock.calls[0];
  expect(new URL(String(url)).pathname).toBe("/v1/chat/completions");
  expect(options?.method).toBe("POST");
  expect(JSON.parse(String(options?.body))).toEqual({
    model,
    max_completion_tokens: 256,
    reasoning_effort: "none",
    service_tier: "default",
    messages: [{ role: "user", content: request.prompt }],
  });
});

test("preserves valid low token counts when the provider returns no text", async () => {
  const fetch = stubFetch().mockImplementation(async () =>
    Response.json({
      model,
      choices: [],
      usage: {
        prompt_tokens: 47,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 3 },
      },
    }),
  );
  expect(await llm(request)).toMatchObject({
    text: "",
    usage: { inputTokens: 47, outputTokens: 0, costMicrosUsd: 1 },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  ["30", "30"],
  ["Tue, 24 Nov 2026 08:00:00 GMT", "Tue, 24 Nov 2026 08:00:00 GMT"],
  ["3.5", undefined],
])(
  "maps a provider error and handles Retry-After %s without retrying",
  async (header, expected) => {
    const fetch = stubFetch().mockImplementation(async () =>
      Response.json(
        { error: { message: "Synthetic rate limit" } },
        {
          status: 429,
          headers: { "Retry-After": header },
        },
      ),
    );
    await expect(llm(request)).rejects.toMatchObject({
      statusCode: 503,
      problemCode: "provider_unavailable",
      retryAfter: expected,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

test("aborts a pending request at the provider timeout without retrying", async () => {
  const fetch = stubFetch().mockImplementation(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
  );
  await expect(llm({ ...request, timeoutMs: 30 })).rejects.toMatchObject({
    statusCode: 503,
    problemCode: "provider_unavailable",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
});

test("rejects an inconsistent provider usage split", async () => {
  const fetch = stubFetch().mockImplementation(async () =>
    Response.json({
      model,
      choices: [],
      usage: {
        prompt_tokens: 2,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
      },
    }),
  );
  await expect(llm(request)).rejects.toMatchObject({
    statusCode: 503,
    problemCode: "provider_unavailable",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
