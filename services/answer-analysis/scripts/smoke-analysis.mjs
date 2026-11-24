import assert from "node:assert/strict";

const port = Number(process.env.PORT ?? 8080);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Expected a valid PORT");
const base = "http://127.0.0.1:" + port;

const catalog = await fetch(base + "/v1/analyzers", { signal: AbortSignal.timeout(10_000) });
assert.equal(catalog.status, 200);
assert.deepEqual(
  (await catalog.json()).data.map(({ id, selector, kind, languages }) => ({
    id,
    selector,
    kind,
    languages,
  })),
  ["det:lexicon", "det:rules"].map((id) => ({
    id,
    selector: id,
    kind: "deterministic",
    languages: ["en"],
  })),
);

const analysis = await fetch(base + "/v1/answer-analyses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    text: "Acme is better than Beta.",
    brands: ["Acme", "Beta"].map((name, index) => ({
      key: name.toLowerCase(),
      kind: index ? "competitor" : "primary",
      name,
      aliases: [],
      domains: [],
    })),
    sentiment: { analyzers: ["det:rules"] },
  }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(analysis.status, 200);
const result = await analysis.json();
assert.equal(result.language, "en");
assert.equal(result.languageSource, "detected");
assert.deepEqual(result.usage, []);
assert.deepEqual(
  result.mentions.map(({ brandKey, position, occurrences, sentiment, sentimentScore }) => ({
    brandKey,
    position,
    occurrences,
    sentiment,
    sentimentScore,
  })),
  [
    { brandKey: "acme", position: 1, occurrences: 1, sentiment: "positive", sentimentScore: 0.75 },
    { brandKey: "beta", position: 2, occurrences: 1, sentiment: "negative", sentimentScore: -0.75 },
  ],
);
console.log("Both deterministic routes passed the HTTP 200 smoke check");
