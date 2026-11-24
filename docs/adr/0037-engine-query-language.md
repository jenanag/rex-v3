# 0037: Use TypeScript for engine-query

- **Status:** Accepted (2026-11-24, accepted by Jay)
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual
- **Tool:** `engine-query`
- **Language:** `ts`

## Context

`engine-query` is the sixth tool in the [Phase 2 roadmap](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation).
Jay chose TypeScript in [ADR 0024](0024-per-tool-language.md). The
[OpenAPI contract](../../packages/contracts/openapi/services/engine-query.yaml)
defines `queryEngine` as one prompt to one engine per call. The tool uses the
engine's approved SDK, and workers handle fan-out across engines. The approved
Node.js SDKs fit that call model and the existing TypeScript LLM adapter.

## Decision

Use TypeScript and the existing TypeScript LLM template in `services/_template`.
Jay’s acceptance satisfies the language gate. Scaffold with
`scripts/new-tool engine-query --lang ts --llm`.
Provider and model selection, pricing, and implementation details are separate
decisions.

## Consequences

Keep `language: ts` in the [vendoring manifest](../../packages/contracts/vendoring.yaml).
The template validates requests with Fastify from the vendored OpenAPI contract
and provides tests against that contract. Its standalone Docker build uses only
the tool folder as its build context. The LLM adapter replays recorded fixtures
in `LLM_MODE=mock` without credentials or network access, as specified in
[ADR 0018](0018-tool-portability.md).

The per-tool validator CI gate uses **5 ms p99 per MiB of the effective request
body limit** under [ADR 0027](0027-scale-typescript-validation-budget.md).

## Alternatives considered

- **Go.** It can handle concurrent requests, but workers already distribute
  calls across engines. Choosing Go would bring forward its validation spike
  and template for a tool whose SDKs are already available in Node.js.
- **Python.** It could implement the same operation, but this tool has no Python
  library requirement and would need the paused Python bring-up.
