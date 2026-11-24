import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { createHandlers } from "../dist/src/handlers/index.js";

const path = "/v1/engine-answers";
const expectedLimit = 1_048_576;
const warmups = 200;
const samples = 1_000;
const representative = { engine: "chatgpt", prompt: "What is REx?" };
const fullPrompt = {
  engine: "perplexity",
  prompt: "😀".repeat(2_000),
  locale: "eng-US",
  country: "US",
};
const escaped = Buffer.from(JSON.stringify({ ...fullPrompt, prompt: "\u0001".repeat(2_000) }));
const padding = 1_036_508;
assert.equal(escaped.length, 12_068);
const exact = Buffer.concat([escaped, Buffer.alloc(padding, " ")]);
const workloads = [
  { name: "representative", wire: Buffer.from(JSON.stringify(representative)) },
  { name: "full prompt with optional fields", wire: Buffer.from(JSON.stringify(fullPrompt)) },
  { name: "exact limit", wire: exact },
];

function measure(validate, parsed, name) {
  const timings = [];
  for (let index = 0; index < warmups + samples; index++) {
    const body = { ...parsed };
    const start = performance.now();
    const valid = validate(body);
    const elapsed = performance.now() - start;
    assert.equal(valid, true, name + " must pass the registered validator");
    assert.equal(body.locale, parsed.locale ?? "en-US");
    assert.equal(body.country, parsed.country ?? "US");
    if (index >= warmups) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(samples * 0.99) - 1];
}

const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const config = loadConfig();
assert.equal(config.BODY_LIMIT_BYTES, undefined, "Run with BODY_LIMIT_BYTES unset");
const app = createApp({ spec, config, handlers: createHandlers(spec, config), logs: false });
let route;
app.addHook("preHandler", async (request) => {
  if (request.routeOptions.config.operationId === "queryEngine") {
    route = {
      bodyLimit: request.routeOptions.bodyLimit,
      validate: request.getValidationFunction("body"),
    };
  }
});

async function post(wire, status, code) {
  const response = await app.inject({
    method: "POST",
    url: path,
    headers: { "content-type": "application/json", "content-length": String(wire.length) },
    payload: wire,
  });
  assert.equal(response.statusCode, status, path + " with " + wire.length + " bytes");
  assert.equal(response.json().code, code);
  console.log("POST %s | %d bytes | HTTP %d %s", path, wire.length, status, code);
}

try {
  await post(exact, 422, "unsupported_engine");
  assert.ok(route, "The exact-limit request must reach the registered route");
  const { bodyLimit, validate } = route;
  assert.equal(typeof validate, "function");
  assert.equal(bodyLimit, app.initialConfig.bodyLimit);
  assert.equal(bodyLimit, expectedLimit);
  assert.equal(exact.length, bodyLimit);
  const budget = (5 * bodyLimit) / 1_048_576;
  console.log(
    `Node ${process.version} on ${process.platform}/${process.arch} (${cpus()[0]?.model})`,
  );
  console.log(`Request validation p99 (${samples} samples after ${warmups} warmups per workload)`);
  console.log(`POST ${path} | effective body limit ${bodyLimit} bytes | budget ${budget} ms p99`);
  console.log("Exact fixture | %d compact bytes | %d padding bytes", escaped.length, padding);

  const measured = workloads.map(({ name, wire }) => {
    const parsed = JSON.parse(wire.toString("utf8"));
    const p99 = measure(validate, parsed, name);
    console.log(`${name} | ${wire.length} bytes | p99 ${p99.toFixed(4)} ms`);
    return { name, p99 };
  });

  await post(Buffer.concat([exact, Buffer.from(" ")]), 413, "payload_too_large");
  const overBudget = measured.filter(({ p99 }) => p99 >= budget);
  assert.deepEqual(overBudget, [], `Each workload must stay below ${budget} ms p99`);
} finally {
  await app.close();
}
