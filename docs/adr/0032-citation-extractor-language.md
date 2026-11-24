# 0032: Use TypeScript for citation-extractor

- **Status:** Accepted (2026-11-24, accepted by Jay)
- **Date:** 2026-11-24
- **Deciders:** Jay Pascual
- **Tool:** `citation-extractor`
- **Language:** `ts`

## Context

`citation-extractor` is the fourth tool in the
[Phase 2 roadmap](../roadmap.md#phase-2-tool-services-one-at-a-time-each-built-and-tested-in-isolation).
Its [OpenAPI contract](../../packages/contracts/openapi/services/citation-extractor.yaml)
defines `extractCitations` over caller-supplied engine sources, answer Markdown, and
tracked brand domains. The operation extracts inline links, normalizes citation URLs,
deduplicates by URL with engine sources first, and classifies ownership using the
supplied domains. It runs offline without an LLM.

[ADR 0024](0024-per-tool-language.md) proposes TypeScript for this tool. The approved
`marked` lexer provides Markdown link tokens, and TypeScript with Node's URL API
fits the normalization, deduplication, and domain comparisons. The existing template
provides Fastify request validation from the vendored OpenAPI spec, contract tests,
and a standalone Docker build. [Approved tool dependencies](../conventions.md#approved-tool-dependencies).

## Decision

Use TypeScript and the existing `services/_template`.

1. Jay accepts this ADR before scaffolding, as required by ADR 0024.
2. Scaffold with `scripts/new-tool citation-extractor --lang ts`.
3. Implement `extractCitations`, using `marked` to read inline links and applying
   citation normalization, deduplication, and ownership classification to the
   supplied inputs.

## Consequences

Keep `language: ts` in the vendoring manifest. Use offline fixtures to test
Markdown links, engine-source precedence, and domain ownership. Reuse the template's
vendored response checks and standalone portability job. The TypeScript
request-validation gate follows [ADR 0027](0027-scale-typescript-validation-budget.md).

## Alternatives considered

- **Python.** It can parse Markdown and compare URLs. It would need the Python
  validation spike and template for work covered by the approved TypeScript stack.
- **Go.** It can process the same inputs offline. It would need the Go validation
  spike and template for a single operation that fits the existing toolchain.
