import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { handlers } from "../dist/src/handlers/index.js";

const path = "/v1/citation-extractions";
const expectedLimit = 4_194_304;
const warmups = 200;
const samples = 1_000;
const control = "\u0001";
const emoji = "😀";

const representative = {
  markdown: "See the [Guide](https://example.org/guide) and [Setup](https://example.org/setup).",
  sources: [
    { url: "https://example.org/guide", title: "Guide", position: 1 },
    { url: "https://example.com/reference", title: "Reference", position: 2 },
  ],
  brands: [
    {
      key: "docs",
      kind: "primary",
      name: "Example Docs",
      aliases: ["Docs"],
      domains: ["example.org"],
    },
    {
      key: "reference",
      kind: "competitor",
      name: "Example Reference",
      aliases: [],
      domains: ["example.com"],
    },
  ],
};

const id = (index, width) => String(index).padStart(width, "0");
const brandDomain = (brand, domain) =>
  [
    id(brand, 2) + id(domain, 2) + "d".repeat(59),
    "e".repeat(63),
    "f".repeat(63),
    "g".repeat(56),
    "test",
  ].join(".");
const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const { CitationExtractionRequest, TrackedBrand, Url } = spec.components.schemas;

function syntheticRequest(character, sourceCount, longSources) {
  return {
    markdown: character.repeat(CitationExtractionRequest.properties.markdown.maxLength),
    sources: Array.from({ length: sourceCount }, (_, index) => {
      const suffix = id(index, 5);
      const url = "https://example.test/s/" + suffix;
      return {
        url: longSources ? (url + "/").padEnd(Url.maxLength, "u") : url,
        title: longSources ? character.repeat(507) + suffix : "Source " + suffix,
        position: index + 1,
      };
    }),
    brands: Array.from(
      { length: CitationExtractionRequest.properties.brands.maxItems },
      (_, index) => ({
        key: character.repeat(TrackedBrand.properties.key.maxLength - 2) + id(index, 2),
        kind: index === 0 ? "primary" : "competitor",
        name: character.repeat(TrackedBrand.properties.name.maxLength - 2) + id(index, 2),
        aliases: Array.from(
          { length: TrackedBrand.properties.aliases.maxItems },
          (_, alias) =>
            character.repeat(TrackedBrand.properties.aliases.items.maxLength - 2) + id(alias, 2),
        ),
        domains: Array.from({ length: TrackedBrand.properties.domains.maxItems }, (_, domain) =>
          brandDomain(index, domain),
        ),
      }),
    ),
  };
}

function p99(validate, request) {
  const timings = [];
  for (let index = 0; index < warmups + samples; index++) {
    const body = { ...request };
    const start = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - start;
    assert.equal(valid, true, "The registered validator must accept the fixture");
    if (index >= warmups) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(samples * 0.99) - 1];
}

const app = createApp({ spec, config: loadConfig(), handlers, logs: false });
let route;
app.addHook("preHandler", async (request) => {
  route = {
    bodyLimit: request.routeOptions.bodyLimit,
    validate: request.getValidationFunction("body"),
  };
});

async function post(payload, status, code) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    payload,
  });
  assert.equal(response.statusCode, status, "POST " + path + " with " + payload.length + " bytes");
  assert.equal(response.json().code, code);
}

try {
  await post(Buffer.from(JSON.stringify(representative)), 501, "not_implemented");
  assert.ok(route, "The representative request must reach the registered route");
  const { bodyLimit, validate } = route;
  assert.equal(bodyLimit, expectedLimit, "Expected the ADR 0033 route limit");
  assert.equal(bodyLimit, app.initialConfig.bodyLimit);
  assert.equal(typeof validate, "function");
  const budget = (5 * bodyLimit) / 1_048_576;

  console.log(
    [process.version, process.platform + "/" + process.arch, cpus()[0]?.model].join(", "),
  );
  console.log(
    "Request validation p99 (" + samples + " samples per workload after " + warmups + " warmups)",
  );
  console.log(
    "POST " +
      path +
      " | effective body limit " +
      bodyLimit +
      " bytes | budget " +
      budget +
      " ms p99",
  );

  const workloads = [
    { name: "representative", request: representative },
    { name: "intermediate", request: syntheticRequest(emoji, 145, true) },
    { name: "exact long strings", request: syntheticRequest(control, 405, true), exact: true },
    {
      name: "exact many short sources",
      request: syntheticRequest("a", 46_000, false),
      exact: true,
    },
  ];
  const boundaries = [];
  for (const { name, request, exact } of workloads) {
    const compact = Buffer.from(JSON.stringify(request), "utf8");
    const padding = exact ? bodyLimit - compact.length : 0;
    assert.ok(padding >= 0 && compact.length <= bodyLimit, name + " must fit the route limit");
    const wire = padding ? Buffer.concat([compact, Buffer.alloc(padding, " ")]) : compact;
    if (exact) {
      assert.equal(wire.length, bodyLimit);
      boundaries.push({ name, wire });
    }

    // Parse once, outside the timed samples. The real route's Ajv validator
    // applies defaults and validates the already-parsed body.
    const measured = p99(validate, JSON.parse(wire.toString("utf8")));
    console.log(
      name +
        " | " +
        wire.length +
        " bytes | " +
        request.sources.length +
        " sources | " +
        padding +
        " padding bytes | p99 " +
        measured.toFixed(4) +
        " ms",
    );
    if (measured >= budget) {
      console.error(name + " must stay below " + budget + " ms p99");
      process.exitCode = 1;
    }
  }

  for (const { name, wire } of boundaries) {
    const oversized = Buffer.concat([wire, Buffer.from(" ")]);
    await post(wire, 501, "not_implemented");
    await post(oversized, 413, "payload_too_large");
    console.log(
      name +
        " | " +
        wire.length +
        " bytes reached stub (501), " +
        oversized.length +
        " bytes rejected (413)",
    );
  }
} finally {
  await app.close();
}
