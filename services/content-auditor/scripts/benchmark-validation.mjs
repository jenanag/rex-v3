import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { arch, cpus, platform } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { handlers } from "../dist/src/handlers/index.js";

const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const app = createApp({ spec, config: loadConfig(), handlers, logs: false });
const warmups = 200;
const samples = 1_000;

const siteUrl = "https://example.org/";
const pageUrl = siteUrl + "guide";
const rules = "User-agent: *\nDisallow: /private/\n";
const { FetchedPage, ExtractedContent, FetchedFile } = spec.components.schemas;
const htmlCap = FetchedPage.properties.html.maxLength;
const textCap = ExtractedContent.properties.text.maxLength;
const markdownCap = ExtractedContent.properties.markdown.maxLength;
const fileCap = FetchedFile.properties.content.maxLength;
const headers = FetchedPage.properties.headers;

const crawlerFile = (content) => ({ url: siteUrl + "robots.txt", status: 200, content });
const crawlerRequest = (content) => ({ siteUrl, robotsTxt: crawlerFile(content) });
const robotsWithComment = (character, length) =>
  rules + "# " + character.repeat(length - rules.length - 3) + "\n";

const representativeAudit = {
  url: pageUrl,
  page: {
    finalUrl: pageUrl,
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    html: "<main><h1>Guide</h1><p>Setup instructions.</p></main>",
  },
  content: { text: "Setup instructions.", markdown: "# Guide\n\nSetup instructions." },
  robotsTxt: crawlerFile(rules),
  llmsTxt: { valid: true, found: true, url: siteUrl + "llms.txt", httpStatus: 200, issues: [] },
};

function largeAudit(divisor) {
  const html = "<p>" + "😀".repeat(htmlCap / divisor - 7) + "</p>";
  const markdown = "## Guide\n\nSetup instructions.\n\n";
  const headerValue = "a".repeat(headers.additionalProperties.maxLength);
  return {
    ...representativeAudit,
    page: {
      ...representativeAudit.page,
      html,
      headers: Object.fromEntries(
        Array.from({ length: headers.maxProperties / divisor }, (_, index) => [
          "x-fixture-" + index,
          headerValue,
        ]),
      ),
    },
    content: {
      text: "😀".repeat(textCap / divisor),
      markdown: markdown + "😀".repeat(markdownCap / divisor - markdown.length),
    },
    robotsTxt: crawlerFile(robotsWithComment("😀", fileCap / divisor)),
  };
}

const routes = new Map();
app.addHook("preHandler", async (request) => {
  const { url, bodyLimit } = request.routeOptions;
  routes.set(url, { bodyLimit, validate: request.getValidationFunction("body") });
});

async function post(url, payload, status, problemCode) {
  const response = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    payload,
  });
  assert.equal(response.statusCode, status, "POST " + url + " with " + payload.length + " bytes");
  if (problemCode) assert.equal(response.json().code, problemCode);
  else if (url === "/v1/audits") assert.equal(typeof response.json().score, "number");
  else {
    const result = response.json();
    assert.ok(result.crawlers.length > 0);
    assert.ok(result.crawlers.every(({ access }) => access === "partial"));
  }
}

function p99(validate, request) {
  const timings = [];
  for (let index = 0; index < warmups + samples; index++) {
    // Prep a fresh root for Ajv's default application before starting the clock.
    const body = { ...request };
    const start = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - start;
    assert.equal(valid, true, "Expected the registered validator to accept the fixture");
    if (index >= warmups) timings.push(elapsed);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.ceil(samples * 0.99) - 1];
}

function serialize(request, limit) {
  const wire = Buffer.from(JSON.stringify(request), "utf8");
  if (limit === undefined) return wire;
  assert.ok(wire.length <= limit, "Exact-limit fixture must fit before whitespace padding");
  const exact = Buffer.alloc(limit, " ");
  wire.copy(exact);
  return exact;
}

async function benchmark(url, expectedLimit, workload) {
  // The normal route supplies both its compiled validator and its effective limit.
  await post(url, serialize(workload.representative), 200);
  const route = routes.get(url);
  assert.ok(route, "Expected the request to reach preHandler");
  const { bodyLimit, validate } = route;
  assert.equal(bodyLimit, expectedLimit, "Expected the ADR 0031 route limit");
  assert.equal(typeof validate, "function");
  const budget = (5 * bodyLimit) / 1_048_576;
  console.log(
    "POST " +
      url +
      " | effective body limit " +
      bodyLimit +
      " bytes | budget " +
      budget +
      " ms p99",
  );

  const exact = serialize(workload.exact, bodyLimit);
  assert.equal(exact.length, bodyLimit);
  for (const [size, payload] of [
    ["representative", serialize(workload.representative)],
    ["intermediate", serialize(workload.intermediate)],
    ["exact", exact],
  ]) {
    // Match Fastify's parsed body without charging JSON parsing to the validator.
    const measured = p99(validate, JSON.parse(payload.toString("utf8")));
    const label = "POST " + url + " | " + size + " (" + payload.length + " bytes)";
    console.log(label + " | p99 " + measured.toFixed(4) + " ms");
    if (measured >= budget) {
      console.error(label + " must stay below " + budget + " ms p99");
      process.exitCode = 1;
    }
  }
  return { url, exact };
}

async function verifyBoundary({ url, exact }) {
  const oversized = Buffer.concat([exact, Buffer.from(" ")]);
  await post(url, exact, 200);
  await post(url, oversized, 413, "payload_too_large");
  console.log(
    "POST " +
      url +
      " | exact " +
      exact.length +
      " bytes reached handler (200), " +
      oversized.length +
      " bytes rejected (413)",
  );
}

try {
  console.log(process.version + ", " + platform() + "/" + arch() + ", " + cpus()[0].model);
  console.log(
    "Request validation p99 (" + samples + " samples per workload after " + warmups + " warmups)",
  );
  const audit = await benchmark("/v1/audits", 25_165_824, {
    representative: representativeAudit,
    intermediate: largeAudit(2),
    exact: largeAudit(1),
  });
  // A JSON-escaped control character occupies six UTF-8 bytes on the wire.
  const crawler = await benchmark("/v1/crawler-checks", 3_145_728, {
    representative: crawlerRequest(rules),
    intermediate: crawlerRequest(robotsWithComment("\u0001", fileCap / 2)),
    exact: crawlerRequest(robotsWithComment("\u0001", fileCap)),
  });
  // Probe the real large-request handlers after timing both warmed validators.
  await verifyBoundary(audit);
  await verifyBoundary(crawler);
} finally {
  await app.close();
}
