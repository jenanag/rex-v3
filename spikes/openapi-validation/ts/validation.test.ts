import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { analysisPath, loadSpec, validator, type Operation } from "./contract.ts";
import { responseExample, responseValidator, server } from "./spike.ts";

type Case = {
  name: string;
  body: unknown;
  status: number;
  pointers?: string[];
  sentiment?: Record<string, unknown>;
  supplement?: boolean;
};

const cases: Case[] = JSON.parse(
  readFileSync(new URL("../request-cases.json", import.meta.url), "utf8"),
);
assert.equal(cases.length, 25);
const operation = loadSpec().paths[analysisPath].post as Operation;
const responseCheck = responseValidator(loadSpec(), operation, "200", "application/json");
const problemCheck = responseValidator(loadSpec(), operation, "400", "application/problem+json");

for (const candidate of ["glue", "loader"] as const) {
  test(candidate + " validates all 25 requests from the common fixture", async (t) => {
    let request: unknown;
    const received = (body: unknown) => {
      request = body;
    };
    const plain = await server({ candidate, received });
    t.after(() => plain.close());
    const supplemental = await server({ candidate, spec: loadSpec(true), received });
    t.after(() => supplemental.close());
    for (const example of cases) {
      await t.test(example.name, async () => {
        request = undefined;
        const response = await (example.supplement ? supplemental : plain).inject({
          method: "POST",
          url: analysisPath,
          headers: { "content-type": "application/json" },
          payload: JSON.stringify(example.body),
        });
        assert.equal(response.statusCode, example.status, response.body);
        if (example.status === 400) {
          assert.equal(request, undefined);
          assert.match(response.headers["content-type"]!, /^application\/problem\+json\b/);
          const problem = response.json<{
            code: string;
            traceId: string;
            errors: { pointer: string }[];
          }>();
          assert.ok(problemCheck(problem), JSON.stringify(problemCheck.errors));
          assert.equal(problem.code, "validation_failed");
          assert.match(problem.traceId, /^[a-f0-9]{32}$/);
          assert.deepEqual(
            problem.errors.map((error) => error.pointer).sort(),
            [...example.pointers!].sort(),
          );
        } else {
          const input = example.body as Record<string, unknown>;
          assert.deepEqual(
            request,
            example.sentiment
              ? { ...input, sentiment: example.sentiment }
              : input.sentiment
                ? { ...input, sentiment: { onUnsupportedLanguage: "fallback", ...input.sentiment } }
                : input,
          );
          assert.ok(responseCheck(response.json()), JSON.stringify(responseCheck.errors));
        }
      });
    }
  });
}

test("response contract rejects a missing required field on the wire", async (t) => {
  const result: Record<string, unknown> = structuredClone(responseExample);
  const app = await server({ candidate: "loader", result: () => result });
  t.after(() => app.close());
  const request = { method: "POST" as const, url: analysisPath, payload: cases[0].body as object };
  const valid = await app.inject(request);
  assert.equal(valid.statusCode, 200);
  assert.ok(responseCheck(valid.json()), JSON.stringify(responseCheck.errors));
  delete result.usage;
  const missing = await app.inject(request);
  assert.equal(missing.statusCode, 200);
  assert.equal(responseCheck(missing.json()), false);
  assert.ok(
    responseCheck.errors?.some(
      ({ keyword, params }) => keyword === "required" && params.missingProperty === "usage",
    ),
  );
});

test("serializer comparison on the answer-analysis response", async (t) => {
  const payload = cases[0].body as object;
  const valid = await server({ candidate: "glue", serialize: "fast-json-stringify" });
  t.after(() => valid.close());
  const inject = (app: typeof valid) => app.inject({ method: "POST", url: analysisPath, payload });
  const serialized = await inject(valid);
  assert.equal(serialized.statusCode, 200, serialized.body);
  assert.ok(responseCheck(serialized.json()), JSON.stringify(responseCheck.errors));
  const result = () => ({
    ...responseExample,
    mentions: responseExample.mentions.map((mention) => ({ ...mention, position: "1" })),
    extra: "allowed by the response schema",
  });
  const fjs = await server({ candidate: "glue", serialize: "fast-json-stringify", result });
  t.after(() => fjs.close());
  const json = await server({ candidate: "loader", result });
  t.after(() => json.close());
  const fjsResponse = await inject(fjs);
  const jsonResponse = await inject(json);
  assert.deepEqual(jsonResponse.json(), result());
  assert.equal(responseCheck(jsonResponse.json()), false);
  assert.equal(fjsResponse.statusCode, 200);
  assert.deepEqual(fjsResponse.json(), responseExample);
  assert.ok(responseCheck(fjsResponse.json()), JSON.stringify(responseCheck.errors));
  t.diagnostic(
    "fast-json-stringify dropped the extra field and coerced the invalid position string",
  );
});

test("strict compilation accepts registered annotations and rejects unknown keywords", () => {
  const compile = validator(loadSpec(), true);
  const annotated = compile({ type: "string", example: "acme", "x-rex-limits": { llm: "none" } });
  assert.equal(annotated("acme"), true);
  assert.throws(() => compile({ type: "string", misspelledKeyword: true }), /unknown keyword/);
});
