import { afterAll, afterEach, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm/adapter.js";
import { checkResponse, tool } from "./support.js";

const path = "/v1/llms-txt/page-entries";
const model = "openai/gpt-6-luna";
const base = {
  url: "https://example.org/guide",
  metadata: { title: "Setup Guide", description: null, canonicalUrl: null, language: "en" },
  content: { text: "Run setup before starting the service.", markdown: "" },
};
const usage = {
  provider: "openai" as const,
  model: "gpt-6-luna",
  operation: "summarize_page",
  inputTokens: 100,
  outputTokens: 10,
  costMicrosUsd: 13,
};
const app = tool();
const mock = vi.fn<ReturnType<typeof createLlm>>();
const observed = tool({}, mock);
const provider = tool(
  {},
  createLlm({ data: { LLM_MODE: "live", OPENAI_API_KEY: "offline-fixture-key" } }),
);
afterEach(() => {
  mock.mockReset();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await Promise.all([app.close(), observed.close(), provider.close()]);
});

async function post(payload: Record<string, unknown> | string, status: number, target = observed) {
  const res = await target.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json" },
    payload,
  });
  expect(res.statusCode).toBe(status);
  const media = status === 200 ? "application/json" : "application/problem+json";
  expect(res.headers["content-type"]).toContain(media);
  const result: unknown = res.json();
  checkResponse("POST", path, status, media, result);
  return { result, headers: res.headers };
}

test.each([{}, { summarizer: "llm", model }])(
  "uses the priced Luna fixture for %j",
  async (options) => {
    const { result } = await post({ ...base, ...options }, 200, app);
    expect(result).toEqual({
      entry: {
        url: base.url,
        title: "Setup Guide",
        description: "Run setup to prepare the service.",
      },
      usage: [usage],
    });
  },
);

test("validates the deployment default without credentials", () => {
  expect(loadConfig({ NODE_ENV: "test" }).LLMS_TXT_GENERATOR_DEFAULT_MODEL).toBe(model);
  expect(
    loadConfig({ LLMS_TXT_GENERATOR_DEFAULT_MODEL: model }).LLMS_TXT_GENERATOR_DEFAULT_MODEL,
  ).toBe(model);
  expect(() => loadConfig({ LLMS_TXT_GENERATOR_DEFAULT_MODEL: "openai/unpriced" })).toThrow(
    /LLMS_TXT_GENERATOR_DEFAULT_MODEL/,
  );
});

test.each([
  ["{", 400, "validation_failed", ""],
  [{ ...base, model: "unqualified" }, 400, "validation_failed", ""],
  [{ ...base, model: "openai/unlisted" }, 422, "unsupported_model", "/model"],
  [{ ...base, url: "https://example.org:65536/" }, 422, "invalid_page_url", "/url"],
] as const)(
  "returns the shared Problem before the provider call (%j)",
  async (payload, status, code, field) => {
    const { result } = await post(payload, status);
    expect(result).toMatchObject({
      status,
      code,
      ...(field && { detail: expect.stringContaining(field) }),
    });
    expect(mock).not.toHaveBeenCalled();
  },
);

test("extractive stays offline even if given an unlisted schema-valid model", async () => {
  const { result } = await post(
    { ...base, summarizer: "extractive", model: "openai/unlisted" },
    200,
  );
  expect(result).toEqual({
    entry: { url: base.url, title: "Setup Guide", description: base.content.text },
    usage: [],
  });
  expect(mock).not.toHaveBeenCalled();
});

test("a title with no usable description source makes no provider call", async () => {
  const { result } = await post(
    { ...base, content: { text: " \t", markdown: "# Heading\n\n<!-- nothing -->" } },
    200,
  );
  expect(result).toEqual({
    entry: { url: base.url, title: "Setup Guide", description: null },
    usage: [],
  });
  expect(mock).not.toHaveBeenCalled();
});

test("bounds serialized escaped and Unicode input and uses only the approved fields", async () => {
  mock.mockResolvedValue({ text: '{"description":" One.\\n Two. Three. "}', usage });
  const text = '😀e\u0301"\\\u0001'.repeat(5_000) + "q".repeat(100);
  const { result } = await post(
    {
      ...base,
      metadata: {
        title: '  Guide\n" title ',
        description: '"\\😀'.repeat(1_600),
        canonicalUrl: "https://do-not-send.example/",
        language: "en",
      },
      content: { text, markdown: "[Do not send](https://do-not-send.example/other)" },
    },
    200,
  );
  expect(result).toEqual({
    entry: { url: base.url, title: 'Guide " title', description: "One. Two." },
    usage: [usage],
  });
  expect(mock).toHaveBeenCalledTimes(1);
  const [request] = mock.mock.calls[0];
  expect(request).toMatchObject({
    provider: "openai",
    model: "gpt-6-luna",
    operation: "summarize_page",
    maxOutputTokens: 256,
    timeoutMs: 60_000,
    reasoningEffort: "none",
  });
  const bytes = Buffer.byteLength(request.prompt, "utf8");
  expect(bytes).toBeLessThanOrEqual(16_384);
  expect(bytes).toBeGreaterThanOrEqual(16_379);
  const [instructions, data] = request.prompt.split("\n");
  expect(instructions).toContain("untrusted");
  const page = JSON.parse(data);
  expect(Object.keys(page)).toEqual(["title", "metadataDescription", "language", "text"]);
  expect(page).toMatchObject({ title: 'Guide " title', language: "en" });
  expect(Buffer.byteLength(JSON.stringify(page.metadataDescription)) - 2).toBeLessThanOrEqual(
    2_048,
  );
  expect(text.startsWith(page.text)).toBe(true);
  expect(page.text.isWellFormed()).toBe(true);
  expect(request.prompt).not.toContain("do-not-send.example");
});

test("uses only visible Markdown prose when normalized plain text is blank", async () => {
  mock.mockResolvedValue({ text: '{"description":"Install the module."}', usage });
  const { result } = await post(
    {
      ...base,
      metadata: { ...base.metadata, title: null, language: null },
      content: {
        text: "\n",
        markdown:
          "# **Setup**\n\nInstall [the module](https://do-not-send.example).<br/>Then start.\n\n- Finish setup.",
      },
    },
    200,
  );
  expect(result).toMatchObject({ entry: { title: "Setup", description: "Install the module." } });
  const page = JSON.parse(mock.mock.calls[0][0].prompt.split("\n")[1]);
  expect(page).toEqual({ title: "Setup", text: "Install the module. Then start. Finish setup." });
  expect(mock).toHaveBeenCalledTimes(1);
});

test.each([
  "",
  "not JSON",
  '{"description":"ok"} trailing',
  "[]",
  "{}",
  '{"description":42}',
  '{"description":null}',
  '{"description":"  "}',
  '{"description":"ok","title":"override"}',
])("keeps the billed call when output is unusable (%j)", async (text) => {
  mock.mockResolvedValue({ text, usage });
  const { result } = await post(base, 200);
  expect(result).toEqual({
    entry: { url: base.url, title: "Setup Guide", description: base.content.text },
    usage: [usage],
  });
  expect(mock).toHaveBeenCalledTimes(1);
});

test("can return a metered null when usable input has no extractive fallback", async () => {
  mock.mockResolvedValue({ text: '{"description":null}', usage });
  const { result } = await post(
    { ...base, content: { text: "", markdown: "- List prose only." } },
    200,
  );
  expect(result).toMatchObject({ entry: { description: null }, usage: [usage] });
  expect(mock).toHaveBeenCalledTimes(1);
});

test("preserves the supplied URL and clips the model description by Unicode code points", async () => {
  const description = "e\u0301".repeat(550);
  mock.mockResolvedValue({ text: JSON.stringify({ description }), usage });
  const { result } = await post(
    {
      ...base,
      metadata: { ...base.metadata, canonicalUrl: "https://example.org/canonical" },
    },
    200,
  );
  expect(result).toMatchObject({
    entry: { url: base.url, description: "e\u0301".repeat(499) + "…" },
    usage: [usage],
  });
});

test.each([
  ["Tue, 31 Nov 2026 08:00:00 GMT", undefined],
  ["Wed, 29 Feb 2023 08:00:00 GMT", undefined],
  ["Thu, 29 Feb 2024 08:00:00 GMT", "Thu, 29 Feb 2024 08:00:00 GMT"],
  ["Sunday, 06-Nov-94 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT"],
  ["Sun Nov  6 08:49:37 1994", "Sun Nov  6 08:49:37 1994"],
  ["30", "30"],
  ["0", "0"],
])("handles Retry-After %s on an upstream 429 without retrying", async (header, expected) => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () =>
      Response.json(
        { error: { message: "Synthetic rate limit" } },
        { status: 429, headers: { "Retry-After": header } },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  const { result, headers } = await post(base, 503, provider);
  expect(result).toMatchObject({ status: 503, code: "provider_unavailable" });
  expect(headers["retry-after"]).toBe(expected);
  expect(fetch).toHaveBeenCalledTimes(1);
});
