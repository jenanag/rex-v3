import assert from "node:assert/strict";

const port = Number(process.env.PORT ?? 8080);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, "Expected a valid PORT");
const response = await fetch("http://127.0.0.1:" + port + "/v1/citation-extractions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    markdown: "[A &amp; B](https://example.test/?a=1&amp;b=2)",
    sources: [{ url: "https://docs.example.test/guide#start", position: 1 }],
    brands: [
      {
        key: "docs",
        name: "Example Docs",
        kind: "primary",
        aliases: [],
        domains: ["example.test"],
      },
    ],
  }),
  signal: AbortSignal.timeout(10_000),
});
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), {
  citations: [
    {
      url: "https://docs.example.test/guide",
      domain: "docs.example.test",
      title: null,
      position: 1,
      sourceType: "engine_source",
      ownership: "own",
      brandKey: "docs",
    },
    {
      url: "https://example.test/?a=1&b=2",
      domain: "example.test",
      title: "A & B",
      position: 2,
      sourceType: "inline_link",
      ownership: "own",
      brandKey: "docs",
    },
  ],
});
console.log("Citation extraction HTTP 200 smoke passed");
