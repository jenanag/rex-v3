# 0027: Scale the TypeScript validation budget with the body limit

- **Status:** Accepted (2026-11-23, accepted by Jay)
- **Date:** 2026-11-23
- **Deciders:** Jay Pascual
- **Amends:** [ADR 0026](0026-typescript-validation-budget.md), TypeScript validation budget

## Context

ADR 0026 originally set a 1 ms p99 request-validation budget for every TypeScript tool.
Two PR #3 runs exercised the same 1 MiB HTML request on
`POST /v1/schema-markup`:

| CI run | Validation p99 |
|---|---:|
| [45037956085](https://github.com/jenanag/rex-v3/actions/runs/45037956085) | 0.7381 ms |
| [45043522416](https://github.com/jenanag/rex-v3/actions/runs/45043522416) | 0.9731 ms |

The slower run left 2.69% headroom under the 1 ms budget.

## Decision

Set the TypeScript request-validation budget at **5 ms p99 per MiB of the tool's
effective Fastify request body limit**. Compute the budget in milliseconds as
`5 × effective body limit in bytes / 1,048,576`. The default body limit of
1,048,576 bytes gives a 5 ms budget. Apply this single budget separately to each
representative, intermediate, and exact-limit workload.

Time only the warmed request validator, including default application. Exclude
JSON parsing, startup, handler work, and response serialization. The per-tool
CI gate fails at p99 ≥ the computed budget without retries or a report-only mode.
The separate ADR 0020 spike in `contracts.yml` remains report-only.
[ADR 0020](0020-fastify-openapi-validation.md).

## Consequences

5 ms per MiB is a policy choice. When a tool's body limit is raised, the formula
sets its budget without automatically reopening the budget decision. The
benchmark logs the effective limit and calculated budget, and CI still measures
a valid request at that limit for each input shape.

`schema-generator` keeps the 1 MiB default and the 250,000-character HTML cap
for both operations. Its CI gate uses a 5 ms p99 budget at that limit.
[Schema-generator limits](../services/schema-generator.md#limits).

## Alternatives considered

- **Keep 1 ms p99 for every tool.** The slower PR #3 run passed with 2.69% headroom.
  Each raise in a tool's body limit could require another budget decision.
- **Use a flat 5 ms p99 budget.** It gives the default limit the same headroom
  while allocating the same time to tools with larger or smaller body limits.
