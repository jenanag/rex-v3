import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";

const htmlLimit = 250_000;
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

function htmlAtBodyLimit(empty, availableBytes) {
  // Start with one byte per character, then use raw and JSON-escaped Unicode
  // to fill the wire body without exceeding the HTML character limit.
  const characters = Math.min(textLength, availableBytes);
  const unicode = Math.min(characters, Math.floor((availableBytes - characters) / 3));
  const extraBytes = availableBytes - characters - 3 * unicode;
  const escaped = Math.min(unicode, Math.floor(extraBytes / 8));
  const text =
    "\\ud83d\\ude00".repeat(escaped) +
    "😀".repeat(unicode - escaped) +
    "a".repeat(characters - unicode);
  // JSON permits trailing whitespace, including when the HTML is already full.
  return empty.replace(html(""), html(text)) + " ".repeat(extraBytes - 8 * escaped);
}

function htmlWorkloads(wrap, bodyLimitBytes) {
  const empty = JSON.stringify(wrap(html("")));
  const overhead = Buffer.byteLength(empty);
  assert.ok(overhead <= bodyLimitBytes, "Body limit is too small for the HTML fixture");
  const intermediateLength = Math.min(
    textLength,
    Math.max(0, Math.floor(bodyLimitBytes / 2) - overhead),
  );
  return [
    ["representative", JSON.stringify(wrap(html("Example article")))],
    ["intermediate (ASCII)", JSON.stringify(wrap(html("a".repeat(intermediateLength))))],
    ["body limit", htmlAtBodyLimit(empty, bodyLimitBytes - overhead)],
  ];
}

function objectWorkloads(wrap, bodyLimitBytes) {
  const overhead = Buffer.byteLength(JSON.stringify(wrap("")));
  assert.ok(overhead <= bodyLimitBytes, "Body limit is too small for the object fixture");
  const intermediateLength = Math.max(0, Math.floor(bodyLimitBytes / 2) - overhead);
  return [
    ["representative", JSON.stringify(wrap("An example article."))],
    ["intermediate", JSON.stringify(wrap("a".repeat(intermediateLength)))],
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
  config: loadConfig({ NODE_ENV: "test", BODY_LIMIT_BYTES: process.env.BODY_LIMIT_BYTES }),
  handlers: { generateSchemaMarkup: captureValidator, validateSchemaMarkup: captureValidator },
  logs: false,
});
const bodyLimitBytes = app.initialConfig.bodyLimit;
const budgetMs = (5 * bodyLimitBytes) / 1_048_576;
const inject = (url, payload) =>
  app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });

try {
  for (const [path, wrap] of [
    [generatePath, generateHtml],
    [validatePath, validateHtml],
  ]) {
    const oversizedHtml = JSON.stringify(wrap(html("a".repeat(textLength + 1))));
    const rejected = await inject(path, oversizedHtml);
    const status = Buffer.byteLength(oversizedHtml) > bodyLimitBytes ? 413 : 400;
    assert.equal(
      rejected.statusCode,
      status,
      `${path} must reject HTML over ${htmlLimit} characters`,
    );
  }

  console.log(`${process.version}, ${platform()}/${arch()}, ${cpus()[0].model}`);
  console.log(
    `Effective body limit ${bodyLimitBytes} bytes | validation budget ${budgetMs} ms p99`,
  );
  console.log(`Request validation p99 (milliseconds, ${samples} samples per workload)`);
  for (const [path, input, workloads] of [
    [generatePath, "HTML", htmlWorkloads(generateHtml, bodyLimitBytes)],
    [generatePath, "structured data", objectWorkloads(generateData, bodyLimitBytes)],
    [validatePath, "HTML", htmlWorkloads(validateHtml, bodyLimitBytes)],
    [validatePath, "JSON-LD", objectWorkloads(validateJsonLd, bodyLimitBytes)],
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
