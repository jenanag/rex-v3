import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { createHandlers } from "../dist/src/handlers/index.js";

const path = "/v1/answer-analyses";
const expectedLimit = 3_145_728;
const warmups = 200;
const samples = 1_000;

// The representative and large requests reproduce the ADR 0034 spike workloads.
const brand = {
  key: "acme",
  kind: "primary",
  name: "Acme",
  aliases: ["Acme Co."],
  domains: ["example.com"],
};
const representative = {
  text: "Acme is mentioned in a representative answer. ".repeat(25),
  brands: [brand, { ...brand, key: "other", kind: "competitor", name: "Other" }],
  sentiment: { language: "en-US", analyzers: ["det:lexicon", "det:rules"] },
};
const spikeLarge = {
  text: "a".repeat(200_000),
  brands: Array.from({ length: 50 }, (_, i) => ({
    ...brand,
    key: "brand-" + i,
    kind: i === 0 ? "primary" : "competitor",
    aliases: Array.from({ length: 20 }, (_, j) => "alias-" + j),
    domains: Array.from({ length: 20 }, (_, j) => "host" + j + ".example.com"),
  })),
  sentiment: {},
};

const domains = Array.from({ length: 20 }, (_, i) =>
  [
    "a".repeat(63),
    "b".repeat(63),
    "c".repeat(63),
    "d".repeat(59) + String(i).padStart(2, "0"),
  ].join("."),
);
const analyzers = [
  ...["a", "b", "c", "d"].map((letter) => "det:" + letter.repeat(116)),
  { provider: "openai", model: "e".repeat(90) },
];

function combined(textCharacter, zero, one) {
  return {
    text: textCharacter.repeat(200_000),
    brands: Array.from({ length: 50 }, (_, i) => ({
      // Make the keys distinct while filling every character with the chosen encoding.
      key: i
        .toString(2)
        .padStart(64, "0")
        .replace(/[01]/g, (bit) => (bit === "0" ? zero : one)),
      kind: i === 0 ? "primary" : "competitor",
      name: zero.repeat(100),
      aliases: Array.from({ length: 20 }, () => one.repeat(100)),
      domains,
    })),
    sentiment: {
      analyzers,
      primary: analyzers[0],
      language: "en-12345678-12345678-12345678-12345",
      onUnsupportedLanguage: "fallback",
    },
  };
}

const escaped = combined("\u0001", "\u0000", "\u0001");
const nested = {
  ...escaped,
  brands: [
    { ...escaped.brands[0], extra: { data: "x".repeat(1_033_379) } },
    ...escaped.brands.slice(1),
  ],
};
const workloads = [
  { name: "spike representative", body: representative, bytes: 1_440 },
  { name: "spike large", body: spikeLarge, bytes: 234_874 },
  { name: "combined emoji", body: combined("😀", "😀", "😁"), bytes: 1_495_929 },
  {
    name: "exact padded declared fields",
    body: escaped,
    bytes: 2_112_329,
    padding: 1_033_399,
    exact: true,
  },
  { name: "exact nested brand data", body: nested, bytes: 3_145_728, exact: true },
];

function measure(validate, parsed, name) {
  const timings = [];
  for (let index = 0; index < warmups + samples; index++) {
    // Only sentiment has defaults. Copy it so every call starts with the wire values.
    const body = { ...parsed, sentiment: { ...parsed.sentiment } };
    const start = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - start;
    assert.equal(valid, true, name + " must pass the registered validator");
    assert.equal(body.sentiment.onUnsupportedLanguage, "fallback");
    if (index >= warmups) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(samples * 0.99) - 1];
}

const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const config = loadConfig();
const handlers = createHandlers({ lunaEnabled: config.ANSWER_ANALYSIS_LUNA_ENABLED });
const app = createApp({ spec, config, handlers, logs: false });
let route;
app.addHook("preHandler", async (request) => {
  if (request.routeOptions.config.operationId === "analyzeAnswer") {
    route = {
      bodyLimit: request.routeOptions.bodyLimit,
      validate: request.getValidationFunction("body"),
    };
  }
});

async function post(payload, status, code) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    payload,
  });
  assert.equal(response.statusCode, status, path + " with " + payload.length + " bytes");
  if (code) assert.equal(response.json().code, code);
  return response.json();
}

try {
  const supported = await post(Buffer.from(JSON.stringify(representative)), 200);
  assert.deepEqual(
    supported.analyzers.map(({ analyzer }) => analyzer),
    representative.sentiment.analyzers,
  );
  assert.ok(route, "The representative request must reach the registered route");
  const { bodyLimit, validate } = route;
  assert.equal(bodyLimit, expectedLimit, "Expected the ADR 0036 route limit");
  assert.equal(bodyLimit, app.initialConfig.bodyLimit);
  assert.equal(typeof validate, "function");
  const budget = (5 * bodyLimit) / 1_048_576;
  console.log(
    [process.version, process.platform + "/" + process.arch, cpus()[0]?.model].join(", "),
  );
  console.log(
    "Request validation p99 (%d samples per workload after %d warmups)",
    samples,
    warmups,
  );
  console.log(
    "POST %s | effective body limit %d bytes | budget %d ms p99",
    path,
    bodyLimit,
    budget,
  );

  const boundaries = [];
  for (const { name, body, bytes, padding = 0, exact = false } of workloads) {
    const compact = Buffer.from(JSON.stringify(body), "utf8");
    assert.equal(compact.length, bytes, name + " compact size");
    const wire = padding ? Buffer.concat([compact, Buffer.alloc(padding, " ")]) : compact;
    if (exact) {
      assert.equal(wire.length, bodyLimit, name + " boundary size");
      boundaries.push({ name, wire });
    }

    const parsed = JSON.parse(wire.toString("utf8"));
    const p99 = measure(validate, parsed, name);
    console.log(
      "%s | %d bytes | %d padding bytes | p99 %s ms",
      name,
      wire.length,
      padding,
      p99.toFixed(4),
    );
    if (p99 >= budget) {
      console.error(name + " must stay below " + budget + " ms p99");
      process.exitCode = 1;
    }
  }

  for (const { name, wire } of boundaries) {
    const oversized = Buffer.concat([wire, Buffer.from(" ")]);
    const problem = await post(wire, 422, "unsupported_analyzer");
    assert.match(problem.detail, /^\/sentiment\/analyzers\/0:/);
    await post(oversized, 413, "payload_too_large");
    console.log(
      "%s | %d bytes reached handler (422 unsupported_analyzer), %d bytes rejected (413)",
      name,
      wire.length,
      oversized.length,
    );
  }
} finally {
  await app.close();
}
