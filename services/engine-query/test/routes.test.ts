import { expect, test, vi } from "vitest";
import { createLlm } from "../src/llm/adapter.js";
import { checkResponse, tool } from "./support.js";

const path = "/v1/engine-answers";
const query = { engine: "chatgpt", prompt: "What is the Discovery Pass?" };
const expectedEngine = {
  id: "chatgpt",
  displayName: "ChatGPT",
  provider: "openai",
  model: "gpt-6-luna",
  webSearch: true,
  enabled: true,
};

const search = { type: "web_search_call", status: "completed", action: { type: "search" } };
const message = (text: string, annotations: unknown[] = []) => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text, annotations }],
});
const usage = {
  input_tokens: 2_000,
  input_tokens_details: { cached_tokens: 1_024, cache_write_tokens: 128 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 50 },
  total_tokens: 2_200,
};
const completion = {
  status: "completed",
  model: "gpt-6-luna",
  service_tier: "default",
  output: [search, message("Synthetic answer.")],
  usage,
  tool_usage: { web_search: { num_requests: 1 } },
};
const expectedUsage = {
  provider: "openai",
  model: "gpt-6-luna",
  operation: "answer_prompt",
  inputTokens: 2_000,
  outputTokens: 200,
  costMicrosUsd: 10_211,
};

function provider(fetch: typeof globalThis.fetch) {
  return createLlm({ data: { LLM_MODE: "live", OPENAI_API_KEY: "test-only" }, fetch });
}

async function post(app: ReturnType<typeof tool>, payload: object, status: number) {
  const response = await app.inject({ method: "POST", url: path, payload });
  expect(response.statusCode).toBe(status);
  const body = response.json();
  checkResponse(
    "POST",
    path,
    status,
    status === 200 ? "application/json" : "application/problem+json",
    body,
  );
  return { body, headers: response.headers };
}

test("discovery and ineligible requests make no provider request", async () => {
  const transport = vi.fn(async () => {
    throw new Error("Unexpected provider traffic");
  });
  const app = tool({}, provider(transport));
  try {
    const list = await app.inject({ method: "GET", url: "/v1/engines" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ data: [expectedEngine] });
    checkResponse("GET", "/v1/engines", 200, "application/json", list.json());

    for (const engine of ["claude", "gemini", "perplexity", "grok"]) {
      const { body } = await post(app, { ...query, engine }, 422);
      expect(body).toMatchObject({
        code: "unsupported_engine",
        detail: expect.stringContaining("/engine"),
      });
    }
    const { body: invalid } = await post(app, { ...query, engine: "unknown" }, 400);
    expect(invalid).toMatchObject({ code: "validation_failed", errors: [{ pointer: "/engine" }] });
    const { body: missing } = await post(app, { engine: "chatgpt" }, 400);
    expect(missing).toMatchObject({ code: "validation_failed", errors: [{ pointer: "/prompt" }] });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("registered defaults and explicit hints map verbatim prompts to one Responses request each", async () => {
  const transport = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses");
    expect(init?.method).toBe("POST");
    expect(init?.signal?.aborted).toBe(false);
    return Response.json(completion);
  });
  const app = tool({}, provider(transport));
  try {
    const prompt = "  Compare A  B.\nUse both lines.  ";
    for (const [index, hints] of [{}, { locale: "fr-CA", country: "CA" }].entries()) {
      const { body } = await post(app, { ...query, prompt, ...hints }, 200);
      expect(body).toEqual({
        answer: {
          engine: "chatgpt",
          model: "gpt-6-luna",
          text: "Synthetic answer.",
          sources: [],
          latencyMs: expect.any(Number),
        },
        usage: [expectedUsage],
      });
      expect(transport).toHaveBeenCalledTimes(index + 1);
      const wire = JSON.parse(String(transport.mock.calls[index][1]?.body));
      expect(wire).toEqual({
        model: "gpt-6-luna",
        instructions: expect.stringContaining(hints.locale ?? "en-US"),
        input: [{ role: "user", content: prompt }],
        tools: [
          {
            type: "web_search",
            search_context_size: "low",
            user_location: { type: "approximate", country: hints.country ?? "US" },
          },
        ],
        reasoning: { effort: "low" },
        tool_choice: "required",
        max_tool_calls: 1,
        max_output_tokens: 2_048,
        service_tier: "default",
        store: false,
        prompt_cache_options: { ttl: "30m" },
      });
    }
  } finally {
    await app.close();
  }
});

const cite = (url: string, title: string, start_index: number, end_index: number) => ({
  type: "url_citation",
  url,
  title,
  start_index,
  end_index,
});

test("Markdown citations use code-point offsets and deduplicate source rows in first-citation order", async () => {
  const a = "https://example.test/a?symbol=1&b=2#frag";
  const b = "https://example.test/b";
  const linked = "[Existing](https://example.test/b)";
  const text = "😀First. Next. " + linked;
  const startLink = Array.from(text.slice(0, text.indexOf(linked))).length;
  const transport = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      ...completion,
      output: [
        {
          ...search,
          action: { type: "search", sources: [{ url: "https://example.test/uncited" }] },
        },
        message(text, [
          cite(b, " ", startLink, startLink + linked.length - 1),
          cite(a, "Later duplicate", 8, 12),
          cite("HTTPS://EXAMPLE.TEST:443/a?symbol=1&b=2#frag", " Guide A ", 1, 6),
          cite("https://user@example.test/private", "Skip", 1, 6),
          cite("https:///path", "Skip empty host", 1, 6),
          cite("https://example.test/%ZZ", "Skip malformed percent", 1, 6),
          cite("javascript:alert(1)", "Skip scheme", 1, 6),
        ]),
        message("Final.", [cite(b, "Ignored later title", 0, 5)]),
      ],
    }),
  );
  const app = tool({}, provider(transport));
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer.text).toBe(
      "😀First. [1](<https://example.test/a?symbol=1&amp;b=2#frag>) Next. [1](<https://example.test/a?symbol=1&amp;b=2#frag>) " +
        linked +
        "\n\nFinal. [2](<https://example.test/b>)",
    );
    expect(body.answer.sources).toEqual([
      { url: a, title: "Guide A", position: 1 },
      { url: b, title: null, position: 2 },
    ]);
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test("mock route replays the checked-in synthetic response and reports its usage", async () => {
  const transport = vi.fn(async () => {
    throw new Error("Unexpected provider traffic");
  });
  const app = tool({}, createLlm({ data: { LLM_MODE: "mock" }, fetch: transport }));
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer).toMatchObject({
      text: expect.stringContaining("The pass covers admission to participating sites"),
      sources: [{ url: "https://example.test/discovery", title: "Discovery Pass", position: 1 }],
    });
    expect(body.usage).toEqual([expectedUsage]);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("completed search with explicit zero billable searches still returns 200", async () => {
  const reply = { ...completion, tool_usage: { web_search: { num_requests: 0 } } };
  const app = tool(
    {},
    provider(async () => Response.json(reply)),
  );
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer.sources).toEqual([]);
    expect(body.usage).toEqual([{ ...expectedUsage, costMicrosUsd: 211 }]);
  } finally {
    await app.close();
  }
});

test.each([
  ["unexpected model", { model: "other-model" }],
  ["unexpected service tier", { service_tier: "flex" }],
  ["incomplete response", { status: "incomplete" }],
  [
    "explicit refusal",
    {
      output: [
        search,
        { ...message(""), content: [{ type: "refusal", refusal: "Synthetic refusal" }] },
      ],
    },
  ],
  ["blank answer", { output: [search, message(" \n ")] }],
  ["absent search evidence", { output: [message("Answer.")] }],
  ["unfinished search", { output: [{ ...search, status: "failed" }, message("Answer.")] }],
  [
    "non-search action",
    { output: [{ ...search, action: { type: "open_page" } }, message("Answer.")] },
  ],
  ["missing token usage", { usage: undefined }],
  ["missing search metering", { tool_usage: undefined }],
  ["invalid search count", { tool_usage: { web_search: { num_requests: -1 } } }],
  ["inconsistent token total", { usage: { ...usage, total_tokens: 0 } }],
  [
    "overlapping cache counts",
    { usage: { ...usage, input_tokens_details: { cached_tokens: 1_999, cache_write_tokens: 2 } } },
  ],
  [
    "long cache writes",
    {
      usage: {
        ...usage,
        input_tokens_details: {
          ...usage.input_tokens_details,
          cache_write_tokens_details: { ttl_12h_tokens: 128, ttl_30m_tokens: 0 },
        },
      },
    },
  ],
])("returns 503 without retry for %s", async (_name, changes) => {
  const transport = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ ...completion, ...changes }),
  );
  const app = tool({}, provider(transport));
  try {
    const { body } = await post(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(body).not.toHaveProperty("usage");
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test.each([
  [429, "30", "30"],
  [429, "Tue, 24 Nov 2026 08:00:02 GMT", "2"],
  [429, "Tue, 24 Nov 2026 07:59:59 GMT", "0"],
  [429, "Tue, 31 Nov 2026 08:00:00 GMT", undefined],
  [503, "-1", undefined],
])("maps provider %s and validates Retry-After %s", async (status, retryAfter, expected) => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 24, 8, 0, 0, 500));
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(
      { error: { message: "Synthetic upstream failure" } },
      { status, headers: { "Retry-After": retryAfter } },
    ),
  );
  const app = tool({}, provider(fetch));
  try {
    const { body, headers } = await post(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(headers["retry-after"]).toBe(expected);
    expect(fetch).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
    await app.close();
  }
});

test("a deadline abort maps to 503 with no SDK retry", async () => {
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  const deadline = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation((ms) => realTimeout(ms === 110_000 ? 5 : ms));
  const transport = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
    const { signal } = init ?? {};
    if (!signal) throw new Error("Expected a signal");
    if (signal.aborted) throw signal.reason;
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const app = tool({}, provider(transport));
  try {
    const { body } = await post(app, query, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(deadline).toHaveBeenCalledWith(110_000);
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    deadline.mockRestore();
    await app.close();
  }
});
