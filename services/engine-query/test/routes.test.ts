import { expect, test, vi } from "vitest";
import { createLlm } from "../src/llm/adapter.js";
import { loadEngineConfig } from "../src/tool-env.js";
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
          cite(b, " ", startLink, startLink + linked.length),
          cite(a, "Later duplicate", 8, 13),
          cite("HTTPS://EXAMPLE.TEST:443/a?symbol=1&b=2#frag", " Guide A ", 1, 7),
          cite("https://user@example.test/private", "Skip", 1, 7),
          cite("https:///path", "Skip empty host", 1, 7),
          cite("https://example.test/%ZZ", "Skip malformed percent", 1, 7),
          cite("javascript:alert(1)", "Skip scheme", 1, 7),
        ]),
        message("Final.", [cite(b, "Ignored later title", 0, 6)]),
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

test.each([
  ["single backticks", "`Guide`"],
  ["double backticks with literal backticks", "`` `Guide` ``"],
  ["link-like text in single backticks", "`[Guide](https://example.test/guide)`"],
  ["link-like text in double backticks", "``[Guide](https://example.test/guide)``"],
])("places a clickable citation after a code span with %s", async (_name, span) => {
  const url = "https://example.test/guide";
  const text = "See " + span + " for the command.";
  const start = text.indexOf("Guide");
  const reply = {
    ...completion,
    output: [search, message(text, [cite(url, "Guide", start, start + 5)])],
  };
  const app = tool(
    {},
    provider(async () => Response.json(reply)),
  );
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer.text).toBe(`See ${span} [1](<${url}>) for the command.`);
    expect(body.answer.sources).toEqual([{ url, title: "Guide", position: 1 }]);
  } finally {
    await app.close();
  }
});

test.each([
  [
    "literal backticks in separate paragraphs",
    "See ` Guide for the command.\n\nAnother ` is literal.",
    "See ` Guide [1](<https://example.test/guide>) for the command.\n\nAnother ` is literal.",
  ],
  [
    "a multiline code span within one paragraph",
    "See `Guide\nexample` for the command.",
    "See `Guide\nexample` [1](<https://example.test/guide>) for the command.",
  ],
  [
    "an inline code span after a leading byte-order mark",
    "\uFEFFSee `Guide` for the command.",
    "\uFEFFSee `Guide` [1](<https://example.test/guide>) for the command.",
  ],
  [
    "a backtick fence",
    "```txt\nGuide\n```\n\nFollow the command.",
    "```txt\nGuide\n```\n\n[1](<https://example.test/guide>)\n\nFollow the command.",
  ],
  [
    "a tilde fence",
    "~~~txt\nGuide\n~~~\n\nFollow the command.",
    "~~~txt\nGuide\n~~~\n\n[1](<https://example.test/guide>)\n\nFollow the command.",
  ],
  [
    "a tilde fence inside a blockquote",
    "> ~~~txt\n> Guide\n> ~~~\n>\n> Follow the command.",
    "> ~~~txt\n> Guide\n> ~~~\n>\n> [1](<https://example.test/guide>)\n>\n> Follow the command.",
  ],
  [
    "a backtick fence inside a list item",
    "12. ```txt\n    Guide\n    ```\n\n    Follow the command.",
    "12. ```txt\n    Guide\n    ```\n\n    [1](<https://example.test/guide>)\n\n    Follow the command.",
  ],
  [
    "a longer closing fence followed by prose without a blank line",
    "~~~txt\r\nGuide\r\n~~~~\r\nFollow the command.",
    "~~~txt\r\nGuide\r\n~~~~\r\n\r\n[1](<https://example.test/guide>)\r\n\r\nFollow the command.",
  ],
  ["an unclosed fence with a source row and unchanged Markdown", "```txt\nGuide", "```txt\nGuide"],
])("preserves Markdown and places the citation for %s", async (_name, text, expected) => {
  const url = "https://example.test/guide";
  const start = text.indexOf("Guide");
  const reply = {
    ...completion,
    output: [search, message(text, [cite(url, "Guide", start, start + 5)])],
  };
  const app = tool(
    {},
    provider(async () => Response.json(reply)),
  );
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer.text).toBe(expected);
    expect(body.answer.sources).toEqual([{ url, title: "Guide", position: 1 }]);
  } finally {
    await app.close();
  }
});

test.each([
  ["at the end of the answer", "Guide", "Guide [1](<https://example.test/guide>)"],
  [
    "before a paragraph break",
    "Guide\n\nMore prose.",
    "Guide [1](<https://example.test/guide>)\n\nMore prose.",
  ],
])("inserts a citation %s using the exclusive end offset", async (_name, text, expected) => {
  const url = "https://example.test/guide";
  const reply = { ...completion, output: [search, message(text, [cite(url, "Guide", 0, 5)])] };
  const app = tool(
    {},
    provider(async () => Response.json(reply)),
  );
  try {
    const { body } = await post(app, query, 200);
    expect(body.answer.text).toBe(expected);
    expect(body.answer.sources).toEqual([{ url, title: "Guide", position: 1 }]);
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
      text: "The pass covers admission to participating sites [1](<https://example.test/discovery>).",
      sources: [{ url: "https://example.test/discovery", title: "Discovery Pass", position: 1 }],
    });
    expect(body.usage).toEqual([expectedUsage]);
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test("mock route replays the recorded Parks Canada answer", async () => {
  const transport = vi.fn(async () => {
    throw new Error("Unexpected provider traffic");
  });
  const app = tool({}, createLlm({ data: { LLM_MODE: "mock" }, fetch: transport }));
  try {
    const { body } = await post(
      app,
      {
        engine: "chatgpt",
        locale: "en-CA",
        country: "CA",
        prompt:
          "What does the Parks Canada Discovery Pass cover? Cite two official Parks Canada pages in your answer.",
      },
      200,
    );
    expect(body).toEqual({
      answer: {
        engine: "chatgpt",
        model: "gpt-6-luna",
        text: [
          "The **Parks Canada Discovery Pass** covers unlimited **daily admission** for 12 months to ",
          "participating Parks Canada places—national parks, national historic sites, and national marine ",
          "conservation areas. It covers the admission privileges normally included with a daily pass, but ",
          "**not** separately charged items such as camping or accommodations, backcountry overnight use, ",
          "guided tours, hot springs, or parking where those have an extra fee. It also doesn’t cover ",
          "places not administered by Parks Canada. ",
          "([parks.canada.ca](https://www.parks.canada.ca/termes-terms/reservation?utm_source=openai))\n",
          "\n",
          "Sources: [Parks Canada — Reservation policies and Discovery Pass ",
          "terms](https://www.parks.canada.ca/termes-terms/reservation) · [Parks Canada — Discovery Pass ",
          "for independent ",
          "travellers](https://parks.canada.ca/voyage-travel/voyagistes-traveltrade/~/link.aspx?_id=C9A7C8E853CA42CB91F6D629C07031F6&_z=z)",
        ].join(""),
        sources: [
          {
            url: "https://www.parks.canada.ca/termes-terms/reservation?utm_source=openai",
            title: "Reservation policies",
            position: 1,
          },
        ],
        latencyMs: expect.any(Number),
      },
      usage: [
        {
          provider: "openai",
          model: "gpt-6-luna",
          operation: "answer_prompt",
          inputTokens: 8_563,
          outputTokens: 268,
          costMicrosUsd: 11_099,
        },
      ],
    });
    expect(transport).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test.each([
  [0, 211],
  [1, 10_211],
  [2, 20_211],
])(
  "a completed search with %i reported billable searches returns HTTP 200",
  async (count, cost) => {
    const reply = { ...completion, tool_usage: { web_search: { num_requests: count } } };
    const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json(reply));
    const app = tool({}, provider(transport));
    try {
      const { body } = await post(app, query, 200);
      expect(body.answer.sources).toEqual([]);
      expect(body.usage).toEqual([{ ...expectedUsage, costMicrosUsd: cost }]);
      expect(transport).toHaveBeenCalledOnce();
      expect(JSON.parse(String(transport.mock.calls[0][1]?.body)).max_tool_calls).toBe(1);
    } finally {
      await app.close();
    }
  },
);

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
  ["fractional search count", { tool_usage: { web_search: { num_requests: 1.5 } } }],
  ["unsafe search count", { tool_usage: { web_search: { num_requests: 2 ** 53 } } }],
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

test.each(["chatgpt", "grok"])(
  "%s deadline abort maps to 503 with no SDK retry",
  async (engine) => {
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
    const grokEnabled = engine === "grok";
    const app = tool(
      { ENGINE_QUERY_GROK_ENABLED: grokEnabled },
      (grokEnabled ? xai : provider)(transport),
    );
    try {
      const { body } = await post(app, { ...query, engine }, 503);
      expect(body).toMatchObject({ code: "provider_unavailable" });
      expect(deadline).toHaveBeenCalledWith(110_000);
      expect(transport).toHaveBeenCalledOnce();
    } finally {
      deadline.mockRestore();
      await app.close();
    }
  },
);

const grokQuery = { ...query, engine: "grok" };
const grokUsage = {
  input_tokens: 1_000,
  input_tokens_details: { cached_tokens: 400 },
  output_tokens: 200,
  output_tokens_details: { reasoning_tokens: 20 },
  total_tokens: 1_200,
  server_side_tool_usage_details: { web_search_calls: 2 },
  cost_in_usd_ticks: 113_300_000,
};
const grokCompletion = {
  model: "grok-4.3",
  status: "completed",
  service_tier: "default",
  output: [search, message("Synthetic answer.")],
  usage: grokUsage,
};

function xai(fetch: typeof globalThis.fetch) {
  return createLlm({ data: { LLM_MODE: "live", XAI_API_KEY: "test-only" }, fetch });
}

test.each([
  [undefined, false],
  ["false", false],
  ["true", true],
])("startup flag %s controls Grok discovery and eligibility", async (value, enabled) => {
  const config = loadEngineConfig({
    ...(value === undefined ? {} : { ENGINE_QUERY_GROK_ENABLED: value }),
  });
  expect(config.ENGINE_QUERY_GROK_ENABLED).toBe(enabled);
  const transport = vi.fn(async () => Response.json(grokCompletion));
  const app = tool(config, xai(transport));
  try {
    const list = await app.inject({ method: "GET", url: "/v1/engines" });
    expect(list.statusCode).toBe(200);
    const engines = list.json();
    checkResponse("GET", "/v1/engines", 200, "application/json", engines);
    expect(engines).toEqual({
      data: enabled
        ? [
            expectedEngine,
            {
              id: "grok",
              displayName: "Grok",
              provider: "xai",
              model: "grok-4.3",
              webSearch: true,
              enabled: true,
            },
          ]
        : [expectedEngine],
    });
    const { body } = await post(app, grokQuery, enabled ? 200 : 422);
    if (enabled) {
      expect(body.answer).toMatchObject({ engine: "grok", model: "grok-4.3" });
      expect(transport).toHaveBeenCalledOnce();
    } else {
      expect(body).toMatchObject({ code: "unsupported_engine" });
      expect(transport).not.toHaveBeenCalled();
    }
  } finally {
    await app.close();
  }
});

test("invalid Grok flag fails startup validation", () => {
  expect(() => loadEngineConfig({ ENGINE_QUERY_GROK_ENABLED: "yes" })).toThrow(
    /ENGINE_QUERY_GROK_ENABLED/,
  );
});

test.each([{}, { locale: "fr-CA", country: "CA" }])(
  "Grok submits verbatim text and renders cited Markdown with hints %j",
  async ({ locale, country }) => {
    const guide = "https://example.test/guide";
    const map = "https://example.test/map";
    const text = `🍁 [Guide](<${guide}>). Again. Map.`;
    const citation = (url: string, citedText: string, title: string) => {
      const start = Array.from(text.slice(0, text.indexOf(citedText))).length;
      return {
        type: "url_citation",
        url,
        start_index: start,
        end_index: start + Array.from(citedText).length,
        title,
      };
    };
    const output = [
      search,
      message(text, [
        citation(map, "Map", "Trail map"),
        citation(guide, `[Guide](<${guide}>)`, "1"),
        citation(guide, "Again", "2"),
      ]),
    ];
    const transport = vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const wire = new Request(url, init);
      expect(wire.url).toBe("https://api.x.ai/v1/responses");
      expect(wire.method).toBe("POST");
      expect(wire.headers.get("authorization")).toBe("Bearer test-only");
      expect(wire.redirect).toBe("error");
      expect(init?.signal?.aborted).toBe(false);
      return Response.json({ ...grokCompletion, output });
    });
    const app = tool({ ENGINE_QUERY_GROK_ENABLED: true }, xai(transport));
    try {
      const prompt = "  Compare A  B.\nUse both lines.  ";
      const { body } = await post(app, { ...grokQuery, prompt, locale, country }, 200);
      expect(transport).toHaveBeenCalledOnce();
      expect(JSON.parse(String(transport.mock.calls[0][1]?.body))).toEqual({
        model: "grok-4.3",
        input: [
          {
            role: "system",
            content: `Use hosted web search before answering. Answer concisely in Markdown in ${locale ?? "en-US"}. Prefer sources relevant to country ${country ?? "US"}.`,
          },
          { role: "user", content: prompt },
        ],
        tools: [{ type: "web_search" }],
        tool_choice: "required",
        parallel_tool_calls: false,
        max_turns: 2,
        reasoning: { effort: "low" },
        max_output_tokens: 2_048,
        stream: false,
        store: false,
        service_tier: "default",
      });
      expect(body.answer).toEqual({
        engine: "grok",
        model: "grok-4.3",
        text: `🍁 [Guide](<${guide}>). Again [1](<${guide}>). Map [2](<${map}>).`,
        sources: [
          { url: guide, title: null, position: 1 },
          { url: map, title: "Trail map", position: 2 },
        ],
        latencyMs: expect.any(Number),
      });
      expect(body.usage).toEqual([
        {
          provider: "xai",
          model: "grok-4.3",
          operation: "answer_prompt",
          inputTokens: 1_000,
          outputTokens: 200,
          costMicrosUsd: 11_330,
        },
      ]);
    } finally {
      await app.close();
    }
  },
);

test.each([
  [199_999, 2_600_787_500, 260_079],
  [200_000, 5_101_600_000, 510_160],
  [1_000, undefined, 11_330],
])("prices Grok input tokens %s with reported ticks %s", async (input, ticks, cost) => {
  const transport = vi.fn(async () =>
    Response.json({
      ...grokCompletion,
      output: [search, { ...message(""), content: [{ type: "output_text", text: "Answer." }] }],
      usage: {
        ...grokUsage,
        input_tokens: input,
        total_tokens: input + 200,
        cost_in_usd_ticks: ticks,
      },
    }),
  );
  const warn = vi.fn();
  const call = xai(transport);
  const app = tool({ ENGINE_QUERY_GROK_ENABLED: true }, (entry, prompt, locale, country) =>
    call(entry, prompt, locale, country, warn),
  );
  try {
    const { body } = await post(app, grokQuery, 200);
    expect(body.answer.sources).toEqual([]);
    expect(body.usage).toHaveLength(1);
    expect(body.usage[0]).toMatchObject({ inputTokens: input, costMicrosUsd: cost });
    expect(transport).toHaveBeenCalledOnce();
    if (ticks === undefined)
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        "xAI usage omitted cost ticks; using catalog pricing",
      );
    else expect(warn).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

test.each([
  { output: [message("No search.")] },
  { output: [search, { ...message(""), content: [{ type: "refusal" }] }] },
  { output: [search, message(" ")] },
  { status: "incomplete" },
  { model: "other-model" },
  { service_tier: "priority" },
  { usage: { ...grokUsage, total_tokens: 1_201 } },
  { usage: { ...grokUsage, input_tokens_details: { cached_tokens: 1_001 } } },
  { usage: { ...grokUsage, output_tokens_details: { reasoning_tokens: 201 } } },
  { usage: { ...grokUsage, server_side_tool_usage_details: undefined } },
  { usage: { ...grokUsage, server_side_tool_usage_details: { web_search_calls: -1 } } },
  ...[null, -1, 2 ** 53, "113300000", 113_299_999, 113_300_001].map((cost_in_usd_ticks) => ({
    usage: { ...grokUsage, cost_in_usd_ticks },
  })),
])("rejects unusable Grok responses without retry (%j)", async (changes) => {
  const transport = vi.fn(async () => Response.json({ ...grokCompletion, ...changes }));
  const app = tool({ ENGINE_QUERY_GROK_ENABLED: true }, xai(transport));
  try {
    const { body } = await post(app, grokQuery, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});

test("Grok rate limit uses the existing Retry-After conversion and makes one attempt", async () => {
  const transport = vi.fn(async () =>
    Response.json(
      { error: { message: "Synthetic rate limit" } },
      {
        status: 429,
        headers: { "Retry-After": "7" },
      },
    ),
  );
  const app = tool({ ENGINE_QUERY_GROK_ENABLED: true }, xai(transport));
  try {
    const { body, headers } = await post(app, grokQuery, 503);
    expect(body).toMatchObject({ code: "provider_unavailable" });
    expect(headers["retry-after"]).toBe("7");
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
