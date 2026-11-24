import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const port = Number(process.env.PORT ?? 8080);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Expected a valid PORT");
const base = "http://127.0.0.1:" + port;

const recording = JSON.parse(
  readFileSync(
    new URL(
      "../test/fixtures/llm/eee682d9aaea2927aedbbcdf861abeeeb123a5734b4e42b5d909c42bbf9802d1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const recordedText = recording.output
  .find(({ type }) => type === "message")
  ?.content.find(({ type }) => type === "output_text");
const recordedCitation = recordedText?.annotations.find(({ type }) => type === "url_citation");
assert.ok(recordedCitation, "Expected a URL citation in the Parks Canada recording");

const discovery = await fetch(base + "/v1/engines", { signal: AbortSignal.timeout(10_000) });
assert.equal(discovery.status, 200, "GET /v1/engines must return HTTP 200");
const { data: engines } = await discovery.json();
assert.ok(Array.isArray(engines), "GET /v1/engines must return an engine list");
assert.deepEqual(
  engines.filter(({ enabled }) => enabled === true),
  [
    {
      id: "chatgpt",
      displayName: "ChatGPT",
      provider: "openai",
      model: "gpt-6-luna",
      webSearch: true,
      enabled: true,
    },
    {
      id: "gemini",
      displayName: "Gemini",
      provider: "google",
      model: "gemini-3.5-flash-lite",
      webSearch: false,
      enabled: true,
    },
  ],
  "GET /v1/engines must list ChatGPT with search capability and text-only Gemini",
);
console.log("GET /v1/engines smoke passed (HTTP 200)");

const response = await fetch(base + "/v1/engine-answers", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    engine: "chatgpt",
    locale: "en-CA",
    country: "CA",
    prompt:
      "What does the Parks Canada Discovery Pass cover? Cite two official Parks Canada pages in your answer.",
  }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200, "POST /v1/engine-answers must return HTTP 200");
const { answer, usage } = await response.json();
assert.equal(answer?.engine, "chatgpt", "Expected the ChatGPT answer");
assert.equal(answer.model, "gpt-6-luna", "Expected the recorded GPT-6 Luna model");
assert.equal(answer.text, recordedText.text, "Expected the recorded answer Markdown");
assert.deepEqual(
  answer.sources,
  [{ url: recordedCitation.url, title: recordedCitation.title, position: 1 }],
  "Expected the recorded source at position 1",
);
assert.deepEqual(
  usage,
  [
    {
      provider: "openai",
      model: "gpt-6-luna",
      operation: "answer_prompt",
      inputTokens: 8_563,
      outputTokens: 268,
      costMicrosUsd: 11_099,
    },
  ],
  "Expected the recorded answer_prompt usage",
);
console.log("POST /v1/engine-answers smoke passed (HTTP 200)");
