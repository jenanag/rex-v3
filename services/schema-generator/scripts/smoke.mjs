import assert from "node:assert/strict";

const port = Number(process.env.PORT ?? "8080");
assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, "PORT must be 1–65535");
const origin = `http://127.0.0.1:${port}`;

async function post(path, body) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `POST ${path}: expected HTTP 200`);
  return response.json();
}

const schemaType = "Organization";
const name = "Example Organization";
const generated = await post("/v1/schema-markup", { schemaType, source: { data: { name } } });
assert.equal(generated.jsonLd?.["@type"], schemaType, "Expected Organization JSON-LD");
assert.equal(generated.jsonLd?.name, name, "Expected the supplied organization name");
assert.equal(generated.validation?.valid, true, "Expected valid generated markup");
console.log(`POST /v1/schema-markup: HTTP 200, valid ${schemaType} markup for "${name}"`);

const validation = await post("/v1/schema-markup/validate", { jsonLd: generated.jsonLd });
assert.equal(validation.valid, true, "Expected the generated JSON-LD to validate");
assert.deepEqual(validation.issues, [], "Expected no validation issues");
console.log("POST /v1/schema-markup/validate: HTTP 200, valid: true, issues: []");
