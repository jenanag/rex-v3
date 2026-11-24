# 0035: Use TypeScript for answer-analysis

- **Status:** Proposed
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual
- **Tool:** `answer-analysis`
- **Language:** `ts`

## Context

`answer-analysis` is step 5 in the [Phase 2 roadmap](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation).
[ADR 0024](0024-per-tool-language.md) proposed Python for this tool because of its
NLP and multilingual sentiment libraries. It provides for TypeScript when both
Python validation candidates fail. The [accepted spike record](0034-python-validation-spike.md)
shows that openapi-core and the Draft 2020-12 route loader passed correctness but
exceeded the **5 ms p99** budget on the large workload. The corroborating CI run
measured **40.6082 ms** and **39.3610 ms** p99, respectively.

## Decision

Use TypeScript and the existing `services/_template` for `answer-analysis`.
The template provides Fastify validation against the vendored OpenAPI spec,
contract tests, a standalone Docker build, and the LLM adapter for later work.
Keep the Python bring-up paused.

1. Wait for Jay to accept this ADR before scaffolding with
   `scripts/new-tool answer-analysis --lang ts --llm`.
2. Implement deterministic mention detection and the English `det:lexicon` and
   `det:rules` analyzers first. Include the lexicon registry, English pack,
   language detection, and `onUnsupportedLanguage` handling.
3. Add LLM analyzers per provider through the tool's adapter, then produce the
   side-by-side comparison report on a fixture set.

The sequence follows [ADR 0017](0017-deterministic-first-analysis.md) and the roadmap.
Mention detection, positions, and occurrence counts remain deterministic.

## Consequences

Keep `language: ts` in the [vendoring manifest](../../packages/contracts/vendoring.yaml)
and validate against the existing [OpenAPI contract](../../packages/contracts/openapi/services/answer-analysis.yaml).
The TypeScript validator will have to pass the per-tool CI gate of **5 ms p99 per
MiB of the effective request body limit**, under [ADR 0027](0027-scale-typescript-validation-budget.md).
This language decision applies to `answer-analysis`.

## Alternatives considered

- **Bring up Python for this tool.** Its NLP ecosystem would help with later
  multilingual work. Both tested validators missed the large-request gate.
