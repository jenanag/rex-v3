import assert from "node:assert/strict";

const prompt =
  "What does the Parks Canada Discovery Pass cover? Cite two official Parks Canada pages in your answer.";
const sourceUrl = "https://www.parks.canada.ca/termes-terms/reservation?utm_source=openai";
const brandKey = "parks-canada";
const brands = [
  {
    key: brandKey,
    kind: "primary",
    name: "Parks Canada",
    aliases: [],
    domains: ["parks.canada.ca"],
  },
];

async function post(stage, port, path, payload, verify) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 200, `expected HTTP 200, received HTTP ${response.status}`);
    return verify(await response.json());
  } catch (error) {
    const detail = error.cause?.message ?? error.message;
    throw new Error(`${stage} (${path}): ${detail}`, { cause: error });
  }
}

try {
  const { answer, usage } = await post(
    "Query",
    18081,
    "/v1/engine-answers",
    { engine: "chatgpt", webSearch: true, locale: "en-CA", country: "CA", prompt },
    ({ answer, usage }) => {
      assert.ok(
        typeof answer?.text === "string" && answer.text.trim(),
        "expected nonblank Markdown",
      );
      const source = answer.sources?.find(({ url }) => url === sourceUrl);
      assert.equal(source?.title, "Reservation policies", "expected the recorded source title");
      assert.equal(source.position, 1, "expected the recorded source at position 1");
      assert.equal(usage?.length, 1, "expected one usage item");
      assert.equal(usage[0].operation, "answer_prompt", "expected answer_prompt usage");
      assert.equal(usage[0].costMicrosUsd, 11_099, "expected the recorded 11,099-microdollar cost");
      return { answer, usage };
    },
  );
  console.log(`Query HTTP 200 | ${usage[0].costMicrosUsd} microdollars | ${sourceUrl}`);

  const mention = await post(
    "Analyze",
    18082,
    "/v1/answer-analyses",
    { text: answer.text, brands, sentiment: { analyzers: ["det:lexicon"], language: "en" } },
    ({ analyzers, mentions, usage }) => {
      assert.ok(
        analyzers?.some(({ analyzer, status }) => analyzer === "det:lexicon" && status === "ok"),
        "expected det:lexicon to run successfully",
      );
      const mention = mentions?.find((item) => item.brandKey === brandKey);
      assert.ok(
        Number.isInteger(mention?.occurrences) && mention.occurrences > 0,
        "expected a positive Parks Canada mention count",
      );
      assert.deepEqual(usage, [], "expected empty analysis usage");
      return mention;
    },
  );
  console.log(`Analyze HTTP 200 | ${brandKey} occurrences: ${mention.occurrences} | usage: []`);

  const citation = await post(
    "Extract",
    18083,
    "/v1/citation-extractions",
    { markdown: answer.text, sources: answer.sources, brands },
    ({ citations }) => {
      const citation = citations?.find(({ url }) => url === sourceUrl);
      assert.ok(citation, "expected the recorded Reservation policies URL");
      assert.equal(citation.sourceType, "engine_source", "expected an engine-source citation");
      assert.equal(citation.position, 1, "expected the citation at position 1");
      assert.equal(citation.ownership, "own", "expected own ownership");
      assert.equal(citation.brandKey, brandKey, "expected the Parks Canada brand key");
      return citation;
    },
  );
  console.log(
    `Extract HTTP 200 | ${citation.url} | ${citation.sourceType} #${citation.position} | ${citation.ownership} (${citation.brandKey})`,
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
