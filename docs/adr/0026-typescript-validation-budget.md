# 0026: Keep one TypeScript request validation budget

- **Status:** Proposed
- **Date:** 2026-11-22
- **Deciders:** Jay Pascual
- **Amends:** [0020](0020-fastify-openapi-validation.md#validation-budget) (validation
  budget section) and [0024](0024-per-tool-language.md) (TypeScript budget scope).
  Each gets a dated `Amended by` line at acceptance.

## Context

[ADR 0024](0024-per-tool-language.md) sets a 1 ms p99 validation overhead budget
for TypeScript tools. [ADR 0020](0020-fastify-openapi-validation.md#validation-budget)
deferred tuning after the Fastify and Ajv2020 spike.

GitHub Actions measured validation-only p99 for the accepted operationId loader
and `fastify-openapi-glue` 4.12.0 on Linux x64 with Node.js 26.13.1. Each run measured
5,000 representative requests and 1,000 large requests after warmup. The large
fixture is 234,874 bytes and contains 200,000 text characters and 50 brands.
[Spike harness](../../spikes/openapi-validation/ts/benchmark.ts).

| CI run | Runner CPU | Candidate | Representative p99 | Large request p99 |
|---|---|---|---:|---:|
| [45027669319](https://github.com/jenanag/rex-v3/actions/runs/45027669319) | AMD EPYC 7763 | OperationId loader | 0.0114 ms | 0.6329 ms |
| [45027669319](https://github.com/jenanag/rex-v3/actions/runs/45027669319) | AMD EPYC 7763 | `fastify-openapi-glue` | 0.0143 ms | 0.7924 ms |
| [45028189650](https://github.com/jenanag/rex-v3/actions/runs/45028189650) | AMD EPYC 9V74 | OperationId loader | 0.0069 ms | 0.5671 ms |
| [45028189650](https://github.com/jenanag/rex-v3/actions/runs/45028189650) | AMD EPYC 9V74 | `fastify-openapi-glue` | 0.0076 ms | 0.8238 ms |

Both sampled sizes met the budget on both CI runners. The local large-request
measurements in ADR 0020 exceeded 1 ms. The evidence covers the two
`answer-analysis` spike workloads. Each tool's contract and configured body limit
determine the additional sizes that need measurement.

## Decision

Keep a single 1 ms p99 request-validation overhead budget for TypeScript tools for
every valid request body up to the tool's configured body limit (`BODY_LIMIT_BYTES`,
default 1 MiB per ADR 0020). Evidence so far covers bodies up to 234,874 bytes.
A tool's step is not done until CI shows the budget with a valid body at its
configured limit.

### Enforcement

Each TypeScript tool's step adds a per-tool benchmark to CI that runs without
`--report-only` and fails the build at p99 ≥ 1 ms. Until then the spike benchmark
in `contracts.yml` stays report-only. If a tool cannot meet the budget, Jay lowers
that tool's body limit or decides a different budget in a new ADR.

Measure the warmed validator on CI hardware, including default application.
Exclude JSON parsing, startup, handler work, and response serialization. Evaluate
p99 separately for each workload so smaller requests cannot mask slower
validation at larger sizes.

## Consequences

After acceptance, benchmark each TypeScript tool with representative inputs, a
valid body at its configured limit, and intermediate sizes where the contract has
different input shapes or validation paths.

Where a contract's maxLength allows bodies above the tool's body limit, the tool's
ADR sets `BODY_LIMIT_BYTES` or Jay narrows the contract. For example,
`schema-generator` allows up to 2,000,000 characters in `html`.
[Schema-generator contract](../../packages/contracts/openapi/services/schema-generator.yaml).

ADR 0020 continues to govern the loader, validation semantics, and body-limit
configuration. ADR 0024 continues to govern the Python and Go budgets.

## Alternatives considered

- **Scale the budget with request size.** A sliding budget would make the
  performance target depend on payload size. Both measured workloads fit under
  1 ms on both CI runners.
- **Keep the budget deferred.** More measurements are needed as the tools are
  built. A single target gives those measurements a consistent yardstick.
