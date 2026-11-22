# 0026: Keep one TypeScript request validation budget

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Proposed amendment to:** [0020](0020-fastify-openapi-validation.md), validation budget only

## Context

[ADR 0024](0024-per-tool-language.md) sets a 1 ms p99 validation overhead budget
for TypeScript tools. [ADR 0020](0020-fastify-openapi-validation.md#validation-budget)
deferred tuning after the Fastify and Ajv2020 spike.

The accepted operationId loader produced the following validation-only p99
measurements on GitHub Actions with Node.js 26.13.1. Each run measured 5,000
representative requests and 1,000 large requests after warmup. The large fixture
contains 200,000 text characters and 50 brands. [Spike harness](../../spikes/openapi-validation/ts/benchmark.ts).

| CI run | Runner CPU | Representative p99 | Large request p99 |
|---|---|---:|---:|
| [45027669319](https://github.com/jenanag/rex-v3/actions/runs/45027669319) | AMD EPYC 7763 | 0.0114 ms | 0.6329 ms |
| [45028189650](https://github.com/jenanag/rex-v3/actions/runs/45028189650) | AMD EPYC 9V74 | 0.0069 ms | 0.5671 ms |

Both sampled sizes met the budget on both CI runners. The local large-request
measurements in ADR 0020 exceeded 1 ms. The evidence covers the two
`answer-analysis` spike workloads. Each tool's contract and configured body limit
determine the additional sizes that need measurement.

## Decision

Keep a single **1 ms p99 request-validation overhead budget for TypeScript tools
at every supported request size**. Measure the warmed validator on CI hardware,
including default application. Exclude JSON parsing, startup, handler work, and
response serialization. Evaluate p99 separately for each workload so smaller
requests cannot mask slower validation at larger sizes.

## Consequences

After acceptance, benchmark each TypeScript tool with representative inputs and
large valid inputs near its effective request limit, including intermediate
sizes where the contract has different input shapes or validation paths. Use the
same 1 ms budget for each workload. An over-budget result calls for investigation
and a repeat measurement before the tool is considered within budget.

ADR 0020 continues to govern the loader, validation semantics, and body-limit
configuration. ADR 0024 continues to govern the Python and Go budgets.

## Alternatives considered

- **Scale the budget with request size.** A sliding budget would make the
  performance target depend on payload size. Both measured workloads fit under
  1 ms on both CI runners.
- **Keep the budget deferred.** More measurements are needed as the tools are
  built. A single target gives those measurements a consistent yardstick.
