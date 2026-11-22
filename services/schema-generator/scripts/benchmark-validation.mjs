import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";

const bodyLimitBytes = 1024 * 1024;
const htmlLimit = 250_000;
const budgetMs = 1;
const warmups = 200;
const samples = 1000;
const generatePath = "/v1/schema-markup";
const validatePath = "/v1/schema-markup/validate";
const html = (text) => `<p>${text}</p>`;
const textLength = htmlLimit - html("").length;
const generateHtml = (html) => ({
  schemaType: "Article",
  source: { html, pageUrl: "https://example.com/article" },
});
const validateHtml = (html) => ({ html });
const generateData = (description) => ({
  schemaType: "Article",
  source: { data: { headline: "Example article", description } },
});
const validateJsonLd = (description) => ({
  jsonLd: {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: "Example article",
    description,
  },
});

function htmlAtBodyLimit(wrap) {
  const empty = JSON.stringify(wrap(html("")));
  // The same Unicode character takes four UTF-8 bytes or twelve JSON escape bytes.
  // Use both spellings to exercise the character limit and the byte limit together.
  const extraBytes = bodyLimitBytes - Buffer.byteLength(empty) - 4 * textLength;
  const escaped = Math.floor(extraBytes / 8);
  const text = "\\ud83d\\ude00".repeat(escaped) + "😀".repeat(textLength - escaped);
  return empty.replace(html(""), html(text)) + " ".repeat(extraBytes % 8);
}

function htmlWorkloads(wrap) {
  return [
    ["representative", JSON.stringify(wrap(html("Example article")))],
    ["HTML character limit (ASCII)", JSON.stringify(wrap(html("a".repeat(textLength))))],
    ["body limit", htmlAtBodyLimit(wrap)],
  ];
}

function objectWorkloads(wrap) {
  const overhead = Buffer.byteLength(JSON.stringify(wrap("")));
  return [
    ["representative", JSON.stringify(wrap("An example article."))],
    ["512 KiB", JSON.stringify(wrap("a".repeat(bodyLimitBytes / 2 - overhead)))],
    ["body limit", JSON.stringify(wrap("a".repeat(bodyLimitBytes - overhead)))],
  ];
}

const compiled = new Map();
async function captureValidator(request, reply) {
  const validate = request.getValidationFunction("body");
  assert.equal(typeof validate, "function", "Expected a Fastify request body validator");
  compiled.set(request.routeOptions.url, validate);
  return reply.code(204).send();
}

function measure(validate, payload) {
  const timings = [];
  for (let i = 0; i < warmups + samples; i++) {
    // Prepare a fresh body so defaults, if present, are applied on every sample.
    const body = JSON.parse(payload);
    const before = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - before;
    assert.equal(valid, true, "Benchmark request body must satisfy its contract");
    if (i >= warmups) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(samples * 0.99) - 1];
}

const app = createApp({
  spec: JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8")),
  config: loadConfig({ NODE_ENV: "test" }),
  handlers: { generateSchemaMarkup: captureValidator, validateSchemaMarkup: captureValidator },
  logs: false,
});
const inject = (url, payload) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });

try {
  assert.equal(app.initialConfig.bodyLimit, bodyLimitBytes);
  for (const [path, wrap] of [
    [generatePath, generateHtml],
    [validatePath, validateHtml],
  ]) {
    const oversizedHtml = JSON.stringify(wrap(html("a".repeat(textLength + 1))));
    const rejected = await inject(path, oversizedHtml);
    assert.equal(rejected.statusCode, 400, `${path} must reject HTML over ${htmlLimit} characters`);
  }

  console.log(`${process.version}, ${platform()}/${arch()}, ${cpus()[0].model}`);
  console.log(`Request validation p99 (milliseconds, ${samples} samples per workload)`);
  for (const [path, input, workloads] of [
    [generatePath, "HTML", htmlWorkloads(generateHtml)],
    [generatePath, "structured data", objectWorkloads(generateData)],
    [validatePath, "HTML", htmlWorkloads(validateHtml)],
    [validatePath, "JSON-LD", objectWorkloads(validateJsonLd)],
  ]) {
    for (const [size, payload] of workloads) {
      const bytes = Buffer.byteLength(payload);
      const label = `POST ${path} | ${input} | ${size} (${bytes} bytes)`;
      const response = await inject(path, payload);
      assert.equal(response.statusCode, 204, `${label}: ${response.body}`);
      if (size === "body limit") {
        assert.equal(bytes, bodyLimitBytes);
        assert.equal((await inject(path, payload + " ")).statusCode, 413, label);
      }

      const p99 = measure(compiled.get(path), payload);
      console.log(`${label} | p99 ${p99.toFixed(4)} ms`);
      if (p99 >= budgetMs) {
        console.error(`${label} exceeded the p99 budget (must be < ${budgetMs} ms)`);
        process.exitCode = 1;
      }
    }
  }
} finally {
  await app.close();
}
