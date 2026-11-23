import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { handlers } from "../dist/src/handlers/index.js";

const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const app = createApp({
  spec,
  config: loadConfig(),
  handlers: {
    ...handlers,
    generateLlmsTxt: async (_request, reply) => reply.code(204).send(),
    validateLlmsTxt: async (_request, reply) => reply.code(204).send(),
  },
  logs: false,
});
const bodyLimit = app.initialConfig.bodyLimit;
const budgetMs = (5 * bodyLimit) / 1_048_576;
const warmups = 200;
const samples = 1_000;

const siteUrl = "https://example.com/";
const describePath = "/v1/llms-txt/page-entries";
const generatePath = "/v1/llms-txt";
const validatePath = "/v1/llms-txt/validate";
const smallMarkdown =
  "# Example\n\n> A short site guide.\n\n## Docs\n\n- [Guide](https://example.com/guide)\n";
// Stress fixture with a six-byte JSON representation per character.
const escaped = "\u0001";
const { ExtractedContent, LlmsTxtEntry, LlmsTxtValidateRequest, FetchedFile } =
  spec.components.schemas;
const textCap = ExtractedContent.properties.text.maxLength;
const markdownCap = ExtractedContent.properties.markdown.maxLength;
const inlineCap = LlmsTxtValidateRequest.oneOf.find(({ properties }) => properties.content)
  .properties.content.maxLength;
const fileCap = FetchedFile.properties.content.maxLength;

const describe = (text, markdown) => ({
  url: siteUrl,
  metadata: {
    title: "Example",
    description: "A short site guide.",
    language: "en",
    canonicalUrl: siteUrl,
  },
  content: { text, markdown },
});
const entry = (url = siteUrl, title = "Example", description = "A short site guide.") => ({
  entry: { url, title, description },
});
const assemble = (pages) => ({ siteUrl, pages });
const withMarkdown = (markdown) => ({
  includeFull: true,
  ...assemble([
    { ...entry(), markdown },
    { ...entry(`${siteUrl}guide`, "Guide"), markdown: smallMarkdown },
  ]),
});
const inline = (content) => ({ content });
const fetched = (content) => ({ file: { url: `${siteUrl}llms.txt`, status: 200, content } });

function fillWithEntries(targetBytes) {
  const title = escaped.repeat(LlmsTxtEntry.properties.title.maxLength);
  const description = escaped.repeat(LlmsTxtEntry.properties.description.maxLength);
  const pages = [];
  let bytes = Buffer.byteLength(JSON.stringify(assemble(pages)));
  for (let index = 0; ; index++) {
    const page = entry(`${siteUrl}guide/${index}`, title, description);
    const entryBytes = Buffer.byteLength(JSON.stringify(page)) + (index === 0 ? 0 : 1);
    if (bytes + entryBytes > targetBytes) return assemble(pages);
    pages.push(page);
    bytes += entryBytes;
  }
}

function fillWithMarkdown(targetBytes) {
  const prefix = "# Guide\n\n";
  const overhead = Buffer.byteLength(JSON.stringify(withMarkdown(prefix)));
  return withMarkdown(prefix + "a".repeat(targetBytes - overhead));
}

function serialize(request, exactLimit) {
  const json = JSON.stringify(request);
  if (!exactLimit) return Buffer.from(json);
  const bytes = Buffer.byteLength(json);
  assert.ok(bytes <= bodyLimit, "Fixture must fit before padding");
  // Keep bounded string fields at their schema limits and fill only the wire envelope.
  return Buffer.from(json + " ".repeat(bodyLimit - bytes));
}

const routeValidators = new Map();
app.addHook("preHandler", async (request) => {
  const validate = request.getValidationFunction("body");
  assert.equal(typeof validate, "function", "Expected the registered Fastify body validator");
  routeValidators.set(request.routeOptions.url, validate);
});

function p99(validate, request, expectedDefaults, label) {
  const timings = [];
  const beforeValidation = JSON.stringify(request);
  const defaults = Object.entries(expectedDefaults);
  for (let index = 0; index < warmups + samples; index++) {
    // Give the validator a fresh root for the request's top-level defaults.
    // Reuse the prepared nested data to avoid allocation pressure from deep copies.
    const body = { ...request };
    const start = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - start;
    assert.equal(valid, true, `${label} must satisfy the request schema`);
    for (const [key, value] of defaults) {
      assert.equal(body[key], value, `${label} must apply the ${key} default`);
    }
    if (index >= warmups) timings.push(elapsed);
  }
  assert.ok(JSON.stringify(request) === beforeValidation, `${label} mutated the prepared fixture`);
  return timings.sort((a, b) => a - b)[Math.ceil(samples * 0.99) - 1];
}

function post(url, payload) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    payload,
  });
}

try {
  assert.equal(bodyLimit, 12_582_912, "Expected the ADR 0029 body limit");
  console.log(`${process.version}, ${platform()}/${arch()}, ${cpus()[0].model}`);
  console.log(`Effective body limit ${bodyLimit} bytes | validation budget ${budgetMs} ms p99`);
  console.log(`Request validation p99 (${samples} samples per workload after ${warmups} warmups)`);

  const midpoint = bodyLimit / 2;
  const workloads = [
    {
      path: describePath,
      shape: "text and Markdown",
      defaults: { summarizer: "llm" },
      representative: describe("A short site guide.", smallMarkdown),
      intermediate: describe(escaped.repeat(textCap / 2), escaped.repeat(markdownCap / 2)),
      exact: describe(escaped.repeat(textCap), escaped.repeat(markdownCap)),
    },
    {
      path: generatePath,
      shape: "entries only",
      defaults: { includeFull: false },
      representative: assemble([entry()]),
      intermediate: fillWithEntries(midpoint),
      exact: fillWithEntries(bodyLimit),
    },
    {
      path: generatePath,
      shape: "with Markdown",
      representative: withMarkdown(smallMarkdown),
      intermediate: fillWithMarkdown(midpoint),
      exact: fillWithMarkdown(bodyLimit),
    },
    {
      path: validatePath,
      shape: "inline file",
      representative: inline(smallMarkdown),
      intermediate: inline(escaped.repeat(inlineCap / 2)),
      exact: inline(escaped.repeat(inlineCap)),
    },
    {
      path: validatePath,
      shape: "fetched file",
      representative: fetched(smallMarkdown),
      intermediate: fetched(escaped.repeat(fileCap / 2)),
      exact: fetched(escaped.repeat(fileCap)),
    },
  ];

  for (const { path, shape, defaults = {}, ...requests } of workloads) {
    for (const [size, request] of Object.entries(requests)) {
      const payload = serialize(request, size === "exact");
      const label = `POST ${path} | ${shape} | ${size} (${payload.length} bytes)`;
      const response = await post(path, payload);
      const expectedStatus = path === describePath ? 501 : 204;
      assert.equal(response.statusCode, expectedStatus, `${label} should reach its handler`);
      if (expectedStatus === 501) assert.equal(response.json().code, "not_implemented", label);

      let boundary = "";
      if (size === "exact") {
        assert.equal(payload.length, bodyLimit, label);
        const oversized = Buffer.concat([payload, Buffer.from(" ")]);
        const rejected = await post(path, oversized);
        assert.equal(rejected.statusCode, 413, `${label} plus one byte`);
        assert.equal(rejected.json().code, "payload_too_large", label);
        boundary = ` | exact reached handler (${expectedStatus}), ${oversized.length} bytes rejected (413)`;
      }

      const validate = routeValidators.get(path);
      assert.equal(typeof validate, "function", label);
      const elapsed = p99(validate, JSON.parse(payload.toString("utf8")), defaults, label);
      console.log(`${label} | p99 ${elapsed.toFixed(4)} ms${boundary}`);
      if (elapsed >= budgetMs) {
        console.error(`${label} must stay below ${budgetMs} ms p99`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  await app.close();
}
