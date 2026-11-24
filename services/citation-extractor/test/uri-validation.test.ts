import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { afterAll, expect, test } from "vitest";
import { parse } from "yaml";
import { createApp } from "../src/app.js";
import { addFormats, validators, type ToolSpec } from "../src/contract.js";
import { handlers } from "../src/handlers/index.js";
import { checkResponse, config, tool } from "./support.js";

const spec = parse(
  readFileSync(new URL("../contract/openapi.yaml", import.meta.url), "utf8"),
) as ToolSpec;
const path = "/v1/citation-extractions";
const app = tool();
afterAll(() => app.close());

const ordinary = [
  "https://example.test/s/00000",
  "https://example.test/s/45999",
  "http://Example.test",
  "https://sub-domain.example.test/a_b/~v1.2/",
  "http://localhost/",
  "http://127.0.0.1/a//b",
  "https://example.test/" + "a".repeat(2_027),
];

const edges = [
  "https://example.test/?q=a%20b#fragment",
  "https://example.test/a%2Fb",
  "https://example.test:65536/",
  "https://user:pass@example.test/",
  "https://[2001:db8::1]:8443/",
  "https://[v1.a]/",
  "https://example.test./",
  "https://xn--bcher-kva.example/",
  "http:///path",
  "https://",
  "urn:example:item",
];

const malformed = [
  "not-a-uri",
  "/relative/path",
  "https://example.test/a b",
  "https://example.test/a\n",
  "https://example.test/a\r",
  "https://example.test/a\t",
  "https://example.test/a\u2028",
  "https://example.test/a\u0000",
  "https://example.test/a\\b",
  "https://example.test/a%2",
  "https://example.test/a%gg",
  "https://example.test/café",
  "https://[::zz]/",
  "https://example.test:port/",
  "https://example.test/?q={bad}",
];

const baseline = new Ajv2020({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  useDefaults: true,
});
addFormats(baseline);
const optimized = validators(spec, true);
const uri = { type: "string", format: "uri" };

test("matches the pinned Ajv format on ordinary, edge, and malformed URI inputs", () => {
  const original = baseline.compile(uri);
  const current = optimized(uri);
  for (const value of [...ordinary, ...edges, ...malformed]) {
    expect(current(value), JSON.stringify(value)).toBe(original(value));
    expect(current.errors).toEqual(original.errors);
  }
  // Exercise every ASCII character in the authority, path and suffix,
  // including characters adjacent to the fast subset and all controls.
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code);
    for (const value of [
      "https://a" + char + "b.example.test/path",
      "https://example.test/a" + char + "b",
      "https://example.test/path" + char,
    ]) {
      expect(current(value), JSON.stringify(value)).toBe(original(value));
    }
  }
});

test.each([
  ["https://example.test/guide", 501, []],
  ["https://example.test/?q=a%20b#fragment", 501, []],
  ["https://[2001:db8::1]:8443/", 501, []],
  ["https://example.test:65536/", 501, []],
  ["https://example.test/a%2", 400, ['must match format "uri"']],
  ["https://example.test/a\n", 400, ['must match format "uri"']],
  ["urn:example:item", 400, ['must match pattern "^https?://"']],
  [200, 400, ["must be string"]],
])("keeps extraction validation and shared problems for %j", async (url, status, details) => {
  const response = await app.inject({
    method: "POST",
    url: path,
    payload: { markdown: "", sources: [{ url, position: 1 }], brands: [] },
  });
  expect(response.statusCode).toBe(status);
  const body = response.json();
  checkResponse("POST", path, status, "application/problem+json", body);
  expect(body.code).toBe(status === 501 ? "not_implemented" : "validation_failed");
  if (status === 400) {
    expect(body.errors).toEqual(details.map((detail) => ({ pointer: "/sources/0/url", detail })));
  }
});

test("the registered validator still applies schema defaults before the handler", async () => {
  const withDefault = structuredClone(spec);
  const schema = withDefault.components?.schemas?.CitationExtractionRequest as {
    properties: { markdown: { default?: string } };
  };
  schema.properties.markdown.default = "default answer";
  const app = createApp({ spec: withDefault, config, handlers, logs: false });
  let body;
  app.addHook("preHandler", async (request) => {
    body = request.body;
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: path,
      payload: { sources: [{ url: "https://example.test/guide", position: 1 }], brands: [] },
    });
    expect(response.statusCode).toBe(501);
    expect(body).toMatchObject({ markdown: "default answer" });
  } finally {
    await app.close();
  }
});
