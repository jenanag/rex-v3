# 0034: Evaluate Python request validation against the vendored OpenAPI contract

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual

## Context

[Roadmap §1.3](../roadmap.md#13-spikes-request-validation-from-the-vendored-31-spec)
time-boxes the Python validation spike to two days. [ADR 0024](0024-per-tool-language.md)
sets the 5 ms p99 request-validation budget and identifies FastAPI with openapi-core
as the first candidate. The [spike project](../../spikes/openapi-validation/README.md#python-spike)
uses the same vendored answer-analysis bundle, request cases, and workloads as
[ADR 0020](0020-fastify-openapi-validation.md).

## Decision

Record a failed Python validation gate. Both candidates passed correctness and the
representative timing workload. Both exceeded 5 ms p99 on the large workload.
Recommend leaving the Python bring-up paused and deciding whether to use TypeScript
for answer-analysis in its separate language ADR, as described in ADR 0024.

## Consequences

### Correctness and adapter work

Both candidates passed the same 25 requests through FastAPI, including the
supplemental nullable types, `oneOf`, `propertyNames`, and lookahead pattern.
Invalid bodies returned the shared HTTP 400 `validation_failed` Problem with the
expected RFC 6901 pointers. Wrong JSON types and unknown fields were rejected.
The handler saw the spec defaults, with an explicitly empty analyzer list preserved.
In both runs, response validation accepted the valid fixture and rejected it after
the required `usage` field was removed.

- **FastAPI with openapi-core.** Middleware runs `V31RequestValidator` against
  the bundle. The JSON media-type adapter gives the validator the already parsed
  body, so the route does not parse it twice or pass it through Pydantic.
  The default install did not enforce `hostname`. The spike pins the optional
  format dependencies that enable hostname and URI checks. The response validator
  also needs a JSON decoder for `application/problem+json`.
- **Shared adapter.** Defaults are compiled from the bundle's object properties,
  references and `allOf` and applied to absent members of existing objects before
  validation. Error mapping escapes pointer tokens and locates missing members and
  invalid property names. For `unevaluatedProperties` around a failing `allOf`,
  it reports undeclared keys and keeps the specific errors from the failed branches.
  The generated Pydantic v2 model is a type artifact. The HTTP path validates the
  JSON mapping from the spec and never imports the model.

### CI timing

The [side-by-side CI run](https://github.com/jenanag/rex-v3/actions/runs/45313892801)
used CPython 3.13.12, uv 0.13.9, FastAPI 0.165.0, openapi-core 0.23.1 and
jsonschema 4.26.0 on GitHub-hosted Linux x86_64 (Ubuntu 26 image
`20261116.202.1`, Intel Xeon 6973P-C). The warmed validator ran inside the
FastAPI request path. Timing included default application and excluded JSON parsing,
startup, handler work, and serialization. The large workload has 200,000 text
characters and 50 brands, each with 20 aliases and 20 domains.

| Candidate | Workload | Serialized bytes | Warmup | Samples | p50 (ms) | p99 (ms) | p99 < 5 ms |
|---|---|---:|---:|---:|---:|---:|---|
| openapi-core | Representative | 1,440 | 500 | 5,000 | 0.8861 | 1.1500 | Pass |
| openapi-core | Large | 234,874 | 200 | 1,000 | 37.7401 | 44.6675 | Fail |
| Draft 2020-12 route loader | Representative | 1,440 | 500 | 5,000 | 0.5143 | 0.5603 | Pass |
| Draft 2020-12 route loader | Large | 234,874 | 200 | 1,000 | 36.6706 | 38.5223 | Fail |

The [initial openapi-core CI run](https://github.com/jenanag/rex-v3/actions/runs/45313516725)
on the same image and runtime with an AMD EPYC 7763 measured 1.3416 ms p50 and
2.1955 ms p99 for the representative body, and 55.6185 ms p50 and 83.3687 ms p99
for the large body. The large body missed the budget on both runners.

The spike fits within its two-day time box. The Python template, generator
integration and permanent tool CI lane remain deferred.

## Alternatives considered

- **Adopt FastAPI with openapi-core now.** Its request validator handles OpenAPI
  operation lookup and validation, but its large-workload p99 missed the budget.
- **Adopt the small Draft 2020-12 route loader.** It retains the bundle's reference
  root, applies the same defaults, and validates the same JSON body from the spec.
  Skipping the OpenAPI request wrapper improved both workloads in the paired CI run,
  but large-workload p99 still missed the budget. Its coverage is limited to the
  tested body-only operation.
