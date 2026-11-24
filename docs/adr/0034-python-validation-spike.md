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

Measure the approved candidate first. The Python gate and the recommendation depend
on the CI measurements. The answer-analysis language requires its own ADR.

## Consequences

The spike runs outside the tool folder. The Python template, contract generator
integration, and permanent tool CI lane remain deferred.

## Alternatives considered

- **Small route loader over jsonschema's Draft 2020-12 validator.** Try this if
  the approved candidate fails correctness or the timing budget.
