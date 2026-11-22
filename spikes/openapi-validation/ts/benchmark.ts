import assert from "node:assert/strict";
import { cpus, platform, arch } from "node:os";
import { analysisPath } from "./contract.ts";
import { server, type Candidate } from "./spike.ts";

const budgetMs = 1;
const ordinaryBrand = {
  key: "acme",
  kind: "primary",
  name: "Acme",
  aliases: ["Acme Co."],
  domains: ["example.com"],
};
const ordinary = {
  text: "Acme is mentioned in a representative answer. ".repeat(25),
  brands: [ordinaryBrand, { ...ordinaryBrand, key: "other", kind: "competitor", name: "Other" }],
  sentiment: { language: "en-US", analyzers: ["det:lexicon", "det:rules"] },
};
const large = {
  text: "a".repeat(200_000),
  brands: Array.from({ length: 50 }, (_, i) => ({
    ...ordinaryBrand,
    key: "brand-" + i,
    kind: i === 0 ? "primary" : "competitor",
    aliases: Array.from({ length: 20 }, (_, j) => "alias-" + j),
    domains: Array.from({ length: 20 }, (_, j) => "host" + j + ".example.com"),
  })),
  sentiment: {},
};

async function measure(candidate: Candidate, payload: object, warm: number, iterations: number) {
  const timings: number[] = [];
  const app = await server({ candidate, measure: (elapsed) => timings.push(elapsed) });
  const request = {
    method: "POST" as const,
    url: analysisPath,
    headers: { "content-type": "application/json" },
    payload: JSON.stringify(payload),
  };
  try {
    for (let i = 0; i < warm + iterations; i++) {
      const response = await app.inject(request);
      assert.equal(response.statusCode, 200, response.body);
    }
    assert.equal(timings.length, warm + iterations);
    const measured = timings.slice(warm).sort((a, b) => a - b);
    const percentile = (p: number) => measured[Math.ceil(iterations * p) - 1];
    return { p50: percentile(0.5), p99: percentile(0.99) };
  } finally {
    await app.close();
  }
}

console.log(process.version + ", " + platform() + "/" + arch() + ", " + cpus()[0].model);
console.log(
  "Request-validation overhead in milliseconds (startup, JSON parsing, handler and serialization excluded)",
);
for (const candidate of ["glue", "loader"] as const) {
  for (const [name, payload, warm, measured] of [
    ["representative", ordinary, 500, 5_000],
    ["200k chars, 50 brands", large, 200, 1_000],
  ] as const) {
    const { p50, p99 } = await measure(candidate, payload, warm, measured);
    console.log(
      candidate +
        " | " +
        name +
        " | n=" +
        measured +
        " | p50 " +
        p50.toFixed(4) +
        " | p99 " +
        p99.toFixed(4),
    );
    if (candidate === "loader" && p99 >= budgetMs) process.exitCode = 1;
  }
}
