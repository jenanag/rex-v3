import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";
import { handlers } from "../dist/src/handlers/index.js";

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
    if (index >= warmups) timings.push(elapsed);
  }
  timings.sort((left, right) => left - right);
  return timings[Math.ceil(samples * 0.99) - 1];
}

const spec = JSON.parse(readFileSync(new URL("../dist/contract.json", import.meta.url), "utf8"));
const config = loadConfig();
assert.equal(config.BODY_LIMIT_BYTES, undefined, "Run with BODY_LIMIT_BYTES unset");
const app = createApp({ spec, config, handlers, logs: false });
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
  await post(workloads[0].wire, 501, "not_implemented");
  assert.ok(route, "The representative request must reach the registered route");
  const { bodyLimit, validate } = route;
  assert.equal(typeof validate, "function");
  assert.equal(bodyLimit, app.initialConfig.bodyLimit);
  assert.equal(bodyLimit, expectedLimit);
  assert.equal(exact.length, bodyLimit);
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
  console.log("Exact fixture | %d compact bytes | %d padding bytes", escaped.length, padding);

  for (const { name, wire } of workloads) {
    const parsed = JSON.parse(wire.toString("utf8"));
    const p99 = measure(validate, parsed, name);
    console.log("%s | %d bytes | p99 %s ms", name, wire.length, p99.toFixed(4));
    if (p99 >= budget) {
      console.error(name + " must stay below " + budget + " ms p99");
      process.exitCode = 1;
    }
  }

  await post(exact, 501, "not_implemented");
  await post(Buffer.concat([exact, Buffer.from(" ")]), 413, "payload_too_large");
} finally {
  await app.close();
}
