# 0034: Evaluate Python request validation against the vendored OpenAPI contract

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual

## Context

[Roadmap §1.3](../roadmap.md#13-spikes-request-validation-from-the-vendored-31-spec)
gives the Python validation spike two days. [ADR 0024](0024-per-tool-language.md)
sets the 5 ms p99 request-validation budget and identifies FastAPI with openapi-core
as the first candidate. The [spike project](../../spikes/openapi-validation/README.md#python-spike)
uses the same answer-analysis bundle, cases, and workloads as [ADR 0020](0020-fastify-openapi-validation.md).

## Decision

The approved candidate passed correctness but missed the 5 ms budget on the
large workload, so the spike also measures the roadmap fallback. The
answer-analysis language requires its own ADR.

[Initial Python spike CI](https://github.com/jenanag/rex-v3/actions/runs/45313516725)
used CPython 3.13.12 on GitHub-hosted Linux x86_64, Ubuntu 26.04 image
`20261116.202.1`, AMD EPYC 7763. It measured the validator in the FastAPI request
path, including default application and excluding JSON parsing, startup,
handler work and response serialization.

| Candidate | Workload | Bytes | Warmup | Samples | p50 (ms) | p99 (ms) | p99 < 5 ms |
|---|---|---:|---:|---:|---:|---:|---|
| openapi-core 0.23.1 | Representative | 1,440 | 500 | 5,000 | 1.3416 | 2.1955 | Pass |
| openapi-core 0.23.1 | Large | 234,874 | 200 | 1,000 | 55.6185 | 83.3687 | Fail |

## Consequences

The spike runs outside the tool folder. The Python template, contract generator
integration, and permanent tool CI lane remain deferred.

## Alternatives considered

- **Small route loader over jsonschema's Draft 2020-12 validator.** Try this if
  the approved candidate fails correctness or the timing budget.
